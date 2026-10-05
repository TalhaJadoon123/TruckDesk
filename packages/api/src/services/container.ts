import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { and, desc, eq, gte, lt } from 'drizzle-orm';

import {
  MemoryTrackingStore,
  TrackingEngine,
  type GpsPing,
  type TrackingStore,
} from '@truckdesk/core';
import {
  InMemoryRepositories,
  type DocumentRepository,
  type DriverRepository,
  type EventRepository,
  type FuelRepository,
  type InvoiceRepository,
  type LoadRepository,
  type SettlementRepository,
  type TruckRepository,
} from '@truckdesk/loads';
import { SimulatorProvider, resolveProvider, type EldProvider } from '@truckdesk/eld';
import { GroqClient } from '@truckdesk/llm';
import { Notifier } from '@truckdesk/sms';
import { uuid, type Load, type Truck } from '@truckdesk/shared';

import { env, type Env } from '../env.js';
import { db as sharedDb, type Database, type DbHandle } from '../db/client.js';
import { DrizzleFuelRepository, DrizzlePingStore, repositoriesFor } from '../db/repositories.js';

/**
 * Service container.
 *
 * One object owns every dependency. The API is built from it, the Worker builds
 * a lighter one from it, the seed script builds one from it, and tests build one
 * with `memory: true`. Because the only branch is "Postgres or in-memory", the
 * behaviour of a route is identical in both modes apart from persistence.
 */

export interface Services {
  env: Env;
  /** True when there is no database and everything is in memory. */
  memory: boolean;
  db: Database | null;
  llm: GroqClient;
  notifier: Notifier;
  supabase: SupabaseClient | null;
  tracking: TrackingEngine;

  /** Repositories scoped to one company. */
  forCompany(companyId: string): CompanyServices;
  /** Raw ping store, exposed for the maintenance/prune route. */
  pingStoreFor(companyId: string): TrackingStore;
  /** ELD provider for a truck. */
  eldFor(truck: Truck): EldProvider;
  close(): Promise<void>;
}

export interface CompanyServices {
  companyId: string;
  loads: LoadRepository;
  trucks: TruckRepository;
  drivers: DriverRepository;
  documents: DocumentRepository;
  events: EventRepository;
  invoices: InvoiceRepository;
  settlements: SettlementRepository;
  fuel: FuelRepository;
  tracking: TrackingEngine;
}

export interface ContainerOptions {
  env?: Env;
  /** Force the in-memory store regardless of DATABASE_URL. Used by tests. */
  memory?: boolean;
  /** Injected clock, so tests are deterministic. */
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export function createServices(options: ContainerOptions = {}): Services {
  const config = options.env ?? env();
  const forceMemory = options.memory === true;
  const useDatabase = !forceMemory && Boolean(config.DATABASE_URL);

  const handle: DbHandle = useDatabase ? sharedDb() : { db: null, sql: null, memory: true, close: async () => {} };

  const llm = new GroqClient({
    apiKey: config.GROQ_API_KEY,
    model: config.GROQ_MODEL,
    baseUrl: config.GROQ_BASE_URL,
    timeoutMs: config.LLM_TIMEOUT_MS,
    offline: !config.GROQ_API_KEY,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const notifier = new Notifier({
    push: {
      ...(config.EXPO_ACCESS_TOKEN ? { accessToken: config.EXPO_ACCESS_TOKEN } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    },
    twilio: {
      ...(config.TWILIO_ACCOUNT_SID ? { accountSid: config.TWILIO_ACCOUNT_SID } : {}),
      ...(config.TWILIO_AUTH_TOKEN ? { authToken: config.TWILIO_AUTH_TOKEN } : {}),
      ...(config.TWILIO_MESSAGING_SERVICE_SID
        ? { messagingServiceSid: config.TWILIO_MESSAGING_SERVICE_SID }
        : {}),
      ...(config.TWILIO_FROM ? { from: config.TWILIO_FROM } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    },
    policy: { smsEnabled: config.SMS_ENABLED },
  });

  const supabase =
    config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY
      ? createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  // One in-memory ping store shared by every company in memory mode, so the
  // demo board keeps working across requests.
  const memoryPings = new MemoryTrackingStore();
  const memoryRepos = new InMemoryRepositories();

  /**
   * The process-wide tracking engine used by routes that do not yet know the
   * company id (health checks, the public track endpoint). Per-company engines
   * come from `forCompany`.
   */
  const tracking = new TrackingEngine(
    handle.memory ? memoryPings : (makePingStore('default') as unknown as TrackingStore),
  );

  const services: Services = {
    env: config,
    memory: handle.memory,
    db: handle.db,
    llm,
    notifier,
    supabase,
    tracking,

    pingStoreFor(companyId: string): TrackingStore {
      if (handle.memory) return memoryPings;
      return makePingStore(companyId) as unknown as TrackingStore;
    },

    eldFor(truck: Truck): EldProvider {
      const name = (truck.eldProvider ?? 'simulator') as string;
      if (name === 'simulator') {
        return new SimulatorProvider({
          vehicles: [
            {
              vehicleId: truck.id,
              unit: truck.unit,
              driverId: truck.driverId ?? '',
              location: truck.location,
              headingDeg: 0,
              speedMph: 0,
              lastIntervalAt: new Date().toISOString(),
            },
          ],
        });
      }
      return resolveProvider(name, {
        samsara: {
          ...(config.SAMSARA_TOKEN ? { token: config.SAMSARA_TOKEN } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        },
        motive: {
          ...(config.MOTIVE_ACCESS_TOKEN ? { accessToken: config.MOTIVE_ACCESS_TOKEN } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        },
      });
    },

    forCompany(companyId: string): CompanyServices {
      if (handle.memory) {
        return {
          companyId,
          loads: memoryRepos.loadRepo,
          trucks: memoryRepos.truckRepo,
          drivers: memoryRepos.driverRepo,
          documents: memoryRepos.documentRepo,
          events: memoryRepos.eventRepo,
          invoices: memoryRepos.invoiceRepo,
          settlements: memoryRepos.settlementRepo,
          fuel: memoryRepos.fuelRepo,
          tracking: new TrackingEngine(memoryPings),
        };
      }

      const repos = repositoriesFor(companyId);
      return {
        companyId,
        loads: repos.loads,
        trucks: repos.trucks,
        drivers: repos.drivers,
        documents: repos.documents,
        events: repos.events,
        invoices: repos.invoices,
        settlements: repos.settlements,
        fuel: new DrizzleFuelRepository(companyId),
        tracking: new TrackingEngine(repos.pings as unknown as TrackingStore),
      };
    },

    async close() {
      await handle.close();
    },
  };

  return services;
}

/* -------------------------------------------------------------------------- */
/* Ping store backed by Postgres                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Tracking store backed by Postgres. The port itself never sees a company id;
 * the store is constructed with one, so every read and write is scoped.
 */
function makePingStore(companyId: string) {
  return new DrizzlePingStore(companyId);
}

/* -------------------------------------------------------------------------- */
/* Supabase Realtime                                                             */
/* -------------------------------------------------------------------------- */

export interface RealtimeConfig {
  enabled: boolean;
  channelName: string;
  detail: string;
}

export function realtimeStatus(services: Services): RealtimeConfig {
  if (!services.supabase) {
    return {
      enabled: false,
      channelName: 'truckdesk',
      detail: 'No Supabase credentials: GPS is stored and polled, but not streamed live.',
    };
  }
  return {
    enabled: true,
    channelName: 'truckdesk-tracking',
    detail: 'Subscribed to the Postgres change feed; the map updates without polling.',
  };
}

/**
 * Broadcast a position over Supabase Realtime.
 *
 * The API writes the ping to its own table first, then broadcasts. The map
 * subscribes and updates; a late subscriber catches up from `GET /track`. That
 * ordering means losing the broadcast degrades latency, never correctness.
 */
export async function broadcastPosition(
  services: Services,
  companyId: string,
  ping: GpsPing & { unit?: string },
): Promise<void> {
  if (!services.supabase) return;

  try {
    const channel = services.supabase.channel(`truckdesk:${companyId}`);
    await channel.subscribe();
    await channel.send({
      type: 'broadcast',
      event: 'position',
      payload: {
        truckId: ping.truckId,
        unit: ping.unit ?? '',
        lat: ping.location.lat,
        lng: ping.location.lng,
        at: ping.at,
        speedMph: ping.speedMph ?? 0,
        headingDeg: ping.headingDeg ?? 0,
      },
    });
    await services.supabase.removeChannel(channel);
  } catch {
    // Broadcast is best-effort; the persisted ping is the source of truth.
  }
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * GPS pings are the only unbounded table. Keeping 30 days on a free 500MB
 * database is the difference between a working map and a dead dashboard.
 */
export async function prunePings(
  services: Services,
  companyId: string,
  retentionDays = 30,
  now: Date = new Date(),
): Promise<number> {
  if (services.memory) return 0;

  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const repos = repositoriesFor(companyId);
  return repos.pings ? repos.pings.prune(cutoff.toISOString()) : 0;
}

export async function countPingsSince(
  services: Services,
  companyId: string,
  since: Date,
): Promise<number> {
  if (!services.db) return 0;
  const { gpsPings } = await import('../db/schema.js');
  const rows = await services.db
    .select({ id: gpsPings.id })
    .from(gpsPings)
    .where(and(eq(gpsPings.companyId, companyId), gte(gpsPings.at, since)));
  return rows.length;
}

export async function latestPings(
  services: Services,
  companyId: string,
  limit = 20,
): Promise<GpsPing[]> {
  if (!services.db) return [];
  const { gpsPings } = await import('../db/schema.js');
  const rows = await services.db
    .select()
    .from(gpsPings)
    .where(eq(gpsPings.companyId, companyId))
    .orderBy(desc(gpsPings.at))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    truckId: row.truckId,
    location: { lat: row.lat, lng: row.lng },
    at: row.at.toISOString(),
    speedMph: row.speedMph ?? undefined,
    headingDeg: row.headingDeg ?? undefined,
    source: row.source,
    offline: row.offline,
  }));
}

export async function pingsInWindow(
  services: Services,
  companyId: string,
  from: Date,
  to: Date,
): Promise<GpsPing[]> {
  if (!services.db) return [];
  const { gpsPings } = await import('../db/schema.js');
  const rows = await services.db
    .select()
    .from(gpsPings)
    .where(
      and(eq(gpsPings.companyId, companyId), gte(gpsPings.at, from), lt(gpsPings.at, to)),
    )
    .limit(5000);
  return rows.map((row) => ({
    id: row.id,
    truckId: row.truckId,
    location: { lat: row.lat, lng: row.lng },
    at: row.at.toISOString(),
    speedMph: row.speedMph ?? undefined,
    headingDeg: row.headingDeg ?? undefined,
    source: row.source,
    offline: row.offline,
  }));
}

/** Seed a truck's location when the first ping arrives, or after a gap. */
export async function touchTruckPosition(
  services: Services,
  companyId: string,
  truck: Truck,
  ping: GpsPing,
): Promise<void> {
  const repos = services.forCompany(companyId);
  await repos.trucks.updatePosition(truck.id, ping.location, ping.at);
}

/** Convenience: a load's assigned truck, or null. */
export async function truckForLoad(
  services: Services,
  companyId: string,
  load: Load,
): Promise<Truck | null> {
  if (!load.assignedTruckId) return null;
  const repos = services.forCompany(companyId);
  return repos.trucks.findById(load.assignedTruckId);
}

export function newPingId(): string {
  return `gp_${uuid().slice(0, 12)}`;
}

export type { TrackingStore };
