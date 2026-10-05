import type {
  Cents,
  DomainEvent,
  Driver,
  Iso,
  Load,
  LoadDocument,
  LoadStop,
  Truck,
} from '@truckdesk/shared';

import type { Invoice, Settlement } from '@truckdesk/core';

/**
 * Repository ports.
 *
 * `packages/api` implements these with Drizzle. Tests implement them with
 * in-memory maps. `core` never imports a repository, which is what keeps the
 * domain testable without a database.
 */

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface LoadQuery {
  companyId?: string;
  status?: Load['status'][];
  broker?: string;
  assignedTruckId?: string;
  assignedDriverId?: string;
  unassigned?: boolean;
  originContains?: string;
  destinationContains?: string;
  pickupBetween?: [Iso, Iso];
  deliveryBetween?: [Iso, Iso];
  bookedAfter?: Iso;
  bookedBefore?: Iso;
  cancelled?: boolean;
  minRateCents?: Cents;
  maxRateCents?: Cents;
  search?: string;
  limit?: number;
  offset?: number;
  sort?: 'pickup' | 'rate' | 'miles' | 'booked' | 'destination';
}

export interface LoadRepository {
  create(load: Load, events?: readonly DomainEvent[]): Promise<Load>;
  update(load: Load, events?: readonly DomainEvent[]): Promise<Load>;
  /**
   * Insert or replace by id. Used by the seeder and by the offline replay path,
   * where the client owns the primary key and may have already been applied.
   */
  upsertLoad(load: Load): Promise<Load>;
  findById(id: string): Promise<Load | null>;
  /** Batch fetch. Order is not guaranteed; callers key by id. */
  findManyByIds(ids: readonly string[]): Promise<Load[]>;
  query(q: LoadQuery): Promise<Page<Load>>;
  delete(id: string): Promise<boolean>;

  /** Insert-or-ignore by id. This is the offline-replay entry point. */
  upsertMany(loads: readonly Load[], events?: readonly DomainEvent[]): Promise<{
    inserted: string[];
    existing: string[];
  }>;

  withStops(load: Load): Promise<Load>;
}

export interface TruckRepository {
  create(truck: Truck): Promise<Truck>;
  update(truck: Truck): Promise<Truck>;
  upsertTruck(truck: Truck): Promise<Truck>;
  findById(id: string): Promise<Truck | null>;
  findManyByIds(ids: readonly string[]): Promise<Truck[]>;
  query(companyId?: string, options?: { status?: Truck['status'][] }): Promise<Truck[]>;
  /** Update position without a full record read; called on every GPS ping. */
  updatePosition(id: string, location: { lat: number; lng: number }, at: Iso): Promise<boolean>;
}

export interface DriverRepository {
  create(driver: Driver): Promise<Driver>;
  update(driver: Driver): Promise<Driver>;
  upsertDriver(driver: Driver): Promise<Driver>;
  findById(id: string): Promise<Driver | null>;
  findManyByIds(ids: readonly string[]): Promise<Driver[]>;
  query(companyId?: string, options?: { status?: Driver['status'][] }): Promise<Driver[]>;
  findByUserId(userId: string): Promise<Driver | null>;
}

export interface DocumentRepository {
  attach(document: LoadDocument): Promise<LoadDocument>;
  upsertDocument(document: LoadDocument): Promise<LoadDocument>;
  findForLoad(loadId: string): Promise<LoadDocument[]>;
  findById(id: string): Promise<LoadDocument | null>;
  markRejected(id: string, reason: string): Promise<LoadDocument | null>;
}

export interface EventRepository {
  append(events: readonly DomainEvent[]): Promise<void>;
  query(companyId?: string, options?: { entityId?: string; since?: Iso; limit?: number }): Promise<DomainEvent[]>;
}

export interface InvoiceRepository {
  create(invoice: Invoice): Promise<Invoice>;
  update(invoice: Invoice): Promise<Invoice>;
  findById(id: string): Promise<Invoice | null>;
  findByNumber(number: string): Promise<Invoice | null>;
  query(companyId?: string, options?: { broker?: string; openOnly?: boolean }): Promise<Invoice[]>;
  /** Every load id already attached to an invoice, for double-billing checks. */
  invoicedLoadIds(): Promise<string[]>;
}

export interface SettlementRepository {
  create(settlement: Settlement): Promise<Settlement>;
  update(settlement: Settlement): Promise<Settlement>;
  findById(id: string): Promise<Settlement | null>;
  findByDriverWeek(driverId: string, weekKey: string): Promise<Settlement | null>;
  query(companyId?: string, options?: { driverId?: string; status?: Settlement['status'] }): Promise<Settlement[]>;
}

export interface FuelEntry {
  id: string;
  companyId?: string;
  truckId: string;
  driverId?: string;
  loadId?: string;
  gallons: number;
  priceCentsPerGallon: Cents;
  totalCents: Cents;
  odometerMiles?: number;
  location?: { lat: number; lng: number };
  /** The tax jurisdiction where the fuel was bought; IFTA credits come from here. */
  jurisdictionCode?: string;
  at: Iso;
  receiptStorageKey?: string;
  cardLast4?: string;
  isPrepaid?: boolean;
  note?: string;
}

export interface FuelRepository {
  create(entry: FuelEntry): Promise<FuelEntry>;
  upsertFuel(entry: FuelEntry): Promise<FuelEntry>;
  query(companyId: string, options?: { truckId?: string; between?: [Iso, Iso] }): Promise<FuelEntry[]>;
}

/* -------------------------------------------------------------------------- */
/* In-memory implementation, used by tests and by the demo seeder                */
/* -------------------------------------------------------------------------- */

export class InMemoryRepositories {
  readonly loads = new Map<string, Load>();
  readonly trucks = new Map<string, Truck>();
  readonly drivers = new Map<string, Driver>();
  readonly documents = new Map<string, LoadDocument>();
  readonly events: DomainEvent[] = [];
  readonly invoices = new Map<string, Invoice>();
  readonly settlements = new Map<string, Settlement>();
  readonly fuel: FuelEntry[] = [];

  readonly loadRepo: LoadRepository = {
    create: async (load, events) => {
      this.loads.set(load.id, structuredClone(load));
      if (events) this.events.push(...structuredClone(events));
      return structuredClone(load);
    },
    update: async (load, events) => {
      this.loads.set(load.id, structuredClone(load));
      if (events) this.events.push(...structuredClone(events));
      return structuredClone(load);
    },
    upsertLoad: async (load) => {
      this.loads.set(load.id, structuredClone(load));
      return structuredClone(load);
    },
    findById: async (id) => {
      const load = this.loads.get(id);
      return load ? structuredClone(load) : null;
    },
    findManyByIds: async (ids) =>
      ids
        .map((id) => this.loads.get(id))
        .filter((load): load is Load => Boolean(load))
        .map((load) => structuredClone(load)),
    query: async (q) => {
      const filtered = [...this.loads.values()].filter((load) => matches(load, q));
      const offset = q.offset ?? 0;
      const limit = q.limit ?? 50;
      return {
        items: filtered.slice(offset, offset + limit).map((load) => structuredClone(load)),
        total: filtered.length,
        limit,
        offset,
      };
    },
    delete: async (id) => this.loads.delete(id),
    upsertMany: async (loads, events) => {
      const inserted: string[] = [];
      const existing: string[] = [];
      for (const load of loads) {
        if (this.loads.has(load.id)) existing.push(load.id);
        else {
          inserted.push(load.id);
          this.loads.set(load.id, structuredClone(load));
        }
      }
      if (events) this.events.push(...structuredClone(events));
      return { inserted, existing };
    },
    withStops: async (load) => structuredClone(load),
  };

  readonly truckRepo: TruckRepository = {
    create: async (truck) => {
      this.trucks.set(truck.id, structuredClone(truck));
      return structuredClone(truck);
    },
    update: async (truck) => {
      this.trucks.set(truck.id, structuredClone(truck));
      return structuredClone(truck);
    },
    upsertTruck: async (truck) => {
      this.trucks.set(truck.id, structuredClone(truck));
      return structuredClone(truck);
    },
    findById: async (id) => {
      const truck = this.trucks.get(id);
      return truck ? structuredClone(truck) : null;
    },
    findManyByIds: async (ids) =>
      ids
        .map((id) => this.trucks.get(id))
        .filter((t): t is Truck => Boolean(t))
        .map((t) => structuredClone(t)),
    query: async (companyId, options) =>
      [...this.trucks.values()]
        .filter((truck) => !companyId || truck.companyId === companyId)
        .filter((truck) => !options?.status || options.status.includes(truck.status))
        .map((truck) => structuredClone(truck)),
    updatePosition: async (id, location, at) => {
      const truck = this.trucks.get(id);
      if (!truck) return false;
      this.trucks.set(id, { ...truck, location, lastKnownAt: at });
      return true;
    },
  };

  readonly driverRepo: DriverRepository = {
    create: async (driver) => {
      this.drivers.set(driver.id, structuredClone(driver));
      return structuredClone(driver);
    },
    update: async (driver) => {
      this.drivers.set(driver.id, structuredClone(driver));
      return structuredClone(driver);
    },
    upsertDriver: async (driver) => {
      this.drivers.set(driver.id, structuredClone(driver));
      return structuredClone(driver);
    },
    findById: async (id) => {
      const driver = this.drivers.get(id);
      return driver ? structuredClone(driver) : null;
    },
    findManyByIds: async (ids) =>
      ids
        .map((id) => this.drivers.get(id))
        .filter((d): d is Driver => Boolean(d))
        .map((d) => structuredClone(d)),
    query: async (companyId, options) =>
      [...this.drivers.values()]
        .filter((driver) => !companyId || driver.companyId === companyId)
        .filter((driver) => !options?.status || options.status.includes(driver.status))
        .map((driver) => structuredClone(driver)),
    findByUserId: async (userId) => {
      const driver = [...this.drivers.values()].find((d) => d.userId === userId);
      return driver ? structuredClone(driver) : null;
    },
  };

  readonly documentRepo: DocumentRepository = {
    attach: async (document) => {
      this.documents.set(document.id, structuredClone(document));
      return structuredClone(document);
    },
    upsertDocument: async (document) => {
      this.documents.set(document.id, structuredClone(document));
      return structuredClone(document);
    },
    findForLoad: async (loadId) =>
      [...this.documents.values()]
        .filter((doc) => doc.loadId === loadId)
        .map((doc) => structuredClone(doc)),
    findById: async (id) => {
      const document = this.documents.get(id);
      return document ? structuredClone(document) : null;
    },
    markRejected: async (id, reason) => {
      const document = this.documents.get(id);
      if (!document) return null;
      const updated: LoadDocument = { ...document, status: 'rejected', rejectReason: reason };
      this.documents.set(id, updated);
      return structuredClone(updated);
    },
  };

  readonly eventRepo: EventRepository = {
    append: async (events) => {
      this.events.push(...structuredClone(events));
    },
    query: async (companyId, options) =>
      this.events
        .filter((event) => !companyId || event.companyId === companyId)
        .filter((event) => !options?.entityId || event.entityId === options.entityId)
        .filter((event) => !options?.since || event.occurredAt >= (options.since ?? ''))
        .slice(-(options?.limit ?? 100))
        .map((event) => structuredClone(event)),
  };

  readonly invoiceRepo: InvoiceRepository = {
    create: async (invoice) => {
      this.invoices.set(invoice.id, structuredClone(invoice));
      return structuredClone(invoice);
    },
    update: async (invoice) => {
      this.invoices.set(invoice.id, structuredClone(invoice));
      return structuredClone(invoice);
    },
    findById: async (id) => {
      const invoice = this.invoices.get(id);
      return invoice ? structuredClone(invoice) : null;
    },
    findByNumber: async (number) => {
      const invoice = [...this.invoices.values()].find((i) => i.number === number);
      return invoice ? structuredClone(invoice) : null;
    },
    query: async (companyId, options) =>
      [...this.invoices.values()]
        .filter((invoice) => !companyId || invoice.companyId === companyId)
        .filter((invoice) => !options?.broker || invoice.brokerName === options.broker)
        .filter((invoice) => !options?.openOnly || invoice.balanceCents > 0)
        .map((invoice) => structuredClone(invoice)),
    invoicedLoadIds: async () => [...this.invoices.values()].flatMap((invoice) => invoice.loadIds),
  };
  readonly settlementRepo: SettlementRepository = {
    create: async (settlement) => {
      this.settlements.set(settlement.id, structuredClone(settlement));
      return structuredClone(settlement);
    },
    update: async (settlement) => {
      this.settlements.set(settlement.id, structuredClone(settlement));
      return structuredClone(settlement);
    },
    findById: async (id) => {
      const settlement = this.settlements.get(id);
      return settlement ? structuredClone(settlement) : null;
    },
    findByDriverWeek: async (driverId, weekKey) => {
      const settlement = [...this.settlements.values()].find(
        (s) => s.driverId === driverId && s.week.key === weekKey,
      );
      return settlement ? structuredClone(settlement) : null;
    },
    query: async (companyId, options) =>
      [...this.settlements.values()]
        .filter((settlement) => !companyId || settlement.companyId === companyId)
        .filter((settlement) => !options?.driverId || settlement.driverId === options.driverId)
        .filter((settlement) => !options?.status || settlement.status === options.status)
        .map((settlement) => structuredClone(settlement)),
  };

  readonly fuelRepo: FuelRepository = {
    upsertFuel: async (entry) => {
      const index = this.fuel.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) this.fuel[index] = structuredClone(entry);
      else this.fuel.push(structuredClone(entry));
      return structuredClone(entry);
    },
    create: async (entry) => {
      this.fuel.push(structuredClone(entry));
      return structuredClone(entry);
    },
    query: async (companyId, options) =>
      this.fuel
        .filter((entry) => entry.companyId === companyId)
        .filter((entry) => !options?.truckId || entry.truckId === options.truckId)
        .filter(
          (entry) =>
            !options?.between ||
            (entry.at >= (options.between[0] ?? '') && entry.at <= (options.between[1] ?? '')),
        )
        .map((entry) => structuredClone(entry)),
  };

  /** Flatten a load with its documents attached, as the API returns it. */
  async hydrateLoad(loadId: string): Promise<Load | null> {
    const load = await this.loadRepo.findById(loadId);
    if (!load) return null;
    const documents = await this.documentRepo.findForLoad(loadId);
    return { ...load, documents };
  }

  /** Stop list, used by tests that assert on the built stops. */
  stopsFor(loadId: string): LoadStop[] {
    const load = this.loads.get(loadId);
    return load?.stops ?? [];
  }
}

function matches(load: Load, q: LoadQuery): boolean {
  if (q.companyId && load.companyId !== q.companyId) return false;
  if (q.status && q.status.length > 0 && !q.status.includes(load.status)) return false;
  if (q.broker && load.broker !== q.broker) return false;
  if (q.assignedTruckId && load.assignedTruckId !== q.assignedTruckId) return false;
  if (q.assignedDriverId && load.assignedDriverId !== q.assignedDriverId) return false;
  if (q.unassigned && load.assignedTruckId) return false;
  if (Boolean(q.cancelled) !== Boolean(load.cancelledAt)) {
    if (q.cancelled !== undefined) return false;
  }
  if (q.minRateCents !== undefined && load.rate < q.minRateCents) return false;
  if (q.maxRateCents !== undefined && load.rate > q.maxRateCents) return false;

  if (q.originContains && !load.origin.toLowerCase().includes(q.originContains.toLowerCase())) {
    return false;
  }
  if (
    q.destinationContains &&
    !load.destination.toLowerCase().includes(q.destinationContains.toLowerCase())
  ) {
    return false;
  }

  if (q.search) {
    const needle = q.search.toLowerCase();
    const haystack = `${load.broker} ${load.origin} ${load.destination} ${load.reference ?? ''} ${load.commodity ?? ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  if (q.pickupBetween) {
    if (!load.pickupDate) return false;
    if (load.pickupDate < q.pickupBetween[0] || load.pickupDate > q.pickupBetween[1]) return false;
  }
  if (q.deliveryBetween) {
    if (!load.deliveryDate) return false;
    if (load.deliveryDate < q.deliveryBetween[0] || load.deliveryDate > q.deliveryBetween[1]) return false;
  }
  if (q.bookedAfter && (!load.bookedAt || load.bookedAt < q.bookedAfter)) return false;
  if (q.bookedBefore && (!load.bookedAt || load.bookedAt > q.bookedBefore)) return false;

  return true;
}
