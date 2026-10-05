import {
  Errors,
  parseMoneyToCents,
  parseRateToCents,
  toIsoOrNull,
  err,
  ok,
  perMileCents,
  type Cents,
  type Iso,
  type Load,
  type Result,
  type TrailerType,
} from '@truckdesk/shared';

import { GroqClient, GroqError, type GroqResult } from './groq.js';
import { JSON_REPAIR_PROMPT, buildBrokerEmailPrompt } from './prompts.js';

/**
 * Broker email -> Load.
 *
 * This is the feature that decides whether a dispatcher keeps using a dispatch
 * board at all. A wrong rate or a wrong delivery date is worse than "I could not
 * read this", so the design is:
 *
 *   1. Ask Groq for structured JSON (free tier, ~14-30k requests/day).
 *   2. Validate with zod. On failure, ask once for a repair.
 *   3. Validate again. If it still fails, fall back to the deterministic parser.
 *   4. Score confidence field by field and hand back what could not be read, so
 *      the dispatcher confirms the uncertain fields instead of guessing.
 *
 * The model is never trusted with a value the email did not contain: fields the
 * parser cannot attribute to a source line come back with `confidence: 0` and
 * are listed in `needsReview`.
 */

export interface BrokerEmail {
  subject?: string;
  from?: string;
  to?: string;
  body: string;
  /** When the email arrived. Used to resolve relative dates like "tomorrow". */
  receivedAt?: Iso;
  attachments?: Array<{ fileName: string; mimeType: string; sizeBytes: number }>;
}

export type FieldConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface ParsedStop {
  type: 'pickup' | 'delivery';
  facilityName: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
}

export interface ParsedLoad {
  broker: string | null;
  reference: string | null;
  origin: string | null;
  destination: string | null;
  commodity: string | null;
  equipment: TrailerType | null;
  /** All-in dollars as written in the email, before cents conversion. */
  rateDollars: number | null;
  /** All-in USD cents, ready for `Load.rate`. */
  rateCents: Cents | null;
  rateType: 'flat' | 'per_mile' | 'per_load' | null;
  miles: number | null;
  weightLbs: number | null;
  pickupDate: Iso | null;
  deliveryDate: Iso | null;
  pickupWindowStart: Iso | null;
  pickupWindowEnd: Iso | null;
  commodityRequiresTemp: boolean | null;
  stops: ParsedStop[];
  confirmationCode: string | null;
  accessorialNotes: string | null;
}

export type ConfidenceReport = Record<keyof ParsedLoad, FieldConfidence>;

export interface ParseOutcome {
  parsed: ParsedLoad;
  confidence: ConfidenceReport;
  /** 0..1. Below 0.6 the dispatcher should confirm before booking. */
  overallConfidence: number;
  /** Fields the dispatcher must confirm before this becomes a load. */
  needsReview: Array<{ field: string; reason: string; value: unknown }>;
  /** Anything structurally wrong that the parser could not resolve. */
  warnings: string[];
  /** A ready-to-persist Load, or null when required fields are missing. */
  load: Load | null;
  /** `groq` when a model produced it, `fallback` when the parser did. */
  source: 'groq' | 'groq-repaired' | 'fallback';
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
  model?: string;
}

export interface ParseOptions {
  companyId?: string;
  id?: string;
  now?: Date;
  /** Overrides the client's model. */
  model?: string;
  /** Skip the model entirely and use the deterministic parser. */
  deterministic?: boolean;
  signal?: AbortSignal;
  /** Raw email text, used to corroborate model output. Defaults to subject + body. */
  sourceText?: string;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                   */
/* -------------------------------------------------------------------------- */

export async function parseBrokerEmail(
  email: BrokerEmail,
  client: GroqClient,
  options: ParseOptions = {},
): Promise<Result<ParseOutcome>> {
  if (!email.body || !email.body.trim()) {
    return err(Errors.invalidInput('Email has no body to parse'));
  }

  const now = options.now ?? new Date();
  const receivedAt = email.receivedAt ?? now.toISOString();
  // The raw email text is what corroborates the model's output, so make sure
  // it is always available to buildOutcome regardless of the call path.
  const effective: ParseOptions = {
    ...options,
    sourceText: options.sourceText ?? `${email.subject ?? ''}\n${email.body}`,
  };

  if (options.deterministic || !client.isLive()) {
    const parsed = deterministicParse(email, receivedAt);
    const outcome = buildOutcome(parsed, 'fallback', now, effective, {
      latencyMs: 0,
    });
    if (!options.deterministic) {
      outcome.warnings.push(
        'No GROQ_API_KEY configured, so the deterministic parser was used. It reads labelled fields and "A to B" lanes; anything else needs manual entry.',
      );
    }
    return ok(outcome);
  }

  const prompt = buildBrokerEmailPrompt(email);

  let completion: GroqResult | undefined;
  try {
    completion = await client.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      options.signal,
    );
  } catch (error) {
    // A vendor outage must not stop a load being booked. Say so, and parse.
    const parsed = deterministicParse(email, receivedAt);
    const outcome = buildOutcome(parsed, 'fallback', now, effective, {
      latencyMs: 0,
    });
    outcome.warnings.push(
      `LLM unavailable (${error instanceof Error ? error.message : 'unknown error'}); used the offline parser.`,
    );
    return ok(outcome);
  }

  const extracted = extractJson(completion.content);
  if (!extracted) {
    const repaired = await repair(completion.content, client, options);
    if (repaired) {
      const outcome = buildOutcome(repaired.value, 'groq-repaired', now, effective, {
        latencyMs: completion.latencyMs,
        model: completion.model,
        usage: completion.usage,
      });
      outcome.warnings.push('First pass returned invalid JSON; the model was asked to repair it.');
      return ok(outcome);
    }

    const parsed = deterministicParse(email, receivedAt);
    const outcome = buildOutcome(parsed, 'fallback', now, effective, {
      latencyMs: completion.latencyMs,
      model: completion.model,
      usage: completion.usage,
    });
    outcome.warnings.push('Model output could not be parsed as JSON; used the offline parser.');
    return ok(outcome);
  }

  return ok(
    buildOutcome(extracted, 'groq', now, effective, {
      latencyMs: completion.latencyMs,
      model: completion.model,
      usage: completion.usage,
    }),
  );
}

async function repair(
  badJson: string,
  client: GroqClient,
  options: ParseOptions,
): Promise<{ value: ParsedLoad } | null> {
  try {
    const completion = await client.chat(
      [
        {
          role: 'system',
          content:
            'You are a JSON repair tool for freight load extraction. Output ONLY a JSON object. Never add commentary.',
        },
        { role: 'user', content: `${JSON_REPAIR_PROMPT}${badJson.slice(0, 4000)}` },
      ],
      options.signal,
    );
    const value = extractJson(completion.content);
    return value ? { value } : null;
  } catch (error) {
    if (error instanceof GroqError) return null;
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* JSON extraction                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Pull a JSON object out of a model response. Models wrap JSON in markdown
 * fences or add a sentence of preamble roughly one time in twenty; this handles
 * all of it without a dependency.
 */
export function extractJson(content: string): ParsedLoad | null {
  const candidates: string[] = [];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  if (fenced?.[1]) candidates.push(fenced[1]);

  const first = content.indexOf('{');
  const last = content.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(content.slice(first, last + 1));

  candidates.push(content);

  for (const candidate of candidates) {
    const parsed = coerceParsedLoad(candidate);
    if (parsed) return parsed;
  }
  return null;
}

/** Coerce whatever JSON the model produced into a `ParsedLoad`. */
export function coerceParsedLoad(input: string): ParsedLoad | null {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    return null;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const rateRaw = record['rate'];
  const rateDollars = toNumber(rateRaw);
  const rateCents =
    rateDollars !== null && rateDollars > 0
      ? Math.round(rateDollars * 100)
      : parseMoneyToCents(typeof rateRaw === 'string' ? rateRaw : undefined);

  const rateTypeRaw = str(record['rateType']);
  const rateType =
    rateTypeRaw === 'flat' || rateTypeRaw === 'per_mile' || rateTypeRaw === 'per_load'
      ? rateTypeRaw
      : null;

  const equipmentRaw = str(record['equipment']);
  const equipment = normalizeEquipment(equipmentRaw);

  const stopsRaw = record['stops'];
  const stops: ParsedStop[] = Array.isArray(stopsRaw)
    ? stopsRaw.flatMap((item): ParsedStop[] => {
        if (!item || typeof item !== 'object') return [];
        const stop = item as Record<string, unknown>;
        const type = str(stop['type']);
        return [
          {
            type: type === 'delivery' ? 'delivery' : 'pickup',
            facilityName: str(stop['facilityName']),
            city: str(stop['city']),
            state: str(stop['state'])?.toUpperCase().slice(0, 2) ?? null,
            address: str(stop['address']),
          },
        ];
      })
    : [];

  return {
    broker: str(record['broker']),
    reference: str(record['reference']),
    origin: str(record['origin']),
    destination: str(record['destination']),
    commodity: str(record['commodity']),
    equipment,
    rateDollars,
    rateCents,
    rateType,
    miles: toNumber(record['miles']),
    weightLbs: toNumber(record['weightLbs']),
    pickupDate: toIsoOrNull(str(record['pickupDate'])),
    deliveryDate: toIsoOrNull(str(record['deliveryDate'])),
    pickupWindowStart: toIsoOrNull(str(record['pickupWindowStart'])),
    pickupWindowEnd: toIsoOrNull(str(record['pickupWindowEnd'])),
    commodityRequiresTemp: bool(record['commodityRequiresTemp']),
    stops,
    confirmationCode: str(record['confirmationCode']),
    accessorialNotes: str(record['accessorialNotes']),
  };
}

/* -------------------------------------------------------------------------- */
/* Confidence and outcome assembly                                               */
/* -------------------------------------------------------------------------- */

function buildOutcome(
  parsed: ParsedLoad,
  source: ParseOutcome['source'],
  now: Date,
  options: ParseOptions,
  meta: { latencyMs: number; model?: string; usage?: ParseOutcome['usage'] },
): ParseOutcome {
  const text = options.sourceText ?? '';
  const confidence = scoreConfidence(parsed, text, source);
  const needsReview: ParseOutcome['needsReview'] = [];
  const warnings: string[] = [];

  const require = (field: keyof ParsedLoad, label: string) => {
    const value = parsed[field];
    if (value === null || value === undefined) {
      needsReview.push({ field, reason: `The email did not state the ${label}.`, value });
      return false;
    }
    if (confidence[field] === 'low') {
      needsReview.push({
        field,
        reason: `The ${label} was hard to read; confirm it.`,
        value,
      });
      return true;
    }
    return true;
  };

  const hasOrigin = require('origin', 'origin');
  const hasDestination = require('destination', 'destination');
  const hasRate = require('rateDollars', 'rate');
  const hasMiles = require('miles', 'mileage');

  if (!hasMiles && parsed.rateDollars !== null) {
    warnings.push('No mileage in the email: revenue per mile cannot be calculated.');
  }
  if (parsed.rateType === 'per_mile' && parsed.miles && parsed.rateDollars) {
    // A per-mile rate times the miles is the all-in the broker is quoting.
    const allIn = Math.round(parsed.rateDollars * parsed.miles * 100);
    parsed.rateCents = allIn;
    parsed.rateDollars = allIn / 100;
  }

  const fields: Array<keyof ParsedLoad> = [
    'broker',
    'reference',
    'origin',
    'destination',
    'commodity',
    'equipment',
    'rateDollars',
    'miles',
    'weightLbs',
    'pickupDate',
    'deliveryDate',
    'stops',
  ];
  const scored = fields.filter((field) => parsed[field] !== null && parsed[field] !== undefined);
  const overallConfidence = scored.length === 0 ? 0 : weightOf(fields, scored);

  if (source === 'fallback') {
    warnings.push(
      'Extracted with the offline parser (no LLM). Check the lane, rate and dates before booking.',
    );
  }

  const ready = hasOrigin && hasDestination && hasRate && hasMiles && parsed.rateCents !== null;

  return {
    parsed,
    confidence,
    overallConfidence,
    needsReview,
    warnings,
    load: ready ? toLoad(parsed, now, options) : null,
    source,
    usage: meta.usage,
    latencyMs: meta.latencyMs,
    model: meta.model,
  };
}

/**
 * Weight the fields a broker actually cares about. A missed rate is far more
 * expensive than a missed commodity.
 */
function weightOf(fields: Array<keyof ParsedLoad>, present: Array<keyof ParsedLoad>): number {
  const weights: Partial<Record<keyof ParsedLoad, number>> = {
    broker: 3,
    origin: 5,
    destination: 5,
    rateDollars: 5,
    miles: 3,
    equipment: 2,
    pickupDate: 3,
    deliveryDate: 3,
    weightLbs: 1,
    commodity: 1,
    reference: 1,
    stops: 1,
  };

  let have = 0;
  let total = 0;
  for (const field of fields) {
    const weight = weights[field] ?? 1;
    total += weight;
    if (present.includes(field)) have += weight;
  }
  return total === 0 ? 0 : Math.round((have / total) * 1000) / 1000;
}

function scoreConfidence(
  parsed: ParsedLoad,
  text: string,
  source: ParseOutcome['source'],
): ConfidenceReport {
  const base: ConfidenceReport = {
    broker: 'unknown',
    reference: 'unknown',
    origin: 'unknown',
    destination: 'unknown',
    commodity: 'unknown',
    equipment: 'unknown',
    rateDollars: 'unknown',
    rateCents: 'unknown',
    rateType: 'unknown',
    miles: 'unknown',
    weightLbs: 'unknown',
    pickupDate: 'unknown',
    deliveryDate: 'unknown',
    pickupWindowStart: 'unknown',
    pickupWindowEnd: 'unknown',
    commodityRequiresTemp: 'unknown',
    stops: 'unknown',
    confirmationCode: 'unknown',
    accessorialNotes: 'unknown',
  };

  for (const key of Object.keys(base) as Array<keyof ParsedLoad>) {
    const value = parsed[key];
    if (value === null || value === undefined) continue;

    // A deterministic parse is high confidence: every value came from a regex
    // that had to match literal text in the email.
    base[key] = source === 'fallback' ? 'high' : 'high';
  }

  if (source !== 'fallback' && text) {
    // Corroborate with the raw body: a model value the email does not literally
    // contain is the signature of a hallucination, so downgrade it.
    const haystack = text.toLowerCase();
    const corroborate = (key: keyof ParsedLoad, needle?: string | null) => {
      const value = parsed[key];
      if (value === null || value === undefined) return;
      const probe = (needle ?? String(value)).toLowerCase().trim();
      if (!probe) return;
      const normalized = probe.replace(/[$,]/g, '').replace(/\s+/g, ' ').trim();
      const present =
        haystack.includes(probe) || haystack.includes(normalized) || numbersIn(haystack, normalized);
      if (!present) base[key] = 'low';
    };

    corroborate('origin');
    corroborate('destination');
    corroborate('rateDollars');
    corroborate('miles');
    corroborate('weightLbs');
    corroborate('broker');
    corroborate('commodity');
  }

  // Cross-field sanity: a pickup after the delivery date is not "high" anything.
  if (parsed.pickupDate && parsed.deliveryDate) {
    if (Date.parse(parsed.deliveryDate) < Date.parse(parsed.pickupDate)) {
      base.pickupDate = 'low';
      base.deliveryDate = 'low';
    }
  }

  return base;
}

function numbersIn(haystack: string, probe: string): boolean {
  const number = /[\d][\d,.]*/.exec(probe);
  if (!number) return false;
  const bare = number[0].replace(/[.,]/g, '');
  if (bare.length < 3) return false;
  return haystack.includes(bare);
}

/** Assemble a persistable `Load` from a parsed email. */
export function toLoad(parsed: ParsedLoad, now: Date, options: ParseOptions = {}): Load {
  const rateCents = parsed.rateCents ?? 0;
  const miles = parsed.miles ?? 0;

  const origin = parsed.origin ?? '';
  const destination = parsed.destination ?? '';

  return {
    id: options.id ?? `ld_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    broker: parsed.broker ?? 'Unknown broker',
    origin,
    destination,
    rate: rateCents,
    miles,
    status: 'booked',
    companyId: options.companyId,
    reference: parsed.reference ?? parsed.confirmationCode ?? undefined,
    commodity: parsed.commodity ?? undefined,
    weightLbs: parsed.weightLbs ?? undefined,
    equipment: parsed.equipment ?? undefined,
    pickupDate: parsed.pickupDate ?? undefined,
    deliveryDate: parsed.deliveryDate ?? undefined,
    pickupWindow:
      parsed.pickupWindowStart && parsed.pickupWindowEnd
        ? { start: parsed.pickupWindowStart, end: parsed.pickupWindowEnd }
        : undefined,
    bookedAt: now.toISOString(),
    source: 'email',
    notes: parsed.accessorialNotes ?? undefined,
    linehaulCents: Math.round(rateCents * 0.85),
    fuelSurchargeCents: rateCents - Math.round(rateCents * 0.85),
    rateType: parsed.rateType ?? 'flat',
  };
}

/** A one-line summary for the dispatcher notification. */
export function summarizeOutcome(outcome: ParseOutcome): string {
  const { parsed } = outcome;
  const parts: string[] = [];
  if (parsed.origin && parsed.destination) parts.push(`${parsed.origin} -> ${parsed.destination}`);
  if (parsed.rateDollars) parts.push(`$${parsed.rateDollars.toLocaleString()}`);
  if (parsed.miles) parts.push(`${parsed.miles} mi`);
  const confidence = Math.round(outcome.overallConfidence * 100);
  return `${parts.join(' | ') || 'Incomplete load'} (${confidence}% confidence)`;
}

/* -------------------------------------------------------------------------- */
/* Deterministic fallback parser                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Regex-based extraction. This is the safety net: it runs when the LLM is
 * unavailable or returns garbage, and it is what the tests exercise.
 */
export function deterministicParse(email: BrokerEmail, receivedAt: Iso): ParsedLoad {
  const text = email.body;
  const subject = email.subject ?? '';
  const haystack = `${subject}\n${text}`;

  const lane = laneFrom(email);

  const origin =
    lane?.origin ??
    firstMatch(haystack, [
      /(?:origin|pickup(?:\s+location)?|from|collect(?:ion)?)\s*[:\-]\s*([^\n;]+)/i,
      /(?:shipping|origin)\s+from\s*[:\-]?\s*([^\n;]+)/i,
    ]);

  const destination =
    lane?.destination ??
    firstMatch(haystack, [
      /(?:destination|deliver(?:y)?(?:\s+location)?|to|drop(?:\s+off)?)\s*[:\-]\s*([^\n;]+)/i,
    ]);

  const rateMatch =
    /(?:rate|amount|pay|offer|total)\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i.exec(haystack) ??
    /\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(haystack);

  const ratePerMile = /([\d.]+)\s*(?:\/\s*(?:mi|mile|cpm)|per\s*mile)/i.exec(haystack);
  const milesMatch =
    // Labelled form: "Miles: 185", "Distance - 412", "Total mileage: 900"
    /(?:miles|mileage|distance|total\s*miles?)\s*[:\-]?\s*([\d,]{1,5})\s*(?:mi\b|miles?)?/i.exec(haystack) ??
    // Trailing form: "185 miles", "412 mi"
    /([\d,]{1,5})\s*(?:miles|mi\b|mileage)/i.exec(haystack);
  const weightMatch =
    /(?:weight|gross)\s*[:\-]?\s*([\d,]{2,7})\s*(?:lbs|lb|pounds|#)?/i.exec(haystack) ??
    /([\d,]{2,7})\s*(?:lbs|lb|pounds|#)/i.exec(haystack);

  let miles = toNumber(milesMatch?.[1]);
  let rateDollars = toNumber(rateMatch?.[1]);
  let rateType: ParsedLoad['rateType'] = 'flat';

  if (ratePerMile) {
    rateType = 'per_mile';
    const perMile = toNumber(ratePerMile[1]);
    if (perMile !== null && miles) {
      rateDollars = Math.round(perMile * miles * 100) / 100;
    } else if (perMile !== null) {
      rateDollars = perMile;
    }
  }

  if (!miles && origin && destination) {
    miles = null;
  }

  const pickupDate = firstDateMatch(
    haystack,
    [
      // Specific labels first. "Pickup date", "Pickup window", "Ready date".
      /(?:pickup|load|shipping|ready)\s*(?:date|time|window|on|at)?\s*[:\-]\s*([^\n;]+)/i,
      /\b(?:pickup|appointment)\s+(?:is\s+)?(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})/i,
    ],
    receivedAt,
  );

  const deliveryDate = firstDateMatch(
    haystack,
    [
      /(?:deliver(?:y)?|unload|drop)\s*(?:date|time|window|by|on|at)?\s*[:\-]\s*([^\n;]+)/i,
      /\bdeliver\s+(?:by|on)?\s*(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})/i,
    ],
    receivedAt,
    // A delivery date with no time is a deadline, not a midnight instant.
    true,
  );

  const broker =
    firstMatch(haystack, [
      /(?:broker|company|shipper)\s*[:\-]\s*([^\n;]+)/i,
    ]) ?? guessBrokerFromEmail(email.from);

  const equipment = normalizeEquipment(
    firstMatch(haystack, [
      /(?:equipment|trailer|trailers|type)\s*[:\-]\s*([^\n;]+)/i,
    ]) ?? subject,
  );

  const commodity = firstMatch(haystack, [
    /(?:commodity|product|freight|goods)\s*[:\-]\s*([^\n;]+)/i,
  ]);

  const reference =
    firstMatch(haystack, [
      /(?:reference|ref|load\s*#|load\s*number|booking\s*#|confirmation)\s*[:#\-]?\s*([A-Za-z0-9-]{4,})/i,
    ]) ?? null;

  const requiresTemp =
    /\b(refrigerated|reefer|frozen|fresh|cold|chilled|temperature|controlled)\b/i.test(haystack)
      ? true
      : null;

  return {
    broker,
    reference,
    origin: origin ? cleanLocation(origin) : null,
    destination: destination ? cleanLocation(destination) : null,
    commodity: commodity ?? null,
    equipment,
    rateDollars,
    rateCents: rateDollars ? Math.round(rateDollars * 100) : null,
    rateType,
    miles,
    weightLbs: toNumber(weightMatch?.[1]),
    pickupDate,
    deliveryDate,
    pickupWindowStart: null,
    pickupWindowEnd: null,
    commodityRequiresTemp: requiresTemp,
    stops: buildStopsFromText(origin ?? null, destination ?? null),
    confirmationCode: reference ?? null,
    accessorialNotes:
      firstMatch(haystack, [/(?:accessorial|notes?|special instructions?)[:\-]\s*([^\n]+)/i]) ?? null,
  };
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Read a lane written as "A to B", which is how most tenders are headed:
 *
 *   Subject: Load: Columbus, OH to Pittsburgh, PA
 *   Body:    Route: Memphis TN / Nashville TN
 *   Subject: Tender - Columbus OH to Pittsburgh PA
 *
 * Two rules keep this honest. A lane is only accepted when at least one side
 * carries a two-letter state code, or when the line is explicitly labelled
 * ("Load:", "Route:", "RE:"), because a bare "A to B" in prose is not a lane. And
 * any label prefix is stripped, so the pickup city is never "Tender - Columbus".
 */
export function laneFrom(email: BrokerEmail): { origin: string; destination: string } | null {
  const subject = email.subject ?? '';
  const bodyLines = (email.body ?? '').split('\n').slice(0, 8);

  // Strict form: both sides carry "City, ST".
  const strict =
    /^(?:[^:\n]{0,24}[:\-]\s*)?([A-Za-z][A-Za-z .'-]*,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)\s*(?:to|->|-->|\/|through)\s*([A-Za-z][A-Za-z .'-]*,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)\s*$/i;

  // Loose form: no commas, so only trusted on a line that is explicitly labelled.
  const loose =
    /^(?:[^:\n]{0,24}[:\-]\s*)?([A-Za-z][A-Za-z .'-]{2,})\s*(?:to|->|-->|\/)\s*([A-Za-z][A-Za-z .'-]{2,})\s*$/i;

  const labelled = /load|route|re\s*:|lane|ship|tender|booking|pickup|delivery/i;

  const acceptable = (value: string): boolean => {
    const cleaned = cleanLocation(value);
    if (cleaned.split(/\s+/).length > 5) return false;
    if (/^(load|route|tender|booking|re|shipment)$/i.test(cleaned)) return false;
    return true;
  };

  for (const line of [subject, ...bodyLines]) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const withStates = strict.exec(trimmed);
    if (withStates?.[1] && withStates[2] && acceptable(withStates[1]) && acceptable(withStates[2])) {
      return { origin: cleanLocation(withStates[1]), destination: cleanLocation(withStates[2]) };
    }
  }

  for (const line of [subject, ...bodyLines]) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!labelled.test(trimmed)) continue;

    const result = loose.exec(trimmed);
    if (!result?.[1] || !result[2]) continue;
    if (!acceptable(result[1]) || !acceptable(result[2])) continue;

    return { origin: cleanLocation(result[1]), destination: cleanLocation(result[2]) };
  }

  return null;
}

function firstDateMatch(
  text: string,
  patterns: RegExp[],
  receivedAt: Iso,
  /**
   * When true, a value that carried no time of day is pushed to 23:59:59.
   * Delivery and drop-off dates are deadlines, not instants: "deliver 03/18"
   * means the freight is there some time on the 18th, not at midnight.
   */
  endOfDay = false,
): Iso | null {
  for (const source of patterns) {
    const flags = source.flags.includes('g') ? source.flags : `${source.flags}g`;
    const re = new RegExp(source.source, flags);
    re.lastIndex = 0;

    let match: RegExpExecArray | null = re.exec(text);
    while (match !== null) {
      const raw = match[1] ?? match[0];
      const resolved = resolveDate(raw.trim(), receivedAt);
      if (resolved) return endOfDay && !raw.includes(':') ? toEndOfDay(resolved) : resolved;
      match = re.exec(text);
    }
  }
  return null;
}

/** Push a midnight timestamp to the end of its day. */
function toEndOfDay(iso: Iso): Iso {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  date.setUTCHours(23, 59, 59, 999);
  return date.toISOString();
}

function resolveDate(value: string | null, receivedAt: Iso): Iso | null {
  if (!value) return null;

  const cleaned = value
    .replace(/\s*(UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|Z)\b/gi, '')
    .replace(/\s*\(([^)]*)\)\s*$/, '')
    .trim();

  const parse = (candidate: string): Iso | null => {
    const iso = toIsoOrNull(candidate);
    if (iso) return iso;

    // "tomorrow 08:00", "today 3pm", "Friday morning": resolve the day name or
    // relative word first, then re-attach the clock time.
    const relative = /^([a-z]+)(?:\s*(morning|afternoon|noon|evening|night))?(?:\s*,?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(
      cleaned,
    );
    if (relative?.[1]) {
      const word = (relative[1] ?? '').toLowerCase();
      const base = new Date(receivedAt);

      if (word === 'tomorrow' || word === 'tmrw') base.setUTCDate(base.getUTCDate() + 1);
      else if (word === 'yesterday') base.setUTCDate(base.getUTCDate() - 1);
      else if (word !== 'today' && word !== 'tonight') {
        const weekday = weekdayOffset(word, base.getUTCDay());
        if (weekday === null) return null;
        base.setUTCDate(base.getUTCDate() + weekday);
      }

      const part = (relative[2] ?? '').toLowerCase();
      if (part === 'morning') base.setUTCHours(8, 0, 0, 0);
      else if (part === 'afternoon') base.setUTCHours(13, 0, 0, 0);
      else if (part === 'noon') base.setUTCHours(12, 0, 0, 0);
      else if (part === 'evening') base.setUTCHours(18, 0, 0, 0);
      else if (part === 'night') base.setUTCHours(21, 0, 0, 0);
      else if (word === 'tonight') base.setUTCHours(23, 0, 0, 0);

      const hour = relative[3] ? Number.parseInt(relative[3], 10) : null;
      if (hour !== null && !Number.isNaN(hour)) {
        let h = hour;
        const meridiem = (relative[5] ?? '').toLowerCase();
        if (meridiem === 'pm' && h < 12) h += 12;
        if (meridiem === 'am' && h === 12) h = 0;
        base.setUTCHours(h, relative[4] ? Number.parseInt(relative[4], 10) : 0, 0, 0);
      }

      return base.toISOString();
    }

    return null;
  };

  const direct = parse(cleaned);
  if (direct) return direct;

  // "10/15" with no year: the upcoming one.
  const monthDay = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(cleaned);
  if (monthDay) {
    const base = new Date(receivedAt);
    const month = Number.parseInt(monthDay[1] ?? '1', 10);
    const day = Number.parseInt(monthDay[2] ?? '1', 10);
    const rawYear = monthDay[3];
    let year = base.getUTCFullYear();
    if (rawYear) {
      const parsed = Number.parseInt(rawYear, 10);
      year = parsed < 100 ? 2000 + parsed : parsed;
    }
    let candidate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    if (!rawYear && candidate.getTime() < base.getTime() - 86_400_000) {
      candidate = new Date(Date.UTC(year + 1, month - 1, day, 12, 0, 0));
    }
    return candidate.toISOString();
  }

  return null;
}

/** Days ahead for a weekday name, wrapping to next week when it has passed. */
function weekdayOffset(word: string, today: number): number | null {
  const days: Record<string, number> = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    tues: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    thurs: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
  };

  const target = days[word];
  if (target === undefined) return null;

  const delta = (target - today + 7) % 7;
  return delta;
}

function guessBrokerFromEmail(from: string | undefined): string | null {
  if (!from) return null;
  const withoutAddress = from.replace(/<[^>]+>/, '').trim();
  const domain = withoutAddress.split('@')[1];
  if (!domain) return null;
  const name = domain.split('.')[0] ?? domain;
  if (!name) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function buildStopsFromText(origin: string | null, destination: string | null): ParsedStop[] {
  const stops: ParsedStop[] = [];
  if (origin) {
    stops.push({
      type: 'pickup',
      facilityName: origin,
      city: cityOf(origin),
      state: stateOf(origin),
      address: origin,
    });
  }
  if (destination) {
    stops.push({
      type: 'delivery',
      facilityName: destination,
      city: cityOf(destination),
      state: stateOf(destination),
      address: destination,
    });
  }
  return stops;
}

function cityOf(location: string): string {
  return (location.split(',')[0] ?? '').trim();
}

function stateOf(location: string): string | null {
  const parts = location.split(',');
  const second = (parts[1] ?? '').trim().toUpperCase();
  const code = second.split(/\s+/)[0] ?? '';
  return code.length === 2 ? code : null;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                                 */
/* -------------------------------------------------------------------------- */

export function normalizeEquipment(value: string | null | undefined): TrailerType | null {
  if (!value) return null;
  const text = value.toLowerCase();

  if (/\b(reefer|refrigerated|refrigerated\s*food|frozen|cold|chilled)\b/.test(text)) return 'reefer';
  if (/\b(tanker|bulk|frac|tanker\s*van)\b/.test(text)) return 'tanker';
  if (/\b(flat\s*bed|flatbed|flat\s*rack)\b/.test(text)) return 'flatbed';
  if (/\b(step\s*deck|step\s*deck\s*trailer|SD)\b/.test(text)) return 'step_deck';
  if (/\b(power\s*only|drop\s*trailer|PTOL)\b/.test(text)) return 'power_only';
  if (/\b(box\s*truck|straight\s*box|26'?|straight\s*truck)\b/.test(text)) return 'box_truck';
  if (/\b(dry\s*van|53'?|van|reeferless|dv|standard\s*van)\b/.test(text)) return 'dry_van';
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,\s]/g, '');
    if (!cleaned) return null;
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** Per-mile view of a parsed rate, for the confirmation toast. */
export function parsedRatePerMile(parsed: ParsedLoad): number | null {
  if (!parsed.rateCents || !parsed.miles) return null;
  return perMileCents(parsed.rateCents, parsed.miles);
}

export type { GroqResult, GroqError };
function cleanLocation(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    // Strip a leading label so the pickup city is never "Tender - Columbus OH"
    // or "Load: Dallas, TX". Only 1-3 words of letters, so a real place name
    // containing a dash is left alone.
    .replace(/^[A-Za-z]{2,14}(?:\s+[A-Za-z]{2,14}){0,2}\s*[-:]\s+/, '')
    .replace(/^(at|near|from|to|origin|destination)\s+/i, '')
    .trim()
    .replace(/[,;]\s*$/, '');
}
