import {
  parseMoneyToCents,
  toIsoOrNull,
  type Iso,
  type TrailerType,
} from '@truckdesk/shared';

import { normalizeEquipment } from '@truckdesk/llm';

/**
 * Canonical normalization for anything load-shaped: typed API payloads, CSV
 * imports, email parses, webhook payloads from a TMS.
 *
 * Everything funnels through `normalizeLoadDraft` so that the validation rules
 * live once. A broker email and a JSON import of the same load produce the same
 * draft object, which is what makes the offline replay path safe.
 */

export interface LoadDraft {
  broker: string;
  reference?: string;
  origin: string;
  destination: string;
  rateCents: number;
  miles: number;
  commodity?: string;
  weightLbs?: number;
  equipment?: TrailerType;
  pickupDate?: Iso;
  deliveryDate?: Iso;
  notes?: string;
}

export interface NormalizeResult {
  draft: LoadDraft;
  /** Fields that were present in the input but could not be understood. */
  rejected: Array<{ field: string; value: unknown; reason: string }>;
  /** Fields absent from the input, with the reason they matter. */
  missing: string[];
  warnings: string[];
}

/**
 * Accepts the shapes a real carrier actually receives. Money may arrive as a
 * dollar number, a cent integer or a string with a currency symbol; mileage may
 * arrive as "412", "412 mi" or a float.
 */
export function normalizeLoadDraft(input: Record<string, unknown>): NormalizeResult {
  const rejected: NormalizeResult['rejected'] = [];
  const missing: string[] = [];
  const warnings: string[] = [];

  const broker = str(input['broker'] ?? input['brokerName'] ?? input['customer']);
  const origin = str(input['origin'] ?? input['pickup'] ?? input['pickupLocation']);
  const destination = str(input['destination'] ?? input['delivery'] ?? input['deliveryLocation']);

  if (!broker) missing.push('broker');
  if (!origin) missing.push('origin');
  if (!destination) missing.push('destination');

  const rateCents = readCents(input['rate'] ?? input['rateCents'] ?? input['pay']);
  if (rateCents === null || rateCents <= 0) {
    rejected.push({
      field: 'rate',
      value: input['rate'] ?? input['rateCents'] ?? input['pay'],
      reason: 'Could not read a positive rate',
    });
  }

  const miles = readNumber(input['miles'] ?? input['distance'] ?? input['totalMiles']);
  if (miles === null || miles <= 0) {
    rejected.push({
      field: 'miles',
      value: input['miles'] ?? input['distance'] ?? input['totalMiles'],
      reason: 'Could not read a positive mileage',
    });
  }

  const weightLbs = readNumber(input['weightLbs'] ?? input['weight'] ?? input['weightPounds']);

  const equipment = normalizeEquipment(str(input['equipment'] ?? input['trailerType'] ?? input['trailer']));
  if (input['equipment'] && !equipment) {
    warnings.push(`Unrecognised equipment "${String(input['equipment'])}"; defaulted to dry van`);
  }

  const pickupDate = toIsoOrNull(str(input['pickupDate'] ?? input['pickupAt'] ?? input['pickupTime']));
  if (input['pickupDate'] && !pickupDate) {
    rejected.push({ field: 'pickupDate', value: input['pickupDate'], reason: 'Unparseable date' });
  }

  const deliveryDate = toIsoOrNull(str(input['deliveryDate'] ?? input['deliverAt'] ?? input['deliveryTime']));
  if (input['deliveryDate'] && !deliveryDate) {
    rejected.push({ field: 'deliveryDate', value: input['deliveryDate'], reason: 'Unparseable date' });
  }

  if (pickupDate && deliveryDate && Date.parse(deliveryDate) < Date.parse(pickupDate)) {
    warnings.push('Delivery date is before pickup; the broker may have transposed them');
  }

  if (origin && destination && origin.trim().toLowerCase() === destination.trim().toLowerCase()) {
    warnings.push('Origin and destination are the same');
  }

  const draft: LoadDraft = {
    broker: broker ?? '',
    reference: str(input['reference'] ?? input['loadNumber'] ?? input['confirmationCode']) ?? undefined,
    origin: origin ?? '',
    destination: destination ?? '',
    rateCents: Math.max(0, Math.round(rateCents ?? 0)),
    miles: Math.max(0, Math.round(miles ?? 0)),
    commodity: str(input['commodity'] ?? input['product'] ?? input['freight']) ?? undefined,
    weightLbs: weightLbs !== null ? Math.round(weightLbs) : undefined,
    equipment: equipment ?? undefined,
    pickupDate: pickupDate ?? undefined,
    deliveryDate: deliveryDate ?? undefined,
    notes: str(input['notes'] ?? input['specialInstructions']) ?? undefined,
  };

  if (miles && rateCents) {
    const rpm = rateCents / miles;
    if (rpm < 100) {
      warnings.push(`$${(rpm / 100).toFixed(2)}/mi is below the $1.00/mi floor; check the rate`);
    } else if (rpm > 700) {
      warnings.push(`$${(rpm / 100).toFixed(2)}/mi is unusually high; verify before booking`);
    }
  }

  return { draft, rejected, missing, warnings };
}

/* -------------------------------------------------------------------------- */
/* Readers                                                                       */
/* -------------------------------------------------------------------------- */

/** Read a dollar amount from a number, a numeric string, or "$2,450.00". */
export function readCents(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Values over 10_000 are almost certainly already cents.
    return value > 10_000 ? Math.round(value) : Math.round(value * 100);
  }
  if (typeof value === 'string') return parseMoneyToCents(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const inner = record['amount'] ?? record['cents'] ?? record['value'];
    if (typeof inner === 'number') {
      // `{ amount: 2450 }` is dollars; `{ cents: 245000 }` is cents.
      return 'cents' in record ? Math.round(inner) : Math.round(inner * 100);
    }
    if (typeof inner === 'string') return parseMoneyToCents(inner);
  }
  return null;
}

/** Read a number from "412", "412 mi", "412.5", 412. */
export function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').replace(/[^0-9.\-]/g, '');
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

/* -------------------------------------------------------------------------- */
/* CSV import                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parse a broker CSV export. Handles quoted fields and embedded newlines,
 * because broker exports are rarely clean.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // Excel exports frequently carry a UTF-8 BOM; it must not become part of the
  // first header cell.
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];

    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const isBlank = (cells: string[]): boolean => cells.every((cell) => cell.trim() === '');

  // The header is the first row with any content. Broker exports routinely
  // start with a report title or a blank line, and treating one of those as the
  // header silently maps every real column onto the wrong field.
  const headerIndex = rows.findIndex((cells) => !isBlank(cells));
  if (headerIndex < 0) return [];

  const headers = rows[headerIndex]!.map((cell) => normalizeHeader(cell));
  const out: Record<string, string>[] = [];

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const cells = rows[i];
    if (!cells || isBlank(cells)) continue;
    const record: Record<string, string> = {};
    headers.forEach((key, index) => {
      record[key] = (cells[index] ?? '').trim();
    });
    // 1-based including the header, so the number matches the spreadsheet.
    record.__row = String(i + 1);
    out.push(record);
  }

  return out;
}

/** Map a broker's header names onto our field names. */
function normalizeHeader(header: string): string {
  const key = header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const table: Record<string, string> = {
    load_number: 'reference',
    load_no: 'reference',
    load_id: 'reference',
    ref: 'reference',
    booking_number: 'reference',
    broker_name: 'broker',
    shipper: 'broker',
    customer: 'broker',
    pickup_city: 'origin',
    origin_city: 'origin',
    from_city: 'origin',
    pickup: 'origin',
    delivery_city: 'destination',
    dest_city: 'destination',
    to_city: 'destination',
    destination: 'destination',
    pay: 'rate',
    rate_usd: 'rate',
    amount_usd: 'rate',
    flat_rate: 'rate',
    total_pay: 'rate',
    distance: 'miles',
    total_miles: 'miles',
    trip_miles: 'miles',
    weight: 'weightLbs',
    total_weight: 'weightLbs',
    weight_lbs: 'weightLbs',
    trailer: 'equipment',
    trailer_type: 'equipment',
    commodity: 'commodity',
    product: 'commodity',
    pickup_date: 'pickupDate',
    ready_date: 'pickupDate',
    delivery_date: 'deliveryDate',
    due_date: 'deliveryDate',
  };
  return table[key] ?? key;
}

export interface CsvImportResult {
  /** Every parsed data row, keyed by our canonical field names. */
  rows: Record<string, string>[];
  /** Data rows excluding the header. */
  totalRows: number;
  /** Rows that carried every field needed to become a load. */
  drafts: Array<{ row: number; draft: LoadDraft }>;
  valid: number;
  /** Rows that could not be used, each with a reason a dispatcher can act on. */
  failures: Array<{ row: number; reason: string; rejected: NormalizeResult['rejected'] }>;
  failed: number;
}

/** Bulk-import a broker CSV into normalized drafts. */
export function importCsv(text: string): CsvImportResult {
  const rows = parseCsv(text);
  const drafts: CsvImportResult['drafts'] = [];
  const failures: CsvImportResult['failures'] = [];

  rows.forEach((row, index) => {
    const normalized = normalizeLoadDraft(row);
    const blocking = normalized.missing.length > 0 || normalized.rejected.length > 0;

    if (blocking) {
      const reasons = [
        ...normalized.missing.map((field) => `missing ${field}`),
        ...normalized.rejected.map((item) => `${item.field}: ${item.reason}`),
      ];
      const rowNumber = Number.parseInt(row['__row'] ?? String(index + 2), 10);
      failures.push({ row: rowNumber, reason: reasons.join('; '), rejected: normalized.rejected });
      return;
    }

    const rowNumber = Number.parseInt(row['__row'] ?? String(index + 2), 10);
    drafts.push({ row: rowNumber, draft: normalized.draft });
  });

  return {
    rows,
    totalRows: rows.length,
    drafts,
    valid: drafts.length,
    failures,
    failed: failures.length,
  };
}
