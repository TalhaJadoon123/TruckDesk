import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';

import type { DomainEvent, Driver, Iso, Load, LoadDocument, LoadStop, Truck } from '@truckdesk/shared';
import type {
  DocumentRepository,
  DriverRepository,
  EventRepository,
  InvoiceRepository,
  LoadQuery,
  LoadRepository,
  Page,
  SettlementRepository,
  TruckRepository,
} from '@truckdesk/loads';
import type { Invoice, Settlement } from '@truckdesk/core';
import type { FuelEntry as FuelEntryRow } from '@truckdesk/loads';

import { requireDb, type Database } from './client.js';
import * as m from './mappers.js';
import {
  documents,
  drivers,
  events,
  fuelEntries,
  gpsPings,
  invoiceLines,
  invoices,
  loadStops,
  loads,
  payments,
  settlementLines,
  settlements,
  trucks,
} from './schema.js';

/**
 * Drizzle implementations of the repository ports.
 *
 * Every method takes the company id explicitly rather than reading it from a
 * request context. That is what makes a cross-tenant read impossible to write
 * by accident: if the caller forgets the tenant, it fails, rather than quietly
 * returning another company's freight.
 */

/* -------------------------------------------------------------------------- */
/* Loads                                                                         */
/* -------------------------------------------------------------------------- */

export class DrizzleLoadRepository implements LoadRepository {
  constructor(private readonly companyId: string) {}

  private get db(): Database {
    return requireDb();
  }

  async create(load: Load, domainEvents: readonly DomainEvent[] = []): Promise<Load> {
    const db = this.db;
    await db.transaction(async (tx) => {
      await tx.insert(loads).values(m.loadToRow(load) as never);
      await this.writeStops(tx as unknown as Database, load);
      await this.writeEvents(tx as unknown as Database, domainEvents);
    });
    return load;
  }

  async update(load: Load, domainEvents: readonly DomainEvent[] = []): Promise<Load> {
    const db = this.db;
    await db.transaction(async (tx) => {
      const row = m.loadToRow(load);
      delete row.id;
      delete row.companyId;
      await tx.update(loads).set(row as never).where(eq(loads.id, load.id));
      await this.writeStops(tx as unknown as Database, load);
      await this.writeEvents(tx as unknown as Database, domainEvents);
    });
    return load;
  }

  private async writeStops(db: Database, load: Load): Promise<void> {
    const stops = load.stops ?? [];
    if (stops.length === 0) return;

    // Stops are small and always written whole, so replace rather than diff.
    await db.delete(loadStops).where(eq(loadStops.loadId, load.id));
    await db.insert(loadStops).values(
      stops.map((stop) => m.stopToRow(stop, load.companyId ?? this.companyId) as never),
    );
  }

  /** Seeder and offline-replay upsert: replace on id conflict, keeping stops in sync. */
  async upsertLoad(load: Load): Promise<Load> {
    const db = this.db;
    await db.transaction(async (tx) => {
      const handle = tx as unknown as Database;
      await handle
        .insert(loads)
        .values(m.loadToRow(load) as never)
        .onConflictDoUpdate({ target: loads.id, set: m.loadToRow(load) as never });
      await this.writeStops(handle, load);
    });
    return load;
  }

  async findById(id: string): Promise<Load | null> {
    const rows = await this.db
      .select()
      .from(loads)
      .where(and(eq(loads.id, id), eq(loads.companyId, this.companyId)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const stops = await this.db
      .select()
      .from(loadStops)
      .where(eq(loadStops.loadId, id))
      .orderBy(asc(loadStops.sequence));

    const load = m.rowToLoad(row);
    if (stops.length > 0) load.stops = stops.map(m.rowToStop);
    return load;
  }

  async findManyByIds(ids: readonly string[]): Promise<Load[]> {
    if (ids.length === 0) return [];

    const rows = await this.db
      .select()
      .from(loads)
      .where(and(eq(loads.companyId, this.companyId), inArray(loads.id, [...ids])));

    if (rows.length === 0) return [];

    const stopRows = await this.db
      .select()
      .from(loadStops)
      .where(inArray(loadStops.loadId, [...ids]))
      .orderBy(asc(loadStops.sequence));

    const byLoad = new Map<string, LoadStop[]>();
    for (const row of stopRows) {
      const stop = m.rowToStop(row);
      const list = byLoad.get(row.loadId) ?? [];
      list.push(stop);
      byLoad.set(row.loadId, list);
    }

    return rows.map((row) => {
      const load = m.rowToLoad(row);
      const stops = byLoad.get(load.id);
      if (stops && stops.length > 0) load.stops = stops;
      return load;
    });
  }

  async query(q: LoadQuery = {}): Promise<Page<Load>> {
    const conditions = [eq(loads.companyId, this.companyId)];

    if (q.status && q.status.length > 0) conditions.push(inArray(loads.status, q.status));
    if (q.broker) conditions.push(eq(loads.broker, q.broker));
    if (q.assignedTruckId) conditions.push(eq(loads.assignedTruckId, q.assignedTruckId));
    if (q.assignedDriverId) conditions.push(eq(loads.assignedDriverId, q.assignedDriverId));
    if (q.unassigned) conditions.push(sql`${loads.assignedTruckId} is null`);
    if (q.cancelled === true) conditions.push(sql`${loads.cancelledAt} is not null`);
    if (q.cancelled === false) conditions.push(sql`${loads.cancelledAt} is null`);
    if (q.minRateCents !== undefined) conditions.push(gte(loads.rate, q.minRateCents));
    if (q.maxRateCents !== undefined) conditions.push(lte(loads.rate, q.maxRateCents));
    if (q.originContains) conditions.push(ilike(loads.origin, `%${q.originContains}%`));
    if (q.destinationContains) conditions.push(ilike(loads.destination, `%${q.destinationContains}%`));

    if (q.pickupBetween) {
      conditions.push(gte(loads.pickupDate, new Date(q.pickupBetween[0])));
      conditions.push(lte(loads.pickupDate, new Date(q.pickupBetween[1])));
    }
    if (q.deliveryBetween) {
      conditions.push(gte(loads.deliveryDate, new Date(q.deliveryBetween[0])));
      conditions.push(lte(loads.deliveryDate, new Date(q.deliveryBetween[1])));
    }
    if (q.bookedAfter) conditions.push(gte(loads.bookedAt, new Date(q.bookedAfter)));
    if (q.bookedBefore) conditions.push(lte(loads.bookedAt, new Date(q.bookedBefore)));

    if (q.search) {
      const needle = `%${q.search}%`;
      conditions.push(
        or(
          ilike(loads.broker, needle),
          ilike(loads.origin, needle),
          ilike(loads.destination, needle),
          ilike(loads.reference, needle),
          ilike(loads.commodity, needle),
        )!,
      );
    }

    const where = and(...conditions);

    const totalRows = await this.db.select({ value: count() }).from(loads).where(where);
    const total = totalRows[0]?.value ?? 0;

    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;

    const order = orderFor(q.sort);

    const rows = await this.db
      .select()
      .from(loads)
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset);

    return { items: rows.map(m.rowToLoad), total, limit, offset };
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(loads)
      .where(and(eq(loads.id, id), eq(loads.companyId, this.companyId)))
      .returning({ id: loads.id });
    return rows.length > 0;
  }

  /**
   * Insert-or-ignore, keyed by the device-generated id. This is the offline
   * replay path: the phone creates the load with its own id and retries until
   * it succeeds, so a duplicate delivery is a no-op rather than a second load.
   */
  async upsertMany(
    incoming: readonly Load[],
    domainEvents: readonly DomainEvent[] = [],
  ): Promise<{ inserted: string[]; existing: string[] }> {
    if (incoming.length === 0) return { inserted: [], existing: [] };

    const db = this.db;
    const inserted: string[] = [];
    const existing: string[] = [];

    await db.transaction(async (tx) => {
      const handle = tx as unknown as Database;

      for (const load of incoming) {
        const found = await handle
          .select({ id: loads.id })
          .from(loads)
          .where(and(eq(loads.id, load.id), eq(loads.companyId, this.companyId)))
          .limit(1);

        if (found.length > 0) {
          existing.push(load.id);
          // Update in place: the office may have edited fields the phone did not.
          const row = m.loadToRow(load);
          delete row.id;
          delete row.companyId;
          await handle.update(loads).set(row as never).where(eq(loads.id, load.id));
          continue;
        }

        await handle.insert(loads).values(m.loadToRow(load) as never);
        await this.writeStops(handle, load);
        inserted.push(load.id);
      }

      await this.writeEvents(handle, domainEvents);
    });

    return { inserted, existing };
  }

  async withStops(load: Load): Promise<Load> {
    const full = await this.findById(load.id);
    return full ?? load;
  }

  private async writeEvents(db: Database, domainEvents: readonly DomainEvent[]): Promise<void> {
    if (domainEvents.length === 0) return;
    await db.insert(events).values(
      domainEvents.map((event) => m.eventToRow(event, this.companyId) as never),
    );
  }
}

function orderFor(sort: LoadQuery['sort']): ReturnType<typeof asc>[] {
  switch (sort) {
    case 'rate':
      return [desc(loads.rate)];
    case 'miles':
      return [desc(loads.miles)];
    case 'booked':
      return [desc(loads.bookedAt)];
    case 'destination':
      return [asc(loads.destination)];
    case 'pickup':
    default:
      return [asc(loads.pickupDate), asc(loads.id)];
  }
}

/* -------------------------------------------------------------------------- */
/* Trucks                                                                        */
/* -------------------------------------------------------------------------- */

export class DrizzleTruckRepository implements TruckRepository {
  constructor(private readonly companyId: string) {}

  private get db(): Database {
    return requireDb();
  }

  async create(truck: Truck): Promise<Truck> {
    await this.db.insert(trucks).values(m.truckToRow(truck) as never);
    return truck;
  }

  async update(truck: Truck): Promise<Truck> {
    const row = m.truckToRow(truck);
    delete row.id;
    delete row.companyId;
    await this.db.update(trucks).set(row as never).where(eq(trucks.id, truck.id));
    return truck;
  }

  async upsertTruck(truck: Truck): Promise<Truck> {
    const row = m.truckToRow(truck);
    await this.db
      .insert(trucks)
      .values(row as never)
      .onConflictDoUpdate({ target: trucks.id, set: row as never });
    return truck;
  }

  async findById(id: string): Promise<Truck | null> {
    const rows = await this.db
      .select()
      .from(trucks)
      .where(and(eq(trucks.id, id), eq(trucks.companyId, this.companyId)))
      .limit(1);
    const row = rows[0];
    return row ? m.rowToTruck(row) : null;
  }

  async findManyByIds(ids: readonly string[]): Promise<Truck[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(trucks)
      .where(and(eq(trucks.companyId, this.companyId), inArray(trucks.id, [...ids])));
    return rows.map(m.rowToTruck);
  }

  async query(companyId?: string, options?: { status?: Truck['status'][] }): Promise<Truck[]> {
    const conditions = [eq(trucks.companyId, companyId ?? this.companyId)];
    if (options?.status && options.status.length > 0) {
      conditions.push(inArray(trucks.status, options.status));
    }
    const rows = await this.db
      .select()
      .from(trucks)
      .where(and(...conditions))
      .orderBy(asc(trucks.unit));
    return rows.map(m.rowToTruck);
  }

  /** Called on every ping: one narrow UPDATE, no read-modify-write. */
  async updatePosition(id: string, location: { lat: number; lng: number }, at: Iso): Promise<boolean> {
    const rows = await this.db
      .update(trucks)
      .set({ lat: location.lat, lng: location.lng, lastKnownAt: new Date(at), updatedAt: new Date() })
      .where(and(eq(trucks.id, id), eq(trucks.companyId, this.companyId)))
      .returning({ id: trucks.id });
    return rows.length > 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Drivers                                                                       */
/* -------------------------------------------------------------------------- */

export class DrizzleDriverRepository implements DriverRepository {
  constructor(private readonly companyId: string) {}

  private get db(): Database {
    return requireDb();
  }

  async create(driver: Driver): Promise<Driver> {
    await this.db.insert(drivers).values(m.driverToRow(driver) as never);
    return driver;
  }

  async update(driver: Driver): Promise<Driver> {
    const row = m.driverToRow(driver);
    delete row.id;
    delete row.companyId;
    await this.db.update(drivers).set(row as never).where(eq(drivers.id, driver.id));
    return driver;
  }

  async upsertDriver(driver: Driver): Promise<Driver> {
    const row = m.driverToRow(driver);
    await this.db
      .insert(drivers)
      .values(row as never)
      .onConflictDoUpdate({ target: drivers.id, set: row as never });
    return driver;
  }

  async findById(id: string): Promise<Driver | null> {
    const rows = await this.db
      .select()
      .from(drivers)
      .where(and(eq(drivers.id, id), eq(drivers.companyId, this.companyId)))
      .limit(1);
    const row = rows[0];
    return row ? m.rowToDriver(row) : null;
  }

  async findManyByIds(ids: readonly string[]): Promise<Driver[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(drivers)
      .where(and(eq(drivers.companyId, this.companyId), inArray(drivers.id, [...ids])));
    return rows.map(m.rowToDriver);
  }

  async query(companyId?: string, options?: { status?: Driver['status'][] }): Promise<Driver[]> {
    const conditions = [eq(drivers.companyId, companyId ?? this.companyId)];
    if (options?.status && options.status.length > 0) {
      conditions.push(inArray(drivers.status, options.status));
    }
    const rows = await this.db
      .select()
      .from(drivers)
      .where(and(...conditions))
      .orderBy(asc(drivers.name));
    return rows.map(m.rowToDriver);
  }

  async findByUserId(userId: string): Promise<Driver | null> {
    const rows = await this.db
      .select()
      .from(drivers)
      .where(eq(drivers.userId, userId))
      .limit(1);
    const row = rows[0];
    return row ? m.rowToDriver(row) : null;
  }
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                     */
/* -------------------------------------------------------------------------- */

export class DrizzleDocumentRepository implements DocumentRepository {
  constructor(private readonly companyId: string) {}

  private get db(): Database {
    return requireDb();
  }

  async attach(document: LoadDocument): Promise<LoadDocument> {
    await this.db.insert(documents).values(m.documentToRow(document, this.companyId) as never);
    return document;
  }

  async upsertDocument(document: LoadDocument): Promise<LoadDocument> {
    const row = m.documentToRow(document, this.companyId);
    await this.db
      .insert(documents)
      .values(row as never)
      .onConflictDoUpdate({ target: documents.id, set: row as never });
    return document;
  }

  async findForLoad(loadId: string): Promise<LoadDocument[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.loadId, loadId), eq(documents.companyId, this.companyId)))
      .orderBy(asc(documents.uploadedAt));
    return rows.map(m.rowToDocument);
  }

  async findById(id: string): Promise<LoadDocument | null> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.companyId, this.companyId)))
      .limit(1);
    const row = rows[0];
    return row ? m.rowToDocument(row) : null;
  }

  async markRejected(id: string, reason: string): Promise<LoadDocument | null> {
    const rows = await this.db
      .update(documents)
      .set({ status: 'rejected', rejectReason: reason })
      .where(and(eq(documents.id, id), eq(documents.companyId, this.companyId)))
      .returning();

    const row = rows[0];
    return row ? m.rowToDocument(row) : null;
  }
}

/* -------------------------------------------------------------------------- */
/* Events                                                                        */
/* -------------------------------------------------------------------------- */

export class DrizzleEventRepository implements EventRepository {
  constructor(private readonly companyId: string) {}

  private get db(): Database {
    return requireDb();
  }

  async append(incoming: readonly DomainEvent[]): Promise<void> {
    if (incoming.length === 0) return;
    await this.db.insert(events).values(
      incoming.map((event) => m.eventToRow(event, this.companyId) as never),
    );
  }

  async query(
    companyId?: string,
    options?: { entityId?: string; since?: Iso; limit?: number },
  ): Promise<DomainEvent[]> {
    const conditions = [eq(events.companyId, companyId ?? this.companyId)];
    if (options?.entityId) conditions.push(eq(events.entityId, options.entityId));
    if (options?.since) conditions.push(gte(events.occurredAt, new Date(options.since)));

    const rows = await this.db
      .select()
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.occurredAt))
      .limit(options?.limit ?? 100);

    return rows.map(m.rowToEvent);
  }
}

/* -------------------------------------------------------------------------- */
/* Invoices                                                                      */
/* -------------------------------------------------------------------------- */

export class DrizzleInvoiceRepository implements InvoiceRepository {
  constructor(private readonly companyId: string) {}

  private get db(): Database {
    return requireDb();
  }

  async create(invoice: Invoice): Promise<Invoice> {
    const db = this.db;
    await db.transaction(async (tx) => {
      const handle = tx as unknown as Database;
      await handle.insert(invoices).values(invoiceToRow(invoice) as never);
      await handle.insert(invoiceLines).values(
        invoice.lines.map((line, index) => ({
          id: line.id,
          invoiceId: invoice.id,
          companyId: this.companyId,
          loadId: line.loadId ?? null,
          description: line.description,
          kind: line.kind,
          miles: line.miles ?? 0,
          rateCents: line.rateCents ?? null,
          amountCents: line.amountCents,
          taxCents: line.taxCents ?? 0,
          sequence: index,
        })) as never,
      );
      if (invoice.loadIds.length > 0) {
        await handle
          .update(loads)
          .set({ invoicedOn: invoice.id, updatedAt: new Date() })
          .where(
            and(
              eq(loads.companyId, this.companyId),
              inArray(loads.id, invoice.loadIds),
            ),
          );
      }
    });
    return invoice;
  }

  async update(invoice: Invoice): Promise<Invoice> {
    const row = invoiceToRow(invoice);
    delete row.id;
    delete row.companyId;
    await this.db.update(invoices).set(row as never).where(eq(invoices.id, invoice.id));
    return invoice;
  }

  async findById(id: string): Promise<Invoice | null> {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.companyId, this.companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.hydrate(row);
  }

  async findByNumber(number: string): Promise<Invoice | null> {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.number, number), eq(invoices.companyId, this.companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.hydrate(row);
  }

  async query(companyId?: string, options?: { broker?: string; openOnly?: boolean }): Promise<Invoice[]> {
    const conditions = [eq(invoices.companyId, companyId ?? this.companyId)];
    if (options?.broker) conditions.push(eq(invoices.brokerName, options.broker));
    if (options?.openOnly) conditions.push(sql`${invoices.balanceCents} > 0`);

    const rows = await this.db
      .select()
      .from(invoices)
      .where(and(...conditions))
      .orderBy(desc(invoices.issuedAt));

    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  async invoicedLoadIds(): Promise<string[]> {
    const rows = await this.db
      .select({ loadId: invoiceLines.loadId })
      .from(invoiceLines)
      .where(and(eq(invoiceLines.companyId, this.companyId)));

    return rows
      .map((row) => row.loadId)
      .filter((id): id is string => typeof id === 'string');
  }

  private async hydrate(row: typeof invoices.$inferSelect): Promise<Invoice> {
    const lineRows = await this.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, row.id))
      .orderBy(asc(invoiceLines.sequence));

    const paymentRows = await this.db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, row.id))
      .orderBy(asc(payments.at));

    const invoice: Invoice = {
      id: row.id,
      companyId: row.companyId,
      number: row.number,
      brokerName: row.brokerName,
      brokerAccountRef: row.brokerAccountRef ?? undefined,
      status: row.status,
      lines: lineRows.map((line) => ({
        id: line.id,
        loadId: line.loadId ?? undefined,
        description: line.description,
        kind: line.kind as Invoice['lines'][number]['kind'],
        miles: line.miles,
        rateCents: line.rateCents ?? undefined,
        amountCents: line.amountCents,
        taxCents: line.taxCents,
      })),
      subtotalCents: row.subtotalCents,
      taxCents: row.taxCents,
      totalCents: row.totalCents,
      payments: paymentRows.map((payment) => ({
        id: payment.id,
        invoiceId: payment.invoiceId,
        amountCents: payment.amountCents,
        at: payment.at.toISOString(),
        method: payment.method as Invoice['payments'][number]['method'],
        reference: payment.reference ?? undefined,
        note: payment.note ?? undefined,
        feeCents: payment.feeCents,
      })),
      amountPaidCents: row.amountPaidCents,
      balanceCents: row.balanceCents,
      termsDays: row.termsDays,
      issuedAt: row.issuedAt.toISOString(),
      dueAt: row.dueAt.toISOString(),
      deliveredAt: row.deliveredAt?.toISOString(),
      paidAt: row.paidAt?.toISOString(),
      quickPayBps: row.quickPayBps ?? undefined,
      quickPayWindowDays: row.quickPayWindowDays ?? undefined,
      notes: row.notes ?? undefined,
      loadIds: [],
      createdAt: row.createdAt.toISOString(),
    };

    const loadIds = lineRows
      .map((line) => line.loadId)
      .filter((id): id is string => typeof id === 'string');
    invoice.loadIds = loadIds;

    return invoice;
  }
}

function invoiceToRow(invoice: Invoice): Record<string, unknown> {
  return {
    id: invoice.id,
    companyId: invoice.companyId,
    number: invoice.number,
    brokerName: invoice.brokerName,
    brokerAccountRef: invoice.brokerAccountRef ?? null,
    status: invoice.status,
    subtotalCents: invoice.subtotalCents,
    taxCents: invoice.taxCents,
    totalCents: invoice.totalCents,
    amountPaidCents: invoice.amountPaidCents,
    balanceCents: invoice.balanceCents,
    termsDays: invoice.termsDays,
    issuedAt: new Date(invoice.issuedAt),
    dueAt: new Date(invoice.dueAt),
    deliveredAt: invoice.deliveredAt ? new Date(invoice.deliveredAt) : null,
    paidAt: invoice.paidAt ? new Date(invoice.paidAt) : null,
    quickPayBps: invoice.quickPayBps ?? null,
    quickPayWindowDays: invoice.quickPayWindowDays ?? null,
    notes: invoice.notes ?? null,
    updatedAt: new Date(),
  };
}

/* -------------------------------------------------------------------------- */
/* Settlements                                                                   */
/* -------------------------------------------------------------------------- */

export class DrizzleSettlementRepository implements SettlementRepository {
  constructor(private readonly companyId: string) {}

  private get db(): Database {
    return requireDb();
  }

  async create(settlement: Settlement): Promise<Settlement> {
    const db = this.db;
    await db.transaction(async (tx) => {
      const handle = tx as unknown as Database;
      await handle.insert(settlements).values(settlementToRow(settlement) as never);
      await handle.insert(settlementLines).values(
        settlement.lines.map((line) => ({
          id: `${settlement.id}_${line.sequence}`,
          settlementId: settlement.id,
          companyId: this.companyId,
          sequence: line.sequence,
          kind: line.kind,
          description: line.description,
          loadId: line.loadId ?? null,
          miles: line.miles ?? 0,
          rateCents: line.rateCents ?? null,
          amountCents: line.amountCents,
          meta: line.meta ?? {},
        })) as never,
      );
    });
    return settlement;
  }

  async update(settlement: Settlement): Promise<Settlement> {
    const row = settlementToRow(settlement);
    delete row.id;
    delete row.companyId;
    await this.db.update(settlements).set(row as never).where(eq(settlements.id, settlement.id));
    return settlement;
  }

  async findById(id: string): Promise<Settlement | null> {
    const rows = await this.db
      .select()
      .from(settlements)
      .where(and(eq(settlements.id, id), eq(settlements.companyId, this.companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.hydrate(row);
  }

  async findByDriverWeek(driverId: string, weekKey: string): Promise<Settlement | null> {
    const rows = await this.db
      .select()
      .from(settlements)
      .where(
        and(
          eq(settlements.companyId, this.companyId),
          eq(settlements.driverId, driverId),
          eq(settlements.weekKey, weekKey),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.hydrate(row);
  }

  async query(
    companyId?: string,
    options?: { driverId?: string; status?: Settlement['status'] },
  ): Promise<Settlement[]> {
    const conditions = [eq(settlements.companyId, companyId ?? this.companyId)];
    if (options?.driverId) conditions.push(eq(settlements.driverId, options.driverId));
    if (options?.status) conditions.push(eq(settlements.status, options.status));

    const rows = await this.db
      .select()
      .from(settlements)
      .where(and(...conditions))
      .orderBy(desc(settlements.weekStart));

    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  private async hydrate(row: typeof settlements.$inferSelect): Promise<Settlement> {
    const lineRows = await this.db
      .select()
      .from(settlementLines)
      .where(eq(settlementLines.settlementId, row.id))
      .orderBy(asc(settlementLines.sequence));

    const settlement: Settlement = {
      id: row.id,
      companyId: row.companyId,
      driverId: row.driverId,
      driverName: row.driverName,
      week: {
        key: row.weekKey,
        start: row.weekStart.toISOString(),
        end: row.weekEnd.toISOString(),
        label: `Week of ${row.weekKey}`,
      },
      status: row.status,
      lines: lineRows.map((line) => ({
        sequence: line.sequence,
        kind: line.kind as Settlement['lines'][number]['kind'],
        description: line.description,
        loadId: line.loadId ?? undefined,
        miles: line.miles,
        rateCents: line.rateCents ?? undefined,
        amountCents: line.amountCents,
        payable: line.kind !== 'revenue',
        meta: line.meta,
      })),
      summary: {
        grossRevenueCents: row.grossRevenueCents,
        loadPayCents: row.loadPayCents,
        deadheadPayCents: row.deadheadPayCents,
        perDiemCents: row.perDiemCents,
        reimbursementsCents: row.reimbursementsCents,
        bonusCents: row.bonusCents,
        advancesCents: row.advancesCents,
        deductionsCents: row.deductionsCents,
        grossCents: row.grossCents,
        netCents: row.netCents,
        totalLoadedMiles: row.totalLoadedMiles,
        totalDeadheadMiles: row.totalEmptyMiles,
        totalEmptyMiles: row.totalEmptyMiles,
        loadsCompleted: row.loadsCompleted,
        revenuePerLoadedMileCents:
          row.totalLoadedMiles > 0 ? Math.round(row.grossRevenueCents / row.totalLoadedMiles) : 0,
        effectiveCpmCents:
          row.totalLoadedMiles + row.totalEmptyMiles > 0
            ? Math.round(row.grossCents / (row.totalLoadedMiles + row.totalEmptyMiles))
            : 0,
      },
      driverSignatureName: row.driverSignatureName ?? undefined,
      driverSignedAt: row.driverSignedAt?.toISOString(),
      approvedBy: row.approvedBy ?? undefined,
      approvedAt: row.approvedAt?.toISOString(),
      paidAt: row.paidAt?.toISOString(),
      paymentMethod: (row.paymentMethod as Settlement['paymentMethod']) ?? undefined,
      notes: row.notes ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };

    return settlement;
  }
}

function settlementToRow(settlement: Settlement): Record<string, unknown> {
  return {
    id: settlement.id,
    companyId: settlement.companyId,
    driverId: settlement.driverId,
    driverName: settlement.driverName,
    weekKey: settlement.week.key,
    weekStart: new Date(settlement.week.start),
    weekEnd: new Date(settlement.week.end),
    status: settlement.status,
    grossRevenueCents: settlement.summary.grossRevenueCents,
    loadPayCents: settlement.summary.loadPayCents,
    deadheadPayCents: settlement.summary.deadheadPayCents,
    perDiemCents: settlement.summary.perDiemCents,
    reimbursementsCents: settlement.summary.reimbursementsCents,
    bonusCents: settlement.summary.bonusCents,
    advancesCents: settlement.summary.advancesCents,
    deductionsCents: settlement.summary.deductionsCents,
    grossCents: settlement.summary.grossCents,
    netCents: settlement.summary.netCents,
    totalLoadedMiles: settlement.summary.totalLoadedMiles,
    totalEmptyMiles: settlement.summary.totalEmptyMiles,
    loadsCompleted: settlement.summary.loadsCompleted,
    driverSignatureName: settlement.driverSignatureName ?? null,
    driverSignedAt: settlement.driverSignedAt ? new Date(settlement.driverSignedAt) : null,
    approvedBy: settlement.approvedBy ?? null,
    approvedAt: settlement.approvedAt ? new Date(settlement.approvedAt) : null,
    paidAt: settlement.paidAt ? new Date(settlement.paidAt) : null,
    paymentMethod: settlement.paymentMethod ?? null,
    notes: settlement.notes ?? null,
    updatedAt: new Date(),
  };
}

/* -------------------------------------------------------------------------- */
/* GPS pings                                                                     */
/* -------------------------------------------------------------------------- */

export class DrizzlePingStore {
  constructor(private readonly companyId: string) {}

  private get db(): Database {
    return requireDb();
  }

  /**
   * Batched insert with a conflict guard on the ping id. The offline queue
   * replays the same device-generated ids, so this makes the retry a no-op.
   */
  async append(
    pings: readonly {
      id: string;
      truckId: string;
      location: { lat: number; lng: number };
      at: Iso;
      accuracyM?: number;
      headingDeg?: number;
      speedMph?: number;
      source?: string;
      offline?: boolean;
    }[],
  ): Promise<void> {
    if (pings.length === 0) return;

    await this.db
      .insert(gpsPings)
      .values(
        pings.map((ping) => ({
          id: ping.id,
          companyId: this.companyId,
          truckId: ping.truckId,
          lat: ping.location.lat,
          lng: ping.location.lng,
          at: new Date(ping.at),
          accuracyM: ping.accuracyM ?? null,
          headingDeg: ping.headingDeg ?? null,
          speedMph: ping.speedMph ?? null,
          source: ping.source ?? 'gps',
          offline: ping.offline ?? false,
        })) as never,
      )
      .onConflictDoNothing();
  }

  async forTruck(truckId: string, since?: Iso, until?: Iso): Promise<ReturnType<typeof m.rowToPing>[]> {
    const conditions = [eq(gpsPings.truckId, truckId), eq(gpsPings.companyId, this.companyId)];
    if (since) conditions.push(gte(gpsPings.at, new Date(since)));
    if (until) conditions.push(lte(gpsPings.at, new Date(until)));

    const rows = await this.db
      .select()
      .from(gpsPings)
      .where(and(...conditions))
      .orderBy(asc(gpsPings.at))
      .limit(1000);

    return rows.map(m.rowToPing);
  }

  async latest(truckIds: readonly string[]): Promise<ReturnType<typeof m.rowToPing>[]> {
    if (truckIds.length === 0) return [];

    const rows = await this.db
      .select({
        id: gpsPings.id,
        truckId: gpsPings.truckId,
        lat: gpsPings.lat,
        lng: gpsPings.lng,
        at: gpsPings.at,
        accuracyM: gpsPings.accuracyM,
        headingDeg: gpsPings.headingDeg,
        speedMph: gpsPings.speedMph,
        source: gpsPings.source,
        offline: gpsPings.offline,
      })
      .from(gpsPings)
      .where(and(eq(gpsPings.companyId, this.companyId), inArray(gpsPings.truckId, [...truckIds])))
      .orderBy(desc(gpsPings.at))
      .limit(truckIds.length * 4);

    // The first row per truck in descending order is its latest ping.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!latest.has(row.truckId)) latest.set(row.truckId, row);
    }

    return [...latest.values()].map((row) => ({
      id: row.id,
      truckId: row.truckId,
      location: { lat: row.lat, lng: row.lng },
      at: row.at.toISOString(),
      accuracyM: row.accuracyM ?? undefined,
      headingDeg: row.headingDeg ?? undefined,
      speedMph: row.speedMph ?? undefined,
      source: row.source,
      offline: row.offline,
    }));
  }

  async prune(before: Iso): Promise<number> {
    const rows = await this.db
      .delete(gpsPings)
      .where(and(eq(gpsPings.companyId, this.companyId), lte(gpsPings.at, new Date(before))))
      .returning({ id: gpsPings.id });
    return rows.length;
  }
}


/* -------------------------------------------------------------------------- */
/* Fuel entries                                                                  */
/* -------------------------------------------------------------------------- */

export class DrizzleFuelRepository {
  constructor(private readonly companyId: string) {}

  private get db(): Database {
    return requireDb();
  }

  async create(entry: FuelEntryRow): Promise<FuelEntryRow> {
    await this.db.insert(fuelEntries).values(toFuelRow(entry, this.companyId) as never);
    return entry;
  }

  async upsertFuel(entry: FuelEntryRow): Promise<FuelEntryRow> {
    const row = toFuelRow(entry, this.companyId);
    await this.db
      .insert(fuelEntries)
      .values(row as never)
      .onConflictDoUpdate({ target: fuelEntries.id, set: row as never });
    return entry;
  }

  async query(
    companyId: string,
    options?: { truckId?: string; between?: [Iso, Iso] },
  ): Promise<FuelEntryRow[]> {
    const conditions = [eq(fuelEntries.companyId, companyId ?? this.companyId)];
    if (options?.truckId) conditions.push(eq(fuelEntries.truckId, options.truckId));
    if (options?.between) {
      conditions.push(gte(fuelEntries.at, new Date(options.between[0])));
      conditions.push(lte(fuelEntries.at, new Date(options.between[1])));
    }

    const rows = await this.db
      .select()
      .from(fuelEntries)
      .where(and(...conditions))
      .orderBy(asc(fuelEntries.at));

    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      truckId: row.truckId,
      driverId: row.driverId ?? undefined,
      loadId: row.loadId ?? undefined,
      gallons: Number(row.gallons),
      priceCentsPerGallon: row.priceCentsPerGallon,
      totalCents: row.totalCents,
      odometerMiles: row.odometerMiles ?? undefined,
      location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : undefined,
      jurisdictionCode: row.jurisdictionCode ?? undefined,
      at: row.at.toISOString(),
      receiptStorageKey: row.receiptStorageKey ?? undefined,
      cardLast4: row.cardLast4 ?? undefined,
      isPrepaid: row.isPrepaid,
      note: row.note ?? undefined,
    }));
  }
}

function toFuelRow(entry: FuelEntryRow, companyId: string): Record<string, unknown> {
  return {
    id: entry.id,
    companyId,
    truckId: entry.truckId,
    driverId: entry.driverId ?? null,
    loadId: entry.loadId ?? null,
    gallons: entry.gallons,
    priceCentsPerGallon: entry.priceCentsPerGallon,
    totalCents: entry.totalCents,
    odometerMiles: entry.odometerMiles ?? null,
    lat: entry.location?.lat ?? null,
    lng: entry.location?.lng ?? null,
    jurisdictionCode: entry.jurisdictionCode ?? null,
    at: new Date(entry.at),
    receiptStorageKey: entry.receiptStorageKey ?? null,
    cardLast4: entry.cardLast4 ?? null,
    isPrepaid: entry.isPrepaid ?? false,
    note: entry.note ?? null,
  };
}
/* -------------------------------------------------------------------------- */
/* Factory                                                                       */
/* -------------------------------------------------------------------------- */

export interface Repositories {
  loads: LoadRepository;
  trucks: TruckRepository;
  drivers: DriverRepository;
  documents: DocumentRepository;
  events: EventRepository;
  invoices: InvoiceRepository;
  settlements: SettlementRepository;
  pings: DrizzlePingStore | null;
}

export function repositoriesFor(companyId: string): Repositories {
  return {
    loads: new DrizzleLoadRepository(companyId),
    trucks: new DrizzleTruckRepository(companyId),
    drivers: new DrizzleDriverRepository(companyId),
    documents: new DrizzleDocumentRepository(companyId),
    events: new DrizzleEventRepository(companyId),
    invoices: new DrizzleInvoiceRepository(companyId),
    settlements: new DrizzleSettlementRepository(companyId),
    pings: new DrizzlePingStore(companyId),
  };
}
