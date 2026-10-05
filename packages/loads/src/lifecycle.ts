import {
  Errors,
  canTransitionStop,
  err,
  ok,
  type Cents,
  type DomainEvent,
  type Driver,
  type Iso,
  type Load,
  type LoadDocument,
  type LoadStop,
  type Result,
  type TrailerType,
  uuid,
} from '@truckdesk/shared';

/**
 * Load lifecycle: creating a load properly, building its stop list, working the
 * stops in order, and closing it out.
 *
 * The dispatcher experience is "an email arrives and a board row appears". The
 * field experience is "I am standing in a yard and I need to mark arrived,
 * unload, photograph the BOL, sign, done". Both are expressed here.
 */

/* -------------------------------------------------------------------------- */
/* Creation                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateStopInput {
  id?: string;
  type: LoadStop['type'];
  facilityName: string;
  address: string;
  city: string;
  state: string;
  postalCode?: string;
  location?: { lat: number; lng: number };
  window?: LoadStop['window'];
  appointmentRequired?: boolean;
  appointmentRef?: string;
  contactName?: string;
  contactPhone?: string;
  notes?: string;
}

export interface CreateLoadInput {
  broker: string;
  origin: string;
  destination: string;
  /** All-in rate in USD cents. */
  rate: Cents;
  miles: number;
  companyId?: string;
  reference?: string;
  commodity?: string;
  weightLbs?: number;
  equipment?: TrailerType;
  pickupDate?: Iso;
  deliveryDate?: Iso;
  pickupWindow?: LoadStop['window'];
  deliveryWindow?: LoadStop['window'];
  linehaulCents?: Cents;
  fuelSurchargeCents?: Cents;
  accessorialCents?: Cents;
  rateType?: Load['rateType'];
  quickPayEligible?: boolean;
  source?: Load['source'];
  notes?: string;
  stops?: CreateStopInput[];
  id?: string;
  now?: Iso;
  actorId?: string;
}

export interface CreatedLoad {
  load: Load;
  events: DomainEvent[];
  /** Fields the parser or dispatcher still needs to fill in. */
  missing: string[];
}

/**
 * Split an all-in rate into linehaul and fuel when the broker did not.
 *
 * A driver on percentage pay earns on linehaul only: the fuel surcharge is the
 * broker paying for fuel, not paying the driver. `settlement.payForLoad` and
 * `core.projectDriverPayCents` both depend on this split agreeing.
 */
export function splitRate(
  rate: Cents,
  miles: number,
  fuelSurchargeCents?: Cents,
): { linehaulCents: Cents; fuelSurchargeCents: Cents } {
  if (fuelSurchargeCents !== undefined && fuelSurchargeCents > 0) {
    return {
      linehaulCents: Math.max(0, rate - fuelSurchargeCents),
      fuelSurchargeCents,
    };
  }

  // DOE weekly index runs roughly $0.20-$0.50/mi; use a conservative mid
  // figure so the split does not overstate linehaul on a dry-van rate.
  const surchargePerMileCents = 21;
  const estimatedSurcharge = Math.min(Math.round(rate * 0.2), Math.round(miles * surchargePerMileCents));
  return {
    linehaulCents: Math.max(0, rate - estimatedSurcharge),
    fuelSurchargeCents: estimatedSurcharge,
  };
}

/**
 * Brokers write a delivery *date* ("deliver 03/18") far more often than a
 * delivery *time*. Parsed literally that is midnight, which makes a same-day
 * delivery look earlier than a pickup at 08:00 and gets the load rejected.
 *
 * A value with no time component therefore means "by the end of that day", and
 * is pushed to 23:59:59 before it is compared.
 */
function endOfDayIfDateOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes('T')) return value;

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;

  parsed.setUTCHours(23, 59, 59, 999);
  return parsed.toISOString();
}

export function createLoad(input: CreateLoadInput): Result<CreatedLoad> {
  const now = input.now ?? new Date().toISOString();
  const missing: string[] = [];

  const broker = input.broker?.trim();
  if (!broker) return err(Errors.invalidInput('A load needs a broker'));

  const origin = input.origin?.trim();
  const destination = input.destination?.trim();
  if (!origin) return err(Errors.invalidInput('A load needs an origin'));
  if (!destination) return err(Errors.invalidInput('A load needs a destination'));

  if (!Number.isFinite(input.rate) || input.rate <= 0) {
    return err(Errors.invalidInput('Rate must be greater than zero'));
  }
  if (!Number.isFinite(input.miles) || input.miles <= 0) {
    return err(Errors.invalidInput('Miles must be greater than zero'));
  }

  if (origin.toLowerCase() === destination.toLowerCase()) {
    return err(Errors.invalidInput('Origin and destination are identical'));
  }

  const pickupDate = input.pickupDate;
  const deliveryDate = endOfDayIfDateOnly(input.deliveryDate);

  if (pickupDate && deliveryDate) {
    if (Date.parse(deliveryDate) < Date.parse(pickupDate)) {
      return err(
        Errors.invalidInput('Delivery date is before the pickup date', {
          pickupDate,
          deliveryDate,
        }),
      );
    }
  }

  if (!input.pickupDate) missing.push('pickupDate');
  if (!input.commodity) missing.push('commodity');
  if (!input.weightLbs) missing.push('weightLbs');

  const { linehaulCents, fuelSurchargeCents } = splitRate(
    input.rate,
    input.miles,
    input.fuelSurchargeCents,
  );

  const stops = buildStops(input, origin, destination);
  const load: Load = {
    id: input.id ?? `ld_${uuid().slice(0, 12)}`,
    broker,
    origin,
    destination,
    rate: Math.round(input.rate),
    miles: Math.round(input.miles),
    status: 'booked',
    companyId: input.companyId,
    reference: input.reference,
    commodity: input.commodity,
    weightLbs: input.weightLbs,
    equipment: input.equipment,
    pickupDate,
    deliveryDate,
    pickupWindow: input.pickupWindow,
    deliveryWindow: input.deliveryWindow,
    bookedAt: now,
    linehaulCents: input.linehaulCents ?? linehaulCents,
    fuelSurchargeCents: input.fuelSurchargeCents ?? fuelSurchargeCents,
    accessorialCents: input.accessorialCents,
    rateType: input.rateType ?? 'flat',
    quickPayEligible: input.quickPayEligible ?? true,
    source: input.source ?? 'manual',
    notes: input.notes,
    stops,
  };

  const events: DomainEvent[] = [
    {
      id: uuid(),
      type: 'load.created',
      entityType: 'load',
      entityId: load.id,
      payload: {
        broker,
        origin,
        destination,
        rate: load.rate,
        miles: load.miles,
        source: load.source,
        stopCount: stops.length,
      },
      actorId: input.actorId,
      occurredAt: now,
    },
  ];

  return ok({ load, events, missing });
}

/**
 * Build the stop list. When the caller supplies stops we honour their order;
 * otherwise we synthesise the two-stop shape most loads actually have.
 */
export function buildStops(
  input: CreateLoadInput,
  origin: string,
  destination: string,
): LoadStop[] {
  if (input.stops && input.stops.length > 0) {
    return input.stops
      .map((stop, index) => ({
        id: stop.id ?? `st_${uuid().slice(0, 12)}`,
        loadId: input.id ?? '',
        type: stop.type,
        sequence: index,
        facilityName: stop.facilityName,
        address: stop.address,
        city: stop.city,
        state: stop.state,
        postalCode: stop.postalCode,
        location: stop.location,
        window: stop.window,
        appointmentRequired: stop.appointmentRequired,
        appointmentRef: stop.appointmentRef,
        contactName: stop.contactName,
        contactPhone: stop.contactPhone,
        status: 'pending' as const,
        notes: stop.notes,
      }))
      .map((stop) => ({ ...stop, loadId: input.id ?? stop.loadId }));
  }

  const originParts = parseLocation(origin);
  const destinationParts = parseLocation(destination);
  const loadId = input.id ?? '';

  const stops: LoadStop[] = [
    {
      id: `st_${uuid().slice(0, 12)}`,
      loadId,
      type: 'pickup',
      sequence: 0,
      facilityName: originParts.facilityName,
      address: origin,
      city: originParts.city,
      state: originParts.state,
      postalCode: originParts.postalCode,
      window: input.pickupWindow,
      appointmentRequired: Boolean(input.pickupWindow),
      status: 'pending',
    },
    {
      id: `st_${uuid().slice(0, 12)}`,
      loadId,
      type: 'delivery',
      sequence: 1,
      facilityName: destinationParts.facilityName,
      address: destination,
      city: destinationParts.city,
      state: destinationParts.state,
      postalCode: destinationParts.postalCode,
      window: input.deliveryWindow,
      appointmentRequired: Boolean(input.deliveryWindow),
      status: 'pending',
    },
  ];

  return stops;
}

export function parseLocation(input: string): {
  facilityName: string;
  city: string;
  state: string;
  postalCode?: string;
} {
  const parts = input.split(',').map((part) => part.trim());
  const city = parts[0] ?? '';
  const second = parts[1] ?? '';
  const stateMatch = /([A-Z]{2})\s*(\d{5})?/.exec(second.toUpperCase());
  const state = stateMatch?.[1] ?? second.slice(0, 2).toUpperCase();
  const postalCode = stateMatch?.[2];

  // "Dallas, TX 75201" -> facility name is the city itself.
  const facilityName = parts.length > 2 ? (parts[2] ?? city) : city;

  return { facilityName, city, state, postalCode };
}

/* -------------------------------------------------------------------------- */
/* Stop workflow                                                                 */
/* -------------------------------------------------------------------------- */

export interface ArriveInput {
  loadId: string;
  stopId: string;
  at?: Iso;
  location?: { lat: number; lng: number };
  actorId?: string;
  notes?: string;
}

export interface CompleteStopInput extends ArriveInput {
  /** POD photo/scan. Delivery stops without one are flagged, not blocked. */
  documents?: LoadDocument[];
  signatureName?: string;
  receiverName?: string;
}

export interface StopTransitionResult {
  load: Load;
  stop: LoadStop;
  events: DomainEvent[];
  warnings: string[];
}

export function arriveAtStop(
  load: Load,
  input: ArriveInput,
): Result<StopTransitionResult> {
  const at = input.at ?? new Date().toISOString();
  const stop = findStop(load, input.stopId);
  if (!stop) return err(Errors.notFound('Stop', input.stopId));

  if (stop.status !== 'pending') {
    return err(
      Errors.invalidState(`Stop is already ${stop.status}; cannot mark arrived`, {
        loadId: load.id,
        stopId: stop.id,
      }),
    );
  }
  if (!canTransitionStop(stop.status, 'arrived')) {
    return err(Errors.invalidState(`Illegal stop transition ${stop.status} -> arrived`));
  }

  const updated: LoadStop = {
    ...stop,
    status: 'arrived',
    arrivedAt: at,
    location: input.location ?? stop.location,
    notes: input.notes ?? stop.notes,
  };

  const events: DomainEvent[] = [
    {
      id: uuid(),
      type: 'load.status_changed',
      entityType: 'load',
      entityId: load.id,
      payload: { stopId: stop.id, to: 'arrived', at },
      actorId: input.actorId,
      occurredAt: at,
    },
  ];

  return ok({
    load: { ...load, stops: replaceStop(load, updated) },
    stop: updated,
    events,
    warnings: arrivalWarnings(updated, load),
  });
}

export function completeStop(
  load: Load,
  input: CompleteStopInput,
): Result<StopTransitionResult> {
  const at = input.at ?? new Date().toISOString();
  const stop = findStop(load, input.stopId);
  if (!stop) return err(Errors.notFound('Stop', input.stopId));

  const warnings: string[] = [];

  if (stop.status === 'pending') {
    // Auto-mark arrived: the driver tapping "done" at the dock means both.
    warnings.push('Stop was completed without marking arrival first');
    stop.arrivedAt = at;
  }
  if (!canTransitionStop(stop.status, 'arrived') && stop.status !== 'arrived') {
    return err(
      Errors.invalidState(`Illegal stop transition ${stop.status} -> completed`, {
        loadId: load.id,
        stopId: stop.id,
      }),
    );
  }

  const hasProof = (input.documents ?? []).some(
    (doc) => doc.type === 'pod' || doc.type === 'bol',
  );

  if (stop.type === 'delivery') {
    if (!hasProof && !(input.signatureName ?? '').trim()) {
      warnings.push('Delivery completed with no POD and no receiver signature');
    }
    if (hasProof && !(input.signatureName ?? '').trim()) {
      warnings.push('Delivery completed without a receiver name');
    }
  }

  const updated: LoadStop = {
    ...stop,
    status: 'completed',
    completedAt: at,
    notes: input.notes ?? stop.notes,
  };

  const documents = [...(load.documents ?? []), ...(input.documents ?? [])];
  const nextLoad: Load = {
    ...load,
    stops: replaceStop(load, updated),
    documents,
    // The final delivery completing is what stamps the load delivered.
    ...(isFinalDelivery(load, updated) ? { status: 'in-transit' as const } : {}),
  };

  const events: DomainEvent[] = [
    {
      id: uuid(),
      type: 'load.status_changed',
      entityType: 'load',
      entityId: load.id,
      payload: { stopId: stop.id, to: 'completed', at, hasProof },
      actorId: input.actorId,
      occurredAt: at,
    },
  ];

  for (const document of input.documents ?? []) {
    events.push({
      id: uuid(),
      type: 'document.uploaded',
      entityType: 'document',
      entityId: document.id,
      payload: { loadId: load.id, type: document.type, fileName: document.fileName },
      actorId: input.actorId,
      occurredAt: at,
    });
  }

  return ok({ load: nextLoad, stop: updated, events, warnings });
}

export function skipStop(
  load: Load,
  input: { stopId: string; reason: string; at?: Iso; actorId?: string },
): Result<StopTransitionResult> {
  const stop = findStop(load, input.stopId);
  if (!stop) return err(Errors.notFound('Stop', input.stopId));
  if (!canTransitionStop(stop.status, 'skipped')) {
    return err(Errors.invalidState(`Cannot skip a stop that is ${stop.status}`));
  }

  const updated: LoadStop = {
    ...stop,
    status: 'skipped',
    notes: input.reason,
    completedAt: input.at ?? new Date().toISOString(),
  };

  return ok({
    load: { ...load, stops: replaceStop(load, updated) },
    stop: updated,
    events: [
      {
        id: uuid(),
        type: 'load.status_changed',
        entityType: 'load',
        entityId: load.id,
        payload: { stopId: stop.id, to: 'skipped', reason: input.reason },
        actorId: input.actorId,
        occurredAt: updated.completedAt ?? new Date().toISOString(),
      },
    ],
    warnings: [],
  });
}

/** Is this the last open stop, and is it a delivery? */
export function isFinalDelivery(load: Load, completed: LoadStop): boolean {
  if (completed.type !== 'delivery') return false;
  const remaining = (load.stops ?? []).some(
    (stop) => stop.id !== completed.id && stop.type === 'delivery' && stop.status !== 'completed' && stop.status !== 'skipped',
  );
  return !remaining;
}

/** The driver's "what's next" screen. */
export function nextStop(load: Load): LoadStop | null {
  const open = (load.stops ?? [])
    .filter((stop) => stop.status === 'pending' || stop.status === 'arrived')
    .sort((a, b) => a.sequence - b.sequence);
  return open[0] ?? null;
}

export function remainingStops(load: Load): LoadStop[] {
  return (load.stops ?? [])
    .filter((stop) => stop.status === 'pending' || stop.status === 'arrived')
    .sort((a, b) => a.sequence - b.sequence);
}

/* -------------------------------------------------------------------------- */
/* Cancellation                                                                  */
/* -------------------------------------------------------------------------- */

export interface CancelResult {
  load: Load;
  events: DomainEvent[];
}

export function cancelLoad(
  load: Load,
  input: { reason: string; at?: Iso; actorId?: string; chargeCancellationFee?: boolean },
): Result<CancelResult> {
  const at = input.at ?? new Date().toISOString();

  if (load.cancelledAt) {
    return err(Errors.conflict('Load is already cancelled', { loadId: load.id }));
  }
  if (load.status === 'in-transit') {
    return err(
      Errors.invalidState('Cannot cancel a load in transit; contact the broker', { loadId: load.id }),
    );
  }
  if (load.status === 'delivered' || load.status === 'paid') {
    return err(Errors.invalidState(`Load is ${load.status} and cannot be cancelled`));
  }
  if (!input.reason.trim()) {
    return err(Errors.invalidInput('A cancellation reason is required'));
  }

  const events: DomainEvent[] = [
    {
      id: uuid(),
      type: 'load.cancelled',
      entityType: 'load',
      entityId: load.id,
      payload: {
        reason: input.reason,
        at,
        feeCharged: Boolean(input.chargeCancellationFee),
        brokerNotified: true,
      },
      actorId: input.actorId,
      occurredAt: at,
    },
  ];

  return ok({
    load: { ...load, cancelledAt: at, cancelReason: input.reason },
    events,
  });
}

/* -------------------------------------------------------------------------- */
/* Dispatch-ready check used before assigning                                    */
/* -------------------------------------------------------------------------- */

export interface DispatchReadinessReport {
  ready: boolean;
  missing: string[];
  blocking: string[];
  warnings: string[];
}

export function dispatchReadiness(load: Load, driver?: Driver): DispatchReadinessReport {
  const missing: string[] = [];
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (!load.pickupDate) missing.push('pickupDate');
  if (!load.commodity) missing.push('commodity');
  if (!load.weightLbs) missing.push('weightLbs');
  if (!(load.stops ?? []).length) missing.push('stops');

  if (load.proofOfDeliveryMissing) {
    warnings.push('Delivered without POD on file; the broker may hold payment');
  }

  if (driver) {
    if (driver.licenseExpiresAt && Date.parse(driver.licenseExpiresAt) < Date.parse(load.deliveredAt ?? new Date().toISOString())) {
      blocking.push(`${driver.name}'s licence expires before the delivery date`);
    }
    if (!driver.hazmatEndorsed && load.weightLbs && load.commodity?.toLowerCase().includes('hazmat')) {
      blocking.push(`${driver.name} is not hazmat endorsed and the load is hazmat`);
    }
    if (driver.licenseState && load.stops?.[0]?.state && driver.licenseState !== load.stops[0].state) {
      // Cross-state is fine; out-of-region driving restrictions are not our call.
      warnings.push(`Load runs in ${load.stops[0].state}; check local restrictions`);
    }
  }

  if (load.rate <= 0) blocking.push('No rate on this load');
  if (load.miles <= 0) blocking.push('No miles on this load');

  return { ready: blocking.length === 0, missing, blocking, warnings };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                       */
/* -------------------------------------------------------------------------- */

export function findStop(load: Load, stopId: string): LoadStop | null {
  return (load.stops ?? []).find((stop) => stop.id === stopId) ?? null;
}

function replaceStop(load: Load, updated: LoadStop): LoadStop[] {
  const stops = load.stops ?? [];
  return stops.map((stop) => (stop.id === updated.id ? { ...stop, ...updated } : stop));
}

function arrivalWarnings(stop: LoadStop, load: Load): string[] {
  const warnings: string[] = [];
  const now = new Date();

  if (stop.window?.start && stop.window.end) {
    if (now < new Date(stop.window.start)) {
      const earlyMinutes = Math.round((Date.parse(stop.window.start) - now.getTime()) / 60_000);
      warnings.push(
        `Arrived ${formatMinutes(earlyMinutes)} before the window opens at ${stop.window.start.slice(11, 16)} UTC`,
      );
    } else if (now > new Date(stop.window.end)) {
      const lateMinutes = Math.round((now.getTime() - Date.parse(stop.window.end)) / 60_000);
      warnings.push(
        `Arrived ${formatMinutes(lateMinutes)} after the window closed at ${stop.window.end.slice(11, 16)} UTC`,
      );
    }
  }

  if (load.pickupDate && stop.type === 'pickup' && Date.parse(load.pickupDate) < now.getTime() - 3_600_000) {
    warnings.push('Pickup appointment has already passed');
  }

  return warnings;
}

function formatMinutes(minutes: number): string {
  const abs = Math.abs(minutes);
  if (abs < 60) return `${abs}m`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}