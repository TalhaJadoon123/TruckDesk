import {
  Errors,
  err,
  ok,
  type Iso,
  type Load,
  type LoadDocument,
  type LoadStop,
  type Result,
  type TrailerType,
  uuid,
} from '@truckdesk/shared';

/**
 * Document checklists.
 *
 * The reason a load gets held at the dock is almost always a missing or wrong
 * document. This module turns the rules of the road into a checklist the
 * dispatcher can see per load, and into the POD capture payload the driver app
 * sends. It has no storage knowledge - `packages/api` owns that.
 */

/* -------------------------------------------------------------------------- */
/* Checklist                                                                     */
/* -------------------------------------------------------------------------- */

export type ChecklistItemKey =
  | 'rate_con'
  | 'w9'
  | 'insurance_cert'
  | 'broker_packet'
  | 'lumper_receipt'
  | 'seal_number'
  | 'bol'
  | 'pod'
  | 'signature'
  | 'driver_signature'
  | 'photos'
  | 'damage_photo'
  | 'tif'
  | 'exemption'
  | 'scale_ticket'
  | 'delivery_receipt';

export interface ChecklistItem {
  key: ChecklistItemKey;
  label: string;
  /** Which side has to have it. */
  owner: 'carrier' | 'broker' | 'driver';
  required: boolean;
  satisfied: boolean;
  /** Why it is required, so a driver is not asked to explain themselves. */
  reason: string;
  /** Some items only become required at a particular point in the load. */
  dueAt?: 'booking' | 'dispatch' | 'pickup' | 'delivery';
  satisfiedByDocumentId?: string;
  satisfiedAt?: Iso;
}

export type ChecklistPhase = 'booking' | 'dispatch' | 'pickup' | 'delivery';

export interface Checklist {
  loadId: string;
  phase: ChecklistPhase;
  items: ChecklistItem[];
  required: ChecklistItem[];
  missing: ChecklistItem[];
  complete: boolean;
  /** Blockers that stop the load moving forward right now. */
  blockers: string[];
  /** Items that will be needed later but are not blocking yet. */
  upcoming: ChecklistItem[];
}

/** Which of the three states a load is in, from its status. */
export function phaseFor(load: Load): ChecklistPhase {
  switch (load.status) {
    case 'booked':
      return 'booking';
    case 'dispatched':
      return 'dispatch';
    case 'in-transit':
      return 'pickup';
    case 'delivered':
    case 'paid':
      return 'delivery';
    default:
      return 'booking';
  }
}

/** Phase ordering, so "is this item due yet" is a comparison. */
const PHASE_ORDER: Record<ChecklistPhase, number> = {
  booking: 0,
  dispatch: 1,
  pickup: 2,
  delivery: 3,
};

export function buildChecklist(
  load: Load,
  options: { carrierHasW9?: boolean; carrierHasInsurance?: boolean; scaleTicketRequired?: boolean } = {},
): Checklist {
  const phase = phaseFor(load);
  const docs = load.documents ?? [];
  const has = (type: LoadDocument['type']) => docs.some((doc) => doc.type === type);
  const hasDoc = (key: ChecklistItemKey) => has(key as LoadDocument['type']);

  const stops = load.stops ?? [];
  const hasDeliveryStop = stops.some((stop) => stop.type === 'delivery');
  const hasPickupStop = stops.some((stop) => stop.type === 'pickup');
  const multipleStops = stops.filter((stop) => stop.type === 'pickup').length > 1;

  const items: ChecklistItem[] = [
    {
      key: 'rate_con',
      label: 'Rate confirmation',
      owner: 'broker',
      required: true,
      satisfied: hasDoc('rate_con'),
      reason: 'The signed rate con is what the broker pays against.',
      dueAt: 'booking',
    },
    {
      key: 'w9',
      label: 'W-9',
      owner: 'carrier',
      required: true,
      // A carrier-level W-9 is on file forever, not per load.
      satisfied: hasDoc('w9') || options.carrierHasW9 === true,
      reason: 'Without a W-9 on file the broker cannot set up payment and will not release the trailer.',
      dueAt: 'booking',
    },
    {
      key: 'insurance_cert',
      label: 'Certificate of insurance',
      owner: 'carrier',
      required: true,
      satisfied: hasDoc('insurance_cert') || options.carrierHasInsurance === true,
      reason: 'Most shippers verify COI before the truck arrives.',
      dueAt: 'dispatch',
    },
    {
      key: 'broker_packet',
      label: 'Broker packet / shipper instructions',
      owner: 'broker',
      required: true,
      satisfied: hasDoc('bol') || docs.length > 0,
      reason: 'Confirms the seal number, appointment time and any facility rules.',
      dueAt: 'dispatch',
    },
    ...(multipleStops
      ? [
          {
            key: 'seal_number' as ChecklistItemKey,
            label: 'Seal numbers for each pickup',
            owner: 'broker' as const,
            required: true,
            satisfied: hasDoc('bol'),
            reason: `${multipleStops} pickups means a separate seal per trailer load.`,
            dueAt: 'dispatch' as const,
          },
        ]
      : []),
    {
      key: 'lumper_receipt',
      label: 'Lumper receipt',
      owner: 'driver',
      // Lumping is not always charged; required once the facility does charge.
      required: false,
      satisfied: hasDoc('lumper_receipt'),
      reason: 'Without a receipt the lumper fee is usually refused, and it comes out of driver pay.',
      dueAt: 'pickup',
    },
    {
      key: 'seal_number',
      label: 'Seal number recorded on the BOL',
      owner: 'driver',
      required: true,
      satisfied: hasDoc('bol'),
      reason: 'A BOL with no seal number is an incomplete BOL and brokers reject them.',
      dueAt: 'pickup',
    },
    {
      key: 'bol',
      label: 'Bill of lading',
      owner: 'driver',
      required: true,
      satisfied: hasDoc('bol'),
      reason: 'Proof freight left the shipper. Photograph every page.',
      dueAt: 'pickup',
    },
    {
      key: 'photos',
      label: 'Pickup photos',
      owner: 'driver',
      required: true,
      satisfied: docs.filter((doc) => doc.type === 'damage_photo').length > 0,
      reason: 'Trailer, load and seal at pickup. This is what settles a damage claim later.',
      dueAt: 'pickup',
    },
    {
      key: 'pod',
      label: hasDeliveryStop ? 'Proof of delivery' : 'Delivery receipt',
      owner: 'driver',
      required: true,
      satisfied: hasDoc('pod'),
      reason: 'No POD means no payment. Brokers pay on the POD, not on the tracking ping.',
      dueAt: 'delivery',
    },
    {
      key: 'signature',
      label: 'Receiver signature and name',
      owner: 'driver',
      required: true,
      satisfied: hasDoc('driver_signature') || Boolean(load.documents?.[0]?.signatureName),
      reason: 'An unsigned POD is treated as an unsigned invoice by most brokers.',
      dueAt: 'delivery',
    },
    {
      key: 'damage_photo',
      label: 'Damage photos on delivery',
      owner: 'driver',
      required: false,
      satisfied: docs.filter((doc) => doc.type === 'damage_photo').length > 1,
      reason: 'Only needed if there is damage, an exception, or the count does not match.',
      dueAt: 'delivery',
    },
    {
      key: 'tif',
      label: 'Traffic violation fines (TIF)',
      owner: 'driver',
      required: false,
      satisfied: !hasDoc('tif'),
      reason: 'Only applies if the driver was cited. Money is recovered from the driver.',
      dueAt: 'delivery',
    },
    {
      key: 'scale_ticket',
      label: 'Scale ticket',
      owner: 'carrier',
      required: options.scaleTicketRequired ?? Boolean(load.weightLbs && load.weightLbs > 40_000),
      satisfied: hasDoc('pod') || Boolean(load.weightLbs),
      reason: 'Weigh ticket is needed for overweight billing and for accessorial disputes.',
      dueAt: 'pickup',
    },
    {
      key: 'exemption',
      label: 'Exemption permit',
      owner: 'driver',
      required: load.equipment === 'power_only',
      satisfied: hasDoc('exemption'),
      reason: 'A power-only move needs the broker exemption certificate before pickup.',
      dueAt: 'dispatch',
    },
  ];

  // De-duplicate: the multi-pickup seal item and the BOL seal item share a key.
  const deduped: ChecklistItem[] = [];
  const seen = new Set<ChecklistItemKey>();
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    deduped.push(item);
  }

  const isDue = (item: ChecklistItem) =>
    !item.dueAt || PHASE_ORDER[item.dueAt] <= PHASE_ORDER[phase];

  const required = deduped.filter((item) => item.required);
  const missing = required.filter((item) => !item.satisfied);
  const blockers = missing
    .filter((item) => isDue(item))
    .map((item) => `${item.label} (${item.owner}): ${item.reason}`);
  const upcoming = required.filter((item) => !item.satisfied && !isDue(item));

  return {
    loadId: load.id,
    phase,
    items: deduped,
    required,
    missing,
    complete: missing.length === 0,
    blockers,
    upcoming,
  };
}

/**
 * Can this load be dispatched? Only the dispatch-phase items are enforced, so a
 * carrier is not blocked from booking freight they have not photographed yet.
 */
export function canDispatch(load: Load, options?: Parameters<typeof buildChecklist>[1]): Result<true> {
  const checklist = buildChecklist(load, options);

  if (checklist.loadId !== load.id) {
    return err(Errors.internal('Checklist does not match the load', { loadId: load.id }));
  }

  const dispatchPhaseBlockers = checklist.required
    .filter((item) => !item.satisfied && (item.dueAt === 'booking' || item.dueAt === 'dispatch'))
    .map((item) => item.label);

  if (dispatchPhaseBlockers.length > 0) {
    return err(
      Errors.invalidState(`Missing before dispatch: ${dispatchPhaseBlockers.join(', ')}`, {
        loadId: load.id,
        missing: dispatchPhaseBlockers,
      }),
    );
  }

  return ok(true);
}

/** Can the load be marked delivered? This is the POD gate. */
export function canDeliver(load: Load, options?: Parameters<typeof buildChecklist>[1]): Result<true> {
  const checklist = buildChecklist(load, options);
  const deliveryBlockers = checklist.required
    .filter((item) => !item.satisfied && item.dueAt === 'delivery')
    .map((item) => item.label);

  if (deliveryBlockers.length > 0) {
    return err(
      Errors.invalidInput(`Cannot mark delivered without: ${deliveryBlockers.join(', ')}`, {
        loadId: load.id,
        missing: deliveryBlockers,
      }),
    );
  }
  return ok(true);
}

/* -------------------------------------------------------------------------- */
/* Document construction                                                         */
/* -------------------------------------------------------------------------- */

export interface CaptureInput {
  loadId: string;
  /** Tenant scope the storage key must sit inside. */
  companyId?: string;
  type: LoadDocument['type'];
  fileName: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  capturedAt?: Iso;
  geo?: { lat: number; lng: number };
  signatureName?: string;
  signatureDataUrl?: string;
  pageCount?: number;
}

export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
export const ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
  'application/pdf',
];

/** Extensions we are willing to store, mapped from the validated MIME type. */
const EXTENSION_FOR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * A storage key may only contain these characters.
 *
 * This is the load-bearing validation in the whole upload path: the key comes
 * from the client's request body, and if it ever reaches a filesystem or an
 * object-store path unvalidated then `../../` is a cross-tenant read. So the
 * charset is narrow (no dots, no slashes beyond the separators we generate,
 * no backslashes, no null bytes, no control characters) and the key is *built*
 * by us rather than accepted.
 */
const STORAGE_KEY_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

export type StorageKeyProblem =
  | 'contains_illegal_characters'
  | 'wrong_scope'
  | 'too_long'
  | 'not_absolute';

/**
 * Validate a client-supplied storage key against the scope it is allowed in.
 *
 * The expected shape is `{companyId}/{loadId}/{fileName}`. Anything that tries
 * to climb out of that prefix is rejected here, before it is ever stored.
 */
export function validateStorageKey(
  storageKey: string,
  scope: { companyId?: string; loadId: string },
): Result<{ companyId: string; loadId: string; fileName: string }> {
  if (typeof storageKey !== 'string' || storageKey.length === 0) {
    return err(Errors.invalidInput('Storage key is required'));
  }
  if (storageKey.length > 512) {
    return err(Errors.invalidInput('Storage key is too long', { maxLength: 512 }));
  }
  // Reject control characters and backslashes before anything else.
  if (/[\x00-\x1F\x7F\\]/.test(storageKey)) {
    return err(Errors.invalidInput('Storage key contains illegal characters'));
  }
  if (storageKey.startsWith('/')) {
    return err(Errors.invalidInput('Storage key must not be absolute'));
  }

  const segments = storageKey.split('/');
  if (segments.length !== 3) {
    return err(
      Errors.invalidInput('Storage key must be "{companyId}/{loadId}/{fileName}"', {
        supplied: segments.length,
      }),
    );
  }

  const [companyId, loadId, fileName] = segments as [string, string, string];

  if (!STORAGE_KEY_SEGMENT.test(companyId)) {
    return err(Errors.invalidInput('Storage key has an invalid company segment'));
  }
  if (loadId !== scope.loadId) {
    return err(
      Errors.invalidInput('Storage key is scoped to a different load', {
        expected: scope.loadId,
      }),
    );
  }
  if (scope.companyId && companyId !== scope.companyId) {
    return err(
      Errors.invalidInput('Storage key is scoped to a different company', {
        expected: scope.companyId,
      }),
    );
  }
  if (!isSafeFileSegment(fileName)) {
    return err(Errors.invalidInput('Storage key has an invalid file name'));
  }

  return ok({ companyId, loadId, fileName });
}

/**
 * A file-name segment may contain dots (every photo has an extension) but must
 * not be able to act as a path segment: no leading dot, and no `..` anywhere.
 */
function isSafeFileSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 160) return false;
  if (segment.startsWith('.')) return false;
  if (segment.includes('..')) return false;
  return /^[A-Za-z0-9._-]+$/.test(segment);
}

/**
 * Build a storage key rather than trusting the client's.
 *
 * The file name is derived from the document id and the MIME type we validated,
 * so it cannot carry an extension the uploader chose or a path they chose.
 */
/**
 * Reduce a client-supplied file name to something safe to store and to echo
 * back in a `Content-Disposition` header.
 *
 * Path separators, control characters and leading dots are removed rather than
 * rejected, because a phone will happily send `IMG_0012.JPG` and a driver
 * should not be told their upload failed over punctuation.
 */
export function sanitizeFileName(input: string): string {
  if (typeof input !== 'string') return '';

  const base = input
    .split(/[/\\]/)
    .pop() ?? '';
  const cleaned = base
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);

  return cleaned.length > 0 ? cleaned : 'document';
}

export function buildStorageKey(input: {
  companyId?: string;
  loadId: string;
  documentId: string;
  mimeType: string;
}): string {
  const company = input.companyId && STORAGE_KEY_SEGMENT.test(input.companyId)
    ? input.companyId
    : 'unscoped';
  const extension = EXTENSION_FOR_MIME[input.mimeType] ?? 'bin';
  return `${company}/${input.loadId}/${input.documentId}.${extension}`;
}

export function makeDocument(input: CaptureInput): Result<LoadDocument> {
  if (!ALLOWED_MIME.includes(input.mimeType)) {
    return err(Errors.invalidInput(`Unsupported file type ${input.mimeType}`, { allowed: ALLOWED_MIME }));
  }

  // The storage key is validated and then rebuilt, so a client cannot point a
  // document at another load's or another company's prefix.
  const keyCheck = validateStorageKey(input.storageKey, {
    ...(input.companyId ? { companyId: input.companyId } : {}),
    loadId: input.loadId,
  });
  if (!keyCheck.ok) return keyCheck;

  const documentId = `dc_${uuid().slice(0, 12)}`;
  const storageKey = buildStorageKey({
    ...(input.companyId ? { companyId: input.companyId } : {}),
    loadId: input.loadId,
    documentId,
    mimeType: input.mimeType,
  });

  if (input.sizeBytes <= 0) {
    return err(Errors.invalidInput('Uploaded file is empty'));
  }
  if (input.sizeBytes > MAX_PHOTO_BYTES) {
    return err(
      Errors.invalidInput(
        `File is ${(input.sizeBytes / 1024 / 1024).toFixed(1)}MB, over the ${
          MAX_PHOTO_BYTES / 1024 / 1024
        }MB limit`,
      ),
    );
  }

  const fileName = sanitizeFileName(input.fileName);
  if (!fileName) {
    return err(Errors.invalidInput('Document needs a file name'));
  }

  return ok({
    // The same id used to build the storage key, so the record and the object
    // it points at cannot drift apart.
    id: documentId,
    loadId: input.loadId,
    type: input.type,
    fileName,
    storageKey,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    uploadedBy: input.uploadedBy,
    uploadedAt: new Date().toISOString(),
    capturedAt: input.capturedAt,
    geo: input.geo,
    signatureName: input.signatureName,
    signatureDataUrl: input.signatureDataUrl,
    pageCount: input.pageCount,
    status: 'uploaded',
  });
}

/**
 * What the driver must photograph at a pickup, in the order to do it. Keeping
 * this explicit is the difference between a 20-second stop and a 5-minute one.
 */
export interface CaptureStep {
  order: number;
  type: LoadDocument['type'];
  label: string;
  hint: string;
  /** Photos only; skipped when the app is on a desktop or tablet upload. */
  camera: boolean;
  signature: boolean;
}

export function pickupCaptureSteps(load: Load): CaptureStep[] {
  const steps: CaptureStep[] = [
    {
      order: 1,
      type: 'bol',
      label: 'Bill of lading',
      hint: 'Photograph every page flat and square. Write the seal number on it.',
      camera: true,
      signature: false,
    },
    {
      order: 2,
      type: 'damage_photo',
      label: 'Trailer and load',
      hint: 'Four corners of the trailer, then the load itself, then the seal.',
      camera: true,
      signature: false,
    },
    {
      order: 3,
      type: 'lumper_receipt',
      label: 'Lumper receipt',
      hint: 'Only if the facility charged. Photograph the whole receipt including the total.',
      camera: true,
      signature: false,
    },
  ];

  const pickupStops = (load.stops ?? []).filter((stop) => stop.type === 'pickup');
  if (pickupStops.length > 1) {
    steps.push({
      order: steps.length + 1,
      type: 'damage_photo',
      label: 'Each trailer load',
      hint: `This load has ${pickupStops.length} pickups. Photograph and seal each one separately.`,
      camera: true,
      signature: false,
    });
  }

  return steps;
}

export function deliveryCaptureSteps(load: Load): CaptureStep[] {
  const steps: CaptureStep[] = [
    {
      order: 1,
      type: 'pod',
      label: 'Signed POD',
      hint: 'Get a signature from the receiver, write their name and the piece count.',
      camera: true,
      signature: true,
    },
    {
      order: 2,
      type: 'damage_photo',
      label: 'Unloaded freight',
      hint: 'Photograph the freight as it sits after unloading. Skip if nothing is unusual.',
      camera: true,
      signature: false,
    },
    {
      order: 3,
      type: 'tif',
      label: 'Any citations',
      hint: 'Only if you were cited. Photograph the citation.',
      camera: true,
      signature: false,
    },
  ];

  const deliveryStops = (load.stops ?? []).filter((stop) => stop.type === 'delivery');
  if (deliveryStops.length > 1) {
    steps.push({
      order: steps.length + 1,
      type: 'pod',
      label: 'POD for every stop',
      hint: `This load has ${deliveryStops.length} deliveries. Each one needs its own signed POD.`,
      camera: true,
      signature: true,
    });
  }

  return steps;
}

/** Progress through the capture flow, for the driver's checklist screen. */
export function captureProgress(
  load: Load,
): { required: number; done: number; percent: number; missing: string[] } {
  const checklist = buildChecklist(load);
  const missing = checklist.required.filter((item) => !item.satisfied).map((item) => item.label);
  const total = checklist.required.length;
  const done = total - missing.length;
  return {
    required: total,
    done,
    percent: total > 0 ? Math.round((done / total) * 100) : 100,
    missing,
  };
}

/** Documents still missing for a load, for the dashboard's exception tile. */
export function outstandingDocuments(
  loads: readonly Load[],
): Array<{ load: Load; missing: string[]; blockers: string[] }> {
  const out: Array<{ load: Load; missing: string[]; blockers: string[] }> = [];

  for (const load of loads) {
    if (load.cancelledAt) continue;
    const checklist = buildChecklist(load);
    if (checklist.missing.length === 0) continue;
    out.push({
      load,
      missing: checklist.missing.map((item) => item.label),
      blockers: checklist.blockers,
    });
  }

  return out;
}

/** Equipment needs a different BOL wording when the trailer is a tanker. */
export function bolWordingFor(equipment: TrailerType | undefined): {
  header: string;
  additionalFields: string[];
} {
  switch (equipment) {
    case 'tanker':
      return {
        header: 'Bill of Lading - Bulk Shipment',
        additionalFields: ['Commodity code', 'UN/NA number', 'Gross gallons', 'Seal and valve condition'],
      };
    case 'reefer':
      return {
        header: 'Bill of Lading - Temperature Controlled',
        additionalFields: ['Set temperature', 'Pre-cooled at pickup', 'Continuous temperature log'],
      };
    case 'flatbed':
    case 'step_deck':
      return {
        header: 'Bill of Lading - Flatbed',
        additionalFields: ['Tarps and straps count', 'Overhang declared', 'Load securement confirmed'],
      };
    case 'power_only':
      return {
        header: 'Bill of Lading - Power Only',
        additionalFields: ['Trailer supplied by shipper', 'Trailer number', 'Exemption reference'],
      };
    case 'box_truck':
      return {
        header: 'Bill of Lading - Box Truck',
        additionalFields: ['Pallet count', 'Driver assist count'],
      };
    default:
      return { header: 'Bill of Lading', additionalFields: ['Piece count', 'Pallet count'] };
  }
}

/** Is this stop the last piece of work on the load? */
export function isLastStop(load: Load, stopId: string): boolean {
  const stops = load.stops ?? [];
  const index = stops.findIndex((stop) => stop.id === stopId);
  if (index < 0) return false;
  return index === stops.length - 1;
}

export type { LoadStop };