import { describe, expect, it, vi } from 'vitest';

import {
  GroqClient,
  GroqError,
  coerceParsedLoad,
  deterministicParse,
  extractJson,
  laneFrom,
  normalizeEquipment,
  parseBrokerEmail,
  parsedRatePerMile,
  summarizeOutcome,
} from '@truckdesk/llm';

/**
 * Broker email parsing.
 *
 * Groq is mocked at the transport layer rather than stubbed at the client, so the
 * real request shape, the JSON extraction, the repair pass and the fallback are
 * all exercised. The rule the tests enforce: a wrong rate is worse than no rate,
 * so anything the parser cannot attribute to the email comes back flagged.
 */

/* -------------------------------------------------------------------------- */
/* Mock transport                                                                */
/* -------------------------------------------------------------------------- */

interface MockOptions {
  content: string;
  status?: number;
  /** Fail this many times before succeeding, to exercise the retry path. */
  failFirst?: number;
}

function mockFetch({ content, status = 200, failFirst = 0 }: MockOptions) {
  const calls: string[] = [];
  let failures = failFirst;

  const impl = vi.fn(async (input: string) => {
    calls.push(input);

    if (failures > 0) {
      failures -= 1;
      return {
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => 'rate limit',
      };
    }

    if (status !== 200) {
      return { ok: false, status, json: async () => ({}), text: async () => 'boom' };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'llama-3.3-70b-versatile',
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
      }),
      text: async () => content,
    };
  });

  return { impl: impl as unknown as typeof fetch, calls, count: () => impl.mock.calls.length };
}

const EMAIL = {
  from: 'dispatch@midwestfreight.com',
  subject: 'Tender - Columbus OH to Pittsburgh PA',
  body: [
    'Load: Columbus, OH to Pittsburgh, PA',
    'Rate: $1,850.00 flat',
    'Miles: 185',
    'Weight: 38,000 lbs',
    'Pickup: tomorrow 08:00',
    'Delivery: 2026-03-18',
  ].join('\n'),
  receivedAt: '2026-03-16T14:00:00.000Z',
};

const GOOD_JSON = JSON.stringify({
  broker: 'Midwest Freight',
  reference: 'RWF-1041',
  origin: 'Columbus, OH',
  destination: 'Pittsburgh, PA',
  commodity: 'Rolled steel coil',
  equipment: 'dry_van',
  rate: 1850,
  rateType: 'flat',
  miles: 185,
  weightLbs: 38400,
  pickupDate: '2026-03-17',
  deliveryDate: '2026-03-18',
  pickupWindowStart: null,
  pickupWindowEnd: null,
  commodityRequiresTemp: false,
  stops: [
    { type: 'pickup', facilityName: 'Ridgeway Columbus', city: 'Columbus', state: 'OH', address: null },
    { type: 'delivery', facilityName: 'Consolidated Steel', city: 'Pittsburgh', state: 'PA', address: null },
  ],
  confirmationCode: null,
  accessorialNotes: null,
});

/* -------------------------------------------------------------------------- */

describe('GroqClient', () => {
  it('sends the expected request shape', async () => {
    const mock = mockFetch({ content: GOOD_JSON });
    const client = new GroqClient({ apiKey: 'test-key', fetchImpl: mock.impl });

    await client.chat([{ role: 'user', content: 'hello' }]);

    expect(mock.count()).toBe(1);
    expect(mock.calls[0]).toContain('/chat/completions');
  });

  it('reports usage and latency', async () => {
    const mock = mockFetch({ content: GOOD_JSON });
    const client = new GroqClient({ apiKey: 'test-key', fetchImpl: mock.impl });

    const result = await client.chat([{ role: 'user', content: 'hello' }]);

    expect(result.usage.totalTokens).toBe(200);
    expect(result.offline).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('retries a 429 and then succeeds', async () => {
    const mock = mockFetch({ content: GOOD_JSON, failFirst: 1 });
    const client = new GroqClient({ apiKey: 'test-key', fetchImpl: mock.impl, retries: 2 });

    const result = await client.chat([{ role: 'user', content: 'hello' }]);

    expect(result.ok !== undefined || result.content).toBeDefined();
    expect(mock.count()).toBe(2);
  });

  it('throws a typed error on a hard failure', async () => {
    const mock = mockFetch({ content: '', status: 401 });
    const client = new GroqClient({ apiKey: 'bad', fetchImpl: mock.impl, retries: 0 });

    await expect(client.chat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(GroqError);
  });

  it('works with no API key at all', async () => {
    const client = new GroqClient({});

    expect(client.isConfigured()).toBe(false);
    expect(client.isLive()).toBe(false);

    const result = await client.chat([{ role: 'user', content: EMAIL.body }]);
    expect(result.offline).toBe(true);
    expect(() => JSON.parse(result.content)).not.toThrow();
  });
});

describe('extractJson', () => {
  it('parses bare JSON', () => {
    expect(extractJson(GOOD_JSON)?.origin).toBe('Columbus, OH');
  });

  it('parses a markdown-fenced object', () => {
    const fenced = 'Here is the load:\n```json\n' + GOOD_JSON + '\n```\nThanks!';
    expect(extractJson(fenced)?.destination).toBe('Pittsburgh, PA');
  });

  it('recovers an object surrounded by prose', () => {
    const chatty = `Sure! ${GOOD_JSON} Let me know if you need anything else.`;
    expect(extractJson(chatty)?.rateCents).toBe(185_000);
  });

  it('returns null for non-JSON', () => {
    expect(extractJson('I cannot read that email.')).toBeNull();
    expect(extractJson('')).toBeNull();
  });

  it('rejects JSON that is not an object', () => {
    expect(coerceParsedLoad('[1,2,3]')).toBeNull();
    expect(coerceParsedLoad('"a string"')).toBeNull();
    expect(coerceParsedLoad('{ not json')).toBeNull();
  });

  it('tolerates nulls and wrong types without throwing', () => {
    const parsed = coerceParsedLoad(
      JSON.stringify({ origin: 'X, OH', rate: 'n/a', miles: null, stops: 'nope' }),
    );
    expect(parsed?.origin).toBe('X, OH');
    expect(parsed?.rateCents).toBeNull();
    expect(parsed?.miles).toBeNull();
    expect(parsed?.stops).toEqual([]);
  });
});

describe('parseBrokerEmail with a live model', () => {
  it('returns a high-confidence load for a well-formed tender', async () => {
    const mock = mockFetch({ content: GOOD_JSON });
    const client = new GroqClient({ apiKey: 'test-key', fetchImpl: mock.impl });

    const result = await parseBrokerEmail(EMAIL, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const outcome = result.value;
    expect(outcome.source).toBe('groq');
    expect(outcome.parsed.origin).toBe('Columbus, OH');
    expect(outcome.parsed.rateCents).toBe(185_000);
    expect(outcome.parsed.miles).toBe(185);
    expect(outcome.overallConfidence).toBeGreaterThan(0.7);
    expect(outcome.load).not.toBeNull();
  });

  it('asks for a repair when the first response is not JSON', async () => {
    // First response is prose; the repair response is valid JSON.
    const contents = ['I think the rate is around ,800?', GOOD_JSON];
    let call = 0;

    const impl = vi.fn(async () => {
      const content = contents[call++] ?? GOOD_JSON;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
        text: async () => content,
      };
    });

    const client = new GroqClient({ apiKey: 'test-key', fetchImpl: impl as unknown as typeof fetch });
    const result = await parseBrokerEmail(EMAIL, client);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(impl.mock.calls.length).toBe(2);
    expect(result.value.source).toBe('groq-repaired');
    expect(result.value.parsed.rateCents).toBe(185_000);
  });

  it('falls back to the deterministic parser when the model returns garbage twice', async () => {
    const mock = mockFetch({ content: 'sorry, no' });
    const client = new GroqClient({ apiKey: 'test-key', fetchImpl: mock.impl });

    const result = await parseBrokerEmail(EMAIL, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.source).toBe('fallback');
    expect(result.value.warnings.some((warning) => warning.includes('could not be parsed as JSON'))).toBe(true);
  });

  it('downgrades a hallucinated field the email does not contain', async () => {
    const hallucinated = JSON.stringify({ ...JSON.parse(GOOD_JSON), commodity: 'Rare Earth Metals' });
    const mock = mockFetch({ content: hallucinated });
    const client = new GroqClient({ apiKey: 'test-key', fetchImpl: mock.impl });

    const result = await parseBrokerEmail(EMAIL, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // "Rare Earth Metals" appears nowhere in the email, so it cannot be trusted.
    expect(result.value.confidence['commodity']).toBe('low');
  });

  it('never invents a rate when the email omits it', async () => {
    const noRate = JSON.stringify({ ...JSON.parse(GOOD_JSON), rate: null });
    const mock = mockFetch({ content: noRate });
    const client = new GroqClient({ apiKey: 'test-key', fetchImpl: mock.impl });

    const result = await parseBrokerEmail(EMAIL, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.parsed.rateCents).toBeNull();
    // Without a rate the load cannot be booked, and the UI is told why.
    expect(result.value.load).toBeNull();
    expect(result.value.needsReview.some((item) => item.field === 'rateDollars')).toBe(true);
  });

  it('falls back cleanly when the provider throws', async () => {
    const impl = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = new GroqClient({
      apiKey: 'test-key',
      fetchImpl: impl as unknown as typeof fetch,
      retries: 0,
    });

    const result = await parseBrokerEmail(EMAIL, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.source).toBe('fallback');
    expect(result.value.warnings.some((warning) => warning.includes('LLM unavailable'))).toBe(true);
    // The fallback still found the lane, which is the important part.
    expect(result.value.parsed.origin).toBe('Columbus, OH');
  });

  it('rejects an empty body', async () => {
    const client = new GroqClient({ apiKey: 'test-key' });
    const result = await parseBrokerEmail({ body: '   ' }, client);
    expect(result.ok).toBe(false);
  });
});

describe('deterministic parser', () => {
  it('reads the labelled fields', () => {
    const parsed = deterministicParse(EMAIL, EMAIL.receivedAt);

    expect(parsed.origin).toBe('Columbus, OH');
    expect(parsed.destination).toBe('Pittsburgh, PA');
    expect(parsed.rateDollars).toBe(1850);
    expect(parsed.miles).toBe(185);
    expect(parsed.weightLbs).toBe(38_000);
    // A delivery date with no time is a deadline, so it resolves to end of day.
    // Midnight would land before the 08:00 pickup and reject a same-day move.
    expect(parsed.deliveryDate).toBe('2026-03-18T23:59:59.999Z');
  });

  it('reads a lane written as "A to B"', () => {
    const parsed = deterministicParse(
      { subject: 'Load: Memphis TN to Nashville TN', body: 'Rate: $2,400' },
      '2026-03-16T14:00:00.000Z',
    );
    expect(parsed.origin).toContain('Memphis');
    expect(parsed.destination).toContain('Nashville');
  });

  it('does not mistake a lane line for the pickup date', () => {
    // "Load: Columbus, OH to Pittsburgh, PA" precedes "Pickup: tomorrow".
    const parsed = deterministicParse(EMAIL, EMAIL.receivedAt);
    expect(parsed.pickupDate).toBe('2026-03-17T08:00:00.000Z');
  });

  it('reads a per-mile rate and multiplies it out', () => {
    const parsed = deterministicParse(
      { body: 'Origin: Columbus, OH\nDestination: Pittsburgh, PA\nRate: 2.85/mi\nMiles: 185' },
      '2026-03-16T14:00:00.000Z',
    );
    expect(parsed.rateType).toBe('per_mile');
    expect(parsed.rateDollars).toBeCloseTo(527.25, 2);
  });

  it('reads equipment words and synonyms', () => {
    expect(normalizeEquipment('53 dry van')).toBe('dry_van');
    expect(normalizeEquipment('Reefer')).toBe('reefer');
    expect(normalizeEquipment('flatbed')).toBe('flatbed');
    expect(normalizeEquipment('tanker')).toBe('tanker');
    expect(normalizeEquipment('power only')).toBe('power_only');
    expect(normalizeEquipment('something odd')).toBeNull();
    expect(normalizeEquipment(null)).toBeNull();
  });

  it('guesses the broker from the sender domain', () => {
    const parsed = deterministicParse({ from: 'loads@midwestfreight.com', body: 'x' }, '2026-03-16T14:00:00.000Z');
    expect(parsed.broker).toBe('Midwestfreight');
  });
});

describe('laneFrom', () => {
  it('needs a state code or an explicit label to be confident', () => {
    // A lane in a subject line is trusted even without commas, because a
    // subject is a title rather than prose. A lane buried in body prose is not.
    expect(laneFrom({ subject: 'Tender - Columbus OH to Pittsburgh PA' })).not.toBeNull();
    expect(laneFrom({ subject: 'Please review the attached documents' })).toBeNull();
    expect(laneFrom({ body: 'Load: Please deliver to Columbus, OH' })).toBeNull();
  });

  it('strips a label prefix from the pickup city', () => {
    const lane = laneFrom({ body: 'RE: Tender - Columbus OH to Pittsburgh PA' });
    expect(lane?.origin).toBe('Columbus OH');
    expect(lane?.origin).not.toMatch(/tender/i);
  });

  it('reads a labelled lane with state codes', () => {
    const lane = laneFrom({ body: 'Load: Columbus, OH to Pittsburgh, PA' });
    expect(lane?.origin).toBe('Columbus, OH');
    expect(lane?.destination).toBe('Pittsburgh, PA');
  });
});

describe('helpers', () => {
  it('computes revenue per mile from a parse', () => {
    expect(parsedRatePerMile({ rateCents: 185_000, miles: 185 } as never)).toBe(1000);
    expect(parsedRatePerMile({ rateCents: 185_000, miles: 0 } as never)).toBeNull();
  });

  it('summarises an outcome for a toast', async () => {
    const client = new GroqClient({});
    const result = await parseBrokerEmail(EMAIL, client, { deterministic: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(summarizeOutcome(result.value)).toContain('Columbus, OH');
  });

  it('flags an empty body', async () => {
    const result = await parseBrokerEmail({ body: '' }, new GroqClient({}));
    expect(result.ok).toBe(false);
  });
});