import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { Errors, formatUsd, loadSchema, type Load } from '@truckdesk/shared';
import {
  analyzeRate,
  buildChecklist,
  captureProgress,
  makeDocument,
  outstandingDocuments,
  rateRedFlags,
  type CreateLoadInput,
} from '@truckdesk/loads';
import { matchLoadsToTrucks, autoAssignBoard } from '@truckdesk/core';

import { sendError } from '../auth.plugin.js';
import {
  assignLoadService,
  attachDocument,
  bulkAssignService,
  cancelLoadService,
  completeStopService,
  arriveStopService,
  createLoadService,
  dispatchBoard,
  estimateDeadheadByLoad,
  loadDetail,
  loadDispatchWorld,
  unassignLoadService,
  updateLoadStatus,
} from '../services/dispatch.service.js';
import { loadDocument } from '../services/money.service.js';
import type { Services } from '../services/container.js';

/**
 * Load routes: CRUD, the dispatcher workflow (dispatch, assign, match), the
 * driver workflow (arrive, complete, upload), and document generation.
 */

const createBodySchema = z.object({
  broker: z.string().min(1),
  origin: z.string().min(1),
  destination: z.string().min(1),
  rate: z.number().int().positive(),
  miles: z.number().positive(),
  reference: z.string().optional(),
  commodity: z.string().optional(),
  weightLbs: z.number().int().nonnegative().optional(),
  equipment: z
    .enum(['dry_van', 'reefer', 'flatbed', 'step_deck', 'tanker', 'box_truck', 'power_only'])
    .optional(),
  pickupDate: z.string().optional(),
  deliveryDate: z.string().optional(),
  pickupWindow: z
    .object({ start: z.string(), end: z.string() })
    .optional(),
  deliveryWindow: z
    .object({ start: z.string(), end: z.string() })
    .optional(),
  notes: z.string().optional(),
  stops: z
    .array(
      z.object({
        type: z.enum(['pickup', 'delivery', 'waypoint']),
        facilityName: z.string(),
        address: z.string(),
        city: z.string(),
        state: z.string().length(2),
        postalCode: z.string().optional(),
        location: z.object({ lat: z.number(), lng: z.number() }).optional(),
        appointmentRef: z.string().optional(),
        contactName: z.string().optional(),
        contactPhone: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .optional(),
});

const listQuerySchema = z.object({
  status: z.string().optional(),
  broker: z.string().optional(),
  truckId: z.string().optional(),
  driverId: z.string().optional(),
  unassigned: z.coerce.boolean().optional(),
  search: z.string().optional(),
  origin: z.string().optional(),
  destination: z.string().optional(),
  minRate: z.coerce.number().optional(),
  maxRate: z.coerce.number().optional(),
  cancelled: z.coerce.boolean().optional(),
  sort: z.enum(['pickup', 'rate', 'miles', 'booked', 'destination']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export default async function loadRoutes(app: FastifyInstance, options: { services: Services }): Promise<void> {
  const { services } = options;

  /* ---------------------------------------------------------------- CRUD */

  app.post('/loads', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = createBodySchema.parse(request.body);

      const load = await createLoadService(
        services,
        actor.company,
        {
          ...(body as unknown as CreateLoadInput),
          rate: body.rate,
        },
        actor.sub,
      );

      return reply.code(201).send({ load });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/loads', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const query = listQuerySchema.parse(request.query ?? {});
      const company = services.forCompany(actor.company);

      const page = await company.loads.query({
        companyId: actor.company,
        ...(query.status
          ? {
              status: query.status
                .split(',')
                .map((value) => value.trim())
                .filter((value): value is Load['status'] =>
                  ['booked', 'dispatched', 'in-transit', 'delivered', 'paid'].includes(value),
                ),
            }
          : {}),
        ...(query.broker ? { broker: query.broker } : {}),
        ...(query.truckId ? { assignedTruckId: query.truckId } : {}),
        ...(query.driverId ? { assignedDriverId: query.driverId } : {}),
        ...(query.unassigned !== undefined ? { unassigned: query.unassigned } : {}),
        ...(query.search ? { search: query.search } : {}),
        ...(query.origin ? { originContains: query.origin } : {}),
        ...(query.destination ? { destinationContains: query.destination } : {}),
        ...(query.minRate !== undefined ? { minRateCents: Math.round(query.minRate * 100) } : {}),
        ...(query.maxRate !== undefined ? { maxRateCents: Math.round(query.maxRate * 100) } : {}),
        ...(query.cancelled !== undefined ? { cancelled: query.cancelled } : {}),
        ...(query.sort ? { sort: query.sort } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
      });

      return reply.send({
        loads: page.items,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/loads/:id', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const detail = await loadDetail(services, actor.company, request.params.id);
      return reply.send(detail);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>('/loads/:id', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const existing = await company.loads.findById(request.params.id);
      if (!existing) throw Errors.notFound('Load', request.params.id);

      const patch = loadSchema.partial().parse(request.body);
      const merged: Load = { ...existing, ...patch, id: existing.id, companyId: actor.company };

      const updated = await company.loads.update(merged);
      return reply.send({ load: updated });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/loads/:id', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const deleted = await company.loads.delete(request.params.id);
      if (!deleted) throw Errors.notFound('Load', request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* ------------------------------------------------------------ dispatch */

  app.get<{ Querystring: Record<string, string | undefined> }>('/dispatch/board', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const board = await dispatchBoard(services, actor.company);
      return reply.send(board);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/dispatch', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({
          loadId: z.string().min(1),
          truckId: z.string().min(1),
          overrideWarnings: z.boolean().optional(),
          overrideBlocking: z.boolean().optional(),
        })
        .parse(request.body);

      const outcome = await assignLoadService(services, actor.company, {
        ...body,
        actorId: actor.sub,
      });

      return reply.send({
        load: outcome.assignment.load,
        truck: outcome.assignment.truck,
        deadheadMiles: outcome.assignment.deadheadMiles,
        projectedHours: outcome.assignment.projectedHours,
        marginCents: outcome.assignment.marginCents,
        marginFormatted: formatUsd(outcome.assignment.marginCents),
        warnings: outcome.warnings,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/dispatch/unassign', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z.object({ loadId: z.string().min(1) }).parse(request.body);
      const load = await unassignLoadService(services, actor.company, { ...body, actorId: actor.sub });
      return reply.send({ load });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/dispatch/bulk', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({ items: z.array(z.object({ loadId: z.string(), truckId: z.string() })).min(1) })
        .parse(request.body);

      const outcome = await bulkAssignService(services, actor.company, body.items, actor.sub);
      return reply.send(outcome);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Querystring: { apply?: string } }>(
    '/dispatch/auto-assign',
    { preHandler: app.requireDispatch },
    async (request, reply) => {
    try {
      const actor = requireActor(request);
      const world = await loadDispatchWorld(services, actor.company, { skipHos: true });

      const plan = autoAssignBoard({
        loads: world.loads,
        trucks: world.trucks,
        drivers: world.drivers,
        now: world.now,
      });

      if (!plan.ok) throw plan.error;

      const apply = request.query['apply'] === 'true';
      let assigned = 0;
      if (apply) {
        const outcome = await bulkAssignService(services, actor.company, plan.value.assignments, actor.sub);
        assigned = outcome.assigned;
      }

      return reply.send({
        preview: !apply,
        plan: plan.value.assignments,
        unassignedLoadIds: plan.value.unassignedLoadIds,
        totals: {
          revenueCents: plan.value.totalRevenueCents,
          marginCents: plan.value.totalMarginCents,
          deadheadMiles: plan.value.totalDeadheadMiles,
        },
        applied: apply ? assigned : 0,
      });
    } catch (error) {
      return sendError(reply, error);
    }
    },
  );

  app.post('/dispatch/match', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const world = await loadDispatchWorld(services, actor.company);

      const matches = matchLoadsToTrucks({
        loads: world.loads,
        trucks: world.trucks,
        drivers: world.drivers,
        readiness: world.readiness,
        now: world.now,
      });

      if (!matches.ok) throw matches.error;
      return reply.send(matches.value);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* --------------------------------------------------------- transitions */

  app.post<{ Params: { id: string } }>('/loads/:id/status', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({
          to: z.enum(['booked', 'dispatched', 'in-transit', 'delivered', 'paid']),
          note: z.string().optional(),
        })
        .parse(request.body);

      const outcome = await updateLoadStatus(services, actor.company, {
        loadId: request.params.id,
        to: body.to,
        note: body.note,
        actorId: actor.sub,
      });

      return reply.send({ load: outcome.load });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/loads/:id/cancel', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z.object({ reason: z.string().min(1) }).parse(request.body);
      const load = await cancelLoadService(services, actor.company, {
        loadId: request.params.id,
        reason: body.reason,
        actorId: actor.sub,
      });
      return reply.send({ load });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* ---------------------------------------------------------------- stops */

  app.post<{ Params: { id: string; stopId: string } }>(
    '/loads/:id/stops/:stopId/arrive',
    { preHandler: app.authenticate },
    async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({
          notes: z.string().optional(),
          location: z.object({ lat: z.number(), lng: z.number() }).optional(),
        })
        .parse(request.body ?? {});

      const outcome = await arriveStopService(services, actor.company, {
        loadId: request.params.id,
        stopId: request.params.stopId,
        actorId: actor.sub,
        notes: body.notes,
        location: body.location,
      });

      return reply.send({ load: outcome.load, warnings: outcome.warnings });
    } catch (error) {
      return sendError(reply, error);
    }
    },
  );

  app.post<{ Params: { id: string; stopId: string } }>(
    '/loads/:id/stops/:stopId/complete',
    { preHandler: app.authenticate },
    async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({
          signatureName: z.string().optional(),
          receiverName: z.string().optional(),
          notes: z.string().optional(),
          location: z.object({ lat: z.number(), lng: z.number() }).optional(),
          documents: z
            .array(
              z.object({
                type: z.enum([
                  'rate_con',
                  'bol',
                  'pod',
                  'lumper_receipt',
                  'tif',
                  'fuel_receipt',
                  'damage_photo',
                  'driver_signature',
                  'w9',
                  'insurance_cert',
                  'exemption',
                ]),
                fileName: z.string(),
                storageKey: z.string(),
                mimeType: z.string(),
                sizeBytes: z.number().int(),
                capturedAt: z.string().optional(),
                signatureName: z.string().optional(),
                signatureDataUrl: z.string().optional(),
              }),
            )
            .optional(),
        })
        .parse(request.body ?? {});

      const documents = [];
      for (const candidate of body.documents ?? []) {
        const made = makeDocument({
          loadId: request.params.id,
          companyId: actor.company,
          ...candidate,
          uploadedBy: actor.sub,
          capturedAt: candidate.capturedAt ?? new Date().toISOString(),
          geo: body.location,
        });
        if (!made.ok) throw made.error;
        documents.push(made.value);
      }

      const outcome = await completeStopService(services, actor.company, {
        loadId: request.params.id,
        stopId: request.params.stopId,
        actorId: actor.sub,
        signatureName: body.signatureName,
        receiverName: body.receiverName,
        notes: body.notes,
        location: body.location,
        documents,
      });

      return reply.send({ load: outcome.load, warnings: outcome.warnings });
    } catch (error) {
      return sendError(reply, error);
    }
    },
  );

  /* ----------------------------------------------------------- documents */

  app.post<{ Params: { id: string } }>('/loads/:id/documents', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({
          type: z.string().min(1),
          fileName: z.string().min(1),
          storageKey: z.string().min(1),
          mimeType: z.string().min(1),
          sizeBytes: z.number().int().positive(),
          capturedAt: z.string().optional(),
          geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
          signatureName: z.string().optional(),
          signatureDataUrl: z.string().optional(),
          pageCount: z.number().int().optional(),
        })
        .parse(request.body);

      const made = makeDocument({
        loadId: request.params.id,
        companyId: actor.company,
        type: body.type as never,
        fileName: body.fileName,
        storageKey: body.storageKey,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
        uploadedBy: actor.sub,
        capturedAt: body.capturedAt,
        geo: body.geo,
        signatureName: body.signatureName,
        signatureDataUrl: body.signatureDataUrl,
        pageCount: body.pageCount,
      });
      if (!made.ok) throw made.error;

      const attached = await attachDocument(services, actor.company, request.params.id, made.value);
      return reply.code(201).send({ document: attached });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/loads/:id/documents', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const documents = await company.documents.findForLoad(request.params.id);
      return reply.send({ documents });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* --------------------------------------------------------------- PDFs */

  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>(
    '/loads/:id/document.pdf',
    { preHandler: app.authenticate },
    async (request, reply) => {
      try {
        const actor = requireActor(request);
        const kind = (request.query.kind ?? 'bol') as 'rate_con' | 'bol' | 'pod';
        if (!['rate_con', 'bol', 'pod'].includes(kind)) {
          throw Errors.invalidInput(`Unknown document kind "${kind}"`);
        }

        const company = services.forCompany(actor.company);
        const [loads, truck] = await Promise.all([
          company.loads.query({ companyId: actor.company, limit: 1 }),
          company.trucks.query(actor.company),
        ]);
        void loads;

        const document = await loadDocument(
          services,
          actor.company,
          request.params.id,
          kind,
          {
            companyName: `TruckDesk demo (${actor.company})`,
            driverName: actor.driverId,
            truckUnit: truck[0]?.unit,
          },
        );

        return reply
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', `inline; filename="${document.fileName}"`)
          .header('X-Pdf-Renderer', document.renderer)
          .send(Buffer.from(document.bytes));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /* ---------------------------------------------------------- inspections */

  app.get('/loads/analysis/exceptions', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const page = await company.loads.query({ companyId: actor.company, limit: 200 });

      return reply.send({
        exceptions: page.items
          .map((load) => ({
            loadId: load.id,
            broker: load.broker,
            lane: `${load.origin} -> ${load.destination}`,
            status: load.status,
            rate: load.rate,
            rateFormatted: formatUsd(load.rate),
            flags: rateRedFlags(load),
            analysis: analyzeRate(load),
          }))
          .filter((row) => row.flags.length > 0),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/loads/analysis/checklists', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const page = await company.loads.query({ companyId: actor.company, limit: 200 });

      const outstanding = outstandingDocuments(page.items).map((item) => ({
        loadId: item.load.id,
        broker: item.load.broker,
        status: item.load.status,
        missing: item.missing,
        blockers: item.blockers,
        progress: captureProgress(item.load),
      }));

      return reply.send({ outstanding, count: outstanding.length });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/loads/:id/checklist', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const load = await company.loads.findById(request.params.id);
      if (!load) throw Errors.notFound('Load', request.params.id);
      const documents = await company.documents.findForLoad(load.id);
      const enriched: Load = { ...load, documents };

      return reply.send({
        checklist: buildChecklist(enriched, { carrierHasW9: true, carrierHasInsurance: true }),
        capture: captureProgress(enriched),
        redFlags: rateRedFlags(enriched),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* ------------------------------------------------------ offline replay */

  /**
   * Offline queue flush. The phone sends everything it created while it had no
   * signal, with its own ids, and retries until it succeeds. Existing ids are
   * updated rather than duplicated.
   */
  app.post('/loads/bulk-upsert', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({
          loads: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
        })
        .parse(request.body);

      const company = services.forCompany(actor.company);
      const result = await company.loads.upsertMany(body.loads as never);

      return reply.send({
        inserted: result.inserted,
        existing: result.existing,
        insertedCount: result.inserted.length,
        existingCount: result.existing.length,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

/** The company id always comes from the token, never from the payload. */
function requireActor(request: { actor?: { company: string; sub: string; role: string; driverId?: string } }) {
  if (!request.actor) throw Errors.unauthorized('Authentication required');
  return request.actor;
}