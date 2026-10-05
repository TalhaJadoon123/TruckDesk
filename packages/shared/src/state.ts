import type { Load, LoadStop, Truck } from './types.js';

/* -------------------------------------------------------------------------- */
/* Load state machine                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `Load.status` is the five-value union pinned by the spec, so cancellation is
 * modelled as a flag on the load rather than a seventh status. Keeping the
 * union intact means an existing consumer that switches on `status` keeps
 * compiling, which is the whole point of pinning it.
 */
export const LOAD_STATUSES = ['booked', 'dispatched', 'in-transit', 'delivered', 'paid'] as const;
export type LoadStatus = Load['status'];

export const LOAD_TRANSITIONS: Record<LoadStatus, readonly LoadStatus[]> = {
  booked: ['dispatched'],
  dispatched: ['in-transit', 'booked'],
  'in-transit': ['delivered', 'dispatched'],
  delivered: ['paid', 'in-transit'],
  paid: [],
};

/** `dispatched -> booked` is the unassign edge; `in-transit -> dispatched` is a dispatch correction. */
export const BACKWARD_LOAD_TRANSITIONS: readonly LoadStatus[] = ['booked', 'dispatched'];

export function canTransitionLoad(from: LoadStatus, to: LoadStatus): boolean {
  return LOAD_TRANSITIONS[from].includes(to);
}

export function assertLoadTransition(from: LoadStatus, to: LoadStatus): void {
  if (!canTransitionLoad(from, to)) {
    throw new Error(`Illegal load transition ${from} -> ${to}`);
  }
}

export function nextLoadStatuses(from: LoadStatus): readonly LoadStatus[] {
  return LOAD_TRANSITIONS[from];
}

export function isLoadActive(status: LoadStatus): boolean {
  return status === 'dispatched' || status === 'in-transit';
}

/** A load is settled only once it is marked paid; a delivered load is not cash. */
export function isLoadClosed(load: Pick<Load, 'status'> & { cancelledAt?: string }): boolean {
  return load.status === 'paid' || Boolean(load.cancelledAt);
}

export function canCancelLoad(load: Pick<Load, 'status'> & { cancelledAt?: string }): boolean {
  if (load.cancelledAt) return false;
  return load.status === 'booked' || load.status === 'dispatched';
}

/* -------------------------------------------------------------------------- */
/* Truck state machine                                                           */
/* -------------------------------------------------------------------------- */

export const TRUCK_STATUSES = ['available', 'loaded', 'empty', 'maintenance'] as const;
export type TruckStatus = Truck['status'];

export const TRUCK_TRANSITIONS: Record<TruckStatus, readonly TruckStatus[]> = {
  available: ['loaded', 'empty', 'maintenance'],
  loaded: ['empty', 'maintenance'],
  empty: ['loaded', 'available', 'maintenance'],
  maintenance: ['empty', 'available'],
};

export function canTransitionTruck(from: TruckStatus, to: TruckStatus): boolean {
  if (from === to) return true;
  return TRUCK_TRANSITIONS[from].includes(to);
}

export function assertTruckTransition(from: TruckStatus, to: TruckStatus): void {
  if (!canTransitionTruck(from, to)) {
    throw new Error(`Illegal truck transition ${from} -> ${to}`);
  }
}

/**
 * Board column a truck belongs in once it is carrying this load. `booked` and
 * `dispatched` both mean the trailer is still empty at the pickup, so both
 * map to `empty`; only a picked-up load puts the truck in `loaded`.
 */
export function truckStatusForLoad(loadStatus: LoadStatus): TruckStatus {
  switch (loadStatus) {
    case 'booked':
    case 'dispatched':
      return 'empty';
    case 'in-transit':
      return 'loaded';
    case 'delivered':
    case 'paid':
      return 'empty';
    default:
      return 'available';
  }
}

/* -------------------------------------------------------------------------- */
/* Stop lifecycle                                                                */
/* -------------------------------------------------------------------------- */

export const STOP_STATUSES = ['pending', 'arrived', 'completed', 'skipped'] as const;
export type StopStatus = LoadStop['status'];

export const STOP_TRANSITIONS: Record<StopStatus, readonly StopStatus[]> = {
  pending: ['arrived', 'completed', 'skipped'],
  arrived: ['completed', 'skipped'],
  completed: [],
  skipped: [],
};

export function canTransitionStop(from: StopStatus, to: StopStatus): boolean {
  return from === to ? false : STOP_TRANSITIONS[from].includes(to);
}

/** Stops must be worked in sequence; a driver cannot deliver before the pickup. */
export function canCompleteStop(
  stops: readonly LoadStop[],
  stopId: string,
): { allowed: boolean; reason?: string } {
  const target = stops.find((stop) => stop.id === stopId);
  if (!target) return { allowed: false, reason: 'Stop not found on this load' };
  if (target.status !== 'arrived') {
    return { allowed: false, reason: `Stop must be marked arrived first (currently ${target.status})` };
  }

  const sorted = [...stops].sort((a, b) => a.sequence - b.sequence);
  const index = sorted.findIndex((stop) => stop.id === stopId);
  for (let i = 0; i < index; i += 1) {
    const earlier = sorted[i];
    if (earlier && earlier.status !== 'completed' && earlier.status !== 'skipped') {
      return {
        allowed: false,
        reason: `Stop ${earlier.sequence} (${earlier.type}) must be completed first`,
      };
    }
  }
  return { allowed: true };
}