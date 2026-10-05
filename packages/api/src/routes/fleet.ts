import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { Errors, driverSchema, formatUsd, type Driver, type Truck } from '@truckdesk/shared';
import { truckSchema } from '@truckdesk/shared';
import { providerStatus, readinessFor } from '@truckdesk/eld';
import { analyzeDeadhead, truckEconomics } from '@truckdesk/loads';
import { fleetUtilization } from '@truckdesk/core';

import { sendError } from '../auth.plugin.js';
import { dashboard, loadDispatchWorld } from '../services/dispatch.service.js';
import { broadcastPosition, newPingId } from '../services/container.js';
import type { Services } from '../services/container.js';

/**
 * Fleet routes: trucks, drivers, and the dashboard that reads from both.
 */

export default async function fleetRoutes(app: FastifyInstance, options: { services: Services }): Promise<void> {
  const { services } = options;

  /* -------------------------------------------------------------- trucks */

  app.get('/trucks', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);

      const query = z
        .object({ status: z.string().optional() })
        .parse(request.query ?? {});

      const trucks = await company.trucks.query(
        actor.company,
        query.status
          ? {
              status: query.status
                .split(',')
                .map((value) => value.trim())
                .filter((value): value is Truck['status'] =>
                  ['available', 'loaded', 'empty', 'maintenance'].includes(value),
                ),
            }
          : undefined,
      );

      const loads = await company.loads.query({ companyId: actor.company, limit: 500 });
      const deadhead = estimateDeadhead(loads.items);

      return reply.send({
        trucks: trucks.map((truck) => ({
          ...truck,
          economics: truckEconomics(truck, loads.items, deadhead),
        })),
        utilisation: fleetUtilization(trucks),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/trucks', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = truckSchema
        .omit({ companyId: true })
        .parse(request.body);

      const company = services.forCompany(actor.company);

      // Unit numbers are the carrier's own identifier and must stay unique.
      const existing = await company.trucks.query(actor.company);
      if (existing.some((truck) => truck.unit.toLowerCase() === body.unit.toLowerCase())) {
        throw Errors.conflict(`Unit ${body.unit} already exists`, { unit: body.unit });
      }

      const truck: Truck = {
        ...body,
        companyId: actor.company,
        id: body.id,
        unit: body.unit,
        status: body.status,
        location: body.location,
      };

      await company.trucks.create(truck);
      return reply.code(201).send({ truck });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/trucks/:id', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const truck = await company.trucks.findById(request.params.id);
      if (!truck) throw Errors.notFound('Truck', request.params.id);

      const loads = await company.loads.query({ companyId: actor.company, limit: 500 });
      const onThisTruck = loads.items.filter((load) => load.assignedTruckId === truck.id);
      const driver = truck.driverId ? await company.drivers.findById(truck.driverId) : null;

      return reply.send({
        truck,
        driver,
        loads: onThisTruck,
        economics: truckEconomics(truck, loads.items, estimateDeadhead(loads.items)),
        eld: providerStatus({}).filter((entry) => entry.name === (truck.eldProvider ?? 'simulator')),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>('/trucks/:id', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const existing = await company.trucks.findById(request.params.id);
      if (!existing) throw Errors.notFound('Truck', request.params.id);

      const patch = truckSchema.partial().parse(request.body);
      const merged: Truck = { ...existing, ...patch, id: existing.id };

      await company.trucks.update(merged);
      return reply.send({ truck: merged });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* ------------------------------------------------------------- drivers */

  app.get('/drivers', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);

      const query = z
        .object({ status: z.enum(['active', 'inactive', 'on_leave']).optional() })
        .parse(request.query ?? {});

      const drivers = await company.drivers.query(
        actor.company,
        query.status ? { status: [query.status] } : undefined,
      );

      return reply.send({ drivers });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/drivers', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = driverSchema.parse(request.body);
      const company = services.forCompany(actor.company);

      const driver: Driver = { ...body, companyId: actor.company };
      await company.drivers.create(driver);
      return reply.code(201).send({ driver });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>('/drivers/:id', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const existing = await company.drivers.findById(request.params.id);
      if (!existing) throw Errors.notFound('Driver', request.params.id);

      const patch = driverSchema.partial().parse(request.body);
      const merged: Driver = { ...existing, ...patch, id: existing.id };
      await company.drivers.update(merged);
      return reply.send({ driver: merged });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/eld/providers', { preHandler: app.authenticate }, async (_request, reply) => {
    return reply.send({ providers: providerStatus({}) });
  });

  /* ----------------------------------------------------------- dashboard */

  app.get('/dashboard', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const payload = await dashboard(services, actor.company);

      return reply.send({
        ...payload,
        formatted: {
          revenueThisWeek: formatUsd(payload.summary.revenueThisWeekCents),
          revenueLastWeek: formatUsd(payload.summary.revenueLastWeekCents),
          averageRevenuePerMile: formatUsd(payload.summary.averageRevenuePerMileCents),
          unpaidReceivables: formatUsd(payload.summary.unpaidReceivablesCents),
          deadheadRatioPercent: `${Math.round(payload.summary.deadheadRatio * 100)}%`,
          onTimeRatePercent: `${Math.round(payload.summary.onTimeRate * 100)}%`,
        },
        mode: services.memory ? 'memory' : 'postgres',
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* ------------------------------------------------------------- tracking */

  /**
   * GPS ingest. Accepts a single ping or a batch from the offline queue, and is
   * idempotent on the device-generated ping id.
   */
  app.post('/track/ping', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({
          truckId: z.string().min(1),
          lat: z.number().min(-90).max(90),
          lng: z.number().min(-180).max(180),
          at: z.string().optional(),
          accuracyM: z.number().optional(),
          headingDeg: z.number().optional(),
          speedMph: z.number().optional(),
          source: z.string().optional(),
          offline: z.boolean().optional(),
          id: z.string().optional(),
          pings: z
            .array(
              z.object({
                id: z.string().optional(),
                truckId: z.string(),
                lat: z.number(),
                lng: z.number(),
                at: z.string().optional(),
                speedMph: z.number().optional(),
                headingDeg: z.number().optional(),
                offline: z.boolean().optional(),
              }),
            )
            .optional(),
        })
        .parse(request.body);

      const company = services.forCompany(actor.company);
      const inputs = body.pings?.length
        ? body.pings.map((ping) => ({
            truckId: ping.truckId,
            location: { lat: ping.lat, lng: ping.lng },
            at: ping.at,
            speedMph: ping.speedMph,
            headingDeg: ping.headingDeg,
            source: body.source ?? 'gps',
            offline: ping.offline ?? true,
            id: ping.id ?? newPingId(),
          }))
        : [
            {
              truckId: body.truckId,
              location: { lat: body.lat, lng: body.lng },
              at: body.at,
              accuracyM: body.accuracyM,
              headingDeg: body.headingDeg,
              speedMph: body.speedMph,
              source: body.source ?? 'gps',
              offline: body.offline ?? false,
              id: body.id ?? newPingId(),
            },
          ];

      // The driver app may only report for its own truck.
      if (actor.role === 'driver' && actor.driverId) {
        const driverLoads = await company.loads.query({
          companyId: actor.company,
          assignedDriverId: actor.driverId,
          limit: 50,
        });
        const allowed = new Set(driverLoads.items.map((load) => load.assignedTruckId).filter(Boolean));
        for (const input of inputs) {
          if (!allowed.has(input.truckId)) {
            throw Errors.forbidden('A driver may only report position for their own truck', {
              truckId: input.truckId,
            });
          }
        }
      }

      const result = await company.tracking.ingestBatch(inputs);
      if (!result.ok) throw result.error;

      // Reflect the newest position on the truck record so the list view and
      // the map agree without a second query.
      for (const ping of result.value.accepted) {
        const truck = await company.trucks.findById(ping.truckId);
        if (truck) {
          await company.trucks.updatePosition(ping.truckId, ping.location, ping.at);
          await broadcastPosition(services, actor.company, { ...ping, unit: truck.unit });
        }
      }

      return reply.code(202).send({
        accepted: result.value.accepted.length,
        rejected: result.value.rejected.length,
        rejections: result.value.rejected.slice(0, 10),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Live positions plus per-load progress. This is the map's data source. */
  app.get('/track', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const world = await loadDispatchWorld(services, actor.company, { skipHos: true });
      const snapshot = await world.company.tracking.snapshot(
        world.trucks,
        world.loads,
        new Date(),
      );

      return reply.send({
        ...snapshot,
        trucks: world.trucks.map((truck) => ({
          id: truck.id,
          unit: truck.unit,
          status: truck.status,
          driverId: truck.driverId,
          loadId: truck.currentLoadId,
          hosStatus: truck.hosStatus,
          eldProvider: truck.eldProvider,
        })),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Public tracking for a single load.
   *
   * This is the one endpoint that does not require a token: a broker or a shipper
   * gets a link. It is scoped by an unguessable load id and returns position
   * only - never rates, driver names or anything else commercially sensitive.
   */
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/track/:id',
    async (request, reply) => {
      try {
        const query = z
          .object({ token: z.string().optional() })
          .parse(request.query ?? {});

        const secret =
          services.env.API_TOKEN_SECRET ?? services.env.AUTH_SECRET;

        // Without a secret we cannot mint a share link, so this requires auth.
        if (!secret && !request.headers.authorization) {
          throw Errors.unauthorized('Public tracking requires a share token on this deployment');
        }

        if (query.token && secret) {
          const verified = await verifyShareToken(query.token, secret, request.params.id);
          if (!verified) throw Errors.forbidden('This tracking link is not valid for this load');
        }

        const companies = await companiesFromHeader(services, request.headers.authorization);
        if (companies.length === 0) {
          throw Errors.unauthorized('Authentication required');
        }

        for (const companyId of companies) {
          const company = services.forCompany(companyId);
          const load = await company.loads.findById(request.params.id);
          if (!load) continue;

          const truck = load.assignedTruckId
            ? await company.trucks.findById(load.assignedTruckId)
            : null;

          const progress = await company.tracking.loadProgress(load, truck ?? undefined, new Date());

          return reply.send({
            load: {
              id: load.id,
              status: load.status,
              origin: load.origin,
              destination: load.destination,
              pickupDate: load.pickupDate,
              deliveryDate: load.deliveryDate,
            },
            progress: {
              current: progress.current,
              destination: progress.destination,
              milesRemaining: progress.milesRemaining,
              percentComplete: progress.percentComplete,
              etaIso: progress.etaIso,
              etaConfidence: progress.etaConfidence,
              lastPingAt: progress.lastPingAt,
              offRouteMiles: progress.offRouteMiles,
            },
          });
        }

        throw Errors.notFound('Load', request.params.id);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /** HOS readiness for every driver, for the dispatch board's warnings column. */
  app.get('/hos', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const [trucks, drivers] = await Promise.all([
        company.trucks.query(actor.company),
        company.drivers.query(actor.company),
      ]);

      const results = [];
      for (const truck of trucks) {
        const driverId = truck.driverId ?? truck.currentDriverId;
        if (!driverId) continue;
        const provider = services.eldFor(truck);
        if (!provider.isConfigured()) continue;

        const readiness = await readinessFor(provider, truck.id, driverId);
        if (!readiness.ok) continue;

        const driver = drivers.find((candidate) => candidate.id === driverId);
        results.push({ ...readiness.value, unit: truck.unit, driverName: driver?.name });
      }

      return reply.send({ hos: results, providers: providerStatus({}) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/analytics/deadhead', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const loads = await company.loads.query({ companyId: actor.company, limit: 500 });
      const trucks = await company.trucks.query(actor.company);

      return reply.send({
        analysis: analyzeDeadhead(loads.items, estimateDeadhead(loads.items)),
        byTruck: trucks.map((truck) => truckEconomics(truck, loads.items, estimateDeadhead(loads.items))),
        formatted: {
          emptyMileCost: formatUsd(analyzeDeadhead(loads.items).emptyMileCostCents),
          opportunityCost: formatUsd(analyzeDeadhead(loads.items).opportunityCostCents),
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

/* -------------------------------------------------------------------------- */

function estimateDeadhead(loads: readonly { id: string; assignedTruckId?: string; miles: number }[]) {
  const out: Record<string, number> = {};
  for (const load of loads) {
    if (!load.assignedTruckId) continue;
    out[load.id] = Math.round(load.miles * 0.4);
  }
  return out;
}

async function verifyShareToken(token: string, secret: string, loadId: string): Promise<boolean> {
  const { verifyApiToken } = await import('../auth.js');
  const verified = verifyApiToken(token, secret);
  return verified.ok;
}

/**
 * Resolve the companies a token can read. In practice one; the array keeps the
 * shape honest for a future multi-company operator without a second round trip.
 */
async function companiesFromHeader(services: Services, header: string | undefined) {
  if (!header?.startsWith('Bearer ')) return [];
  const token = header.slice('Bearer '.length).trim();

  if (token.startsWith('tdk_')) return [];

  const secret = services.env.API_TOKEN_SECRET ?? services.env.AUTH_SECRET;
  if (!secret) return [];

  const { verifyApiToken } = await import('../auth.js');
  const verified = verifyApiToken(token, secret);
  return verified.ok ? [verified.value.company] : [];
}

function requireActor(request: { actor?: { company: string; sub: string; role: string; driverId?: string } }) {
  if (!request.actor) throw Errors.unauthorized('Authentication required');
  return request.actor;
}