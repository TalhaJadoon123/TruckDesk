import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { Errors } from '@truckdesk/shared';
import { capabilityCatalog } from '@truckdesk/integrations';

import { sendError } from '../auth.plugin.js';
import { IntegrationService } from '../services/integrations.service.js';
import type { Services } from '../services/container.js';

/**
 * Public API integration routes.
 *
 * Everything here is optional and keyless. A failure returns a 200 with a
 * degraded payload rather than an error, because "the weather service is down"
 * must never look like "your load is broken".
 */

export default async function integrationRoutes(
  app: FastifyInstance,
  options: { services: Services },
): Promise<void> {
  const integrations = new IntegrationService(options.services);

  /** What is wired, and what breaks when it is unreachable. */
  app.get('/integrations', { preHandler: app.authenticate }, async (_request, reply) => {
    return reply.send({ integrations: capabilityCatalog() });
  });

  /** Weather for a lane written as free text. */
  app.get('/integrations/lane', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const query = z
        .object({
          from: z.string().min(2).max(120),
          to: z.string().min(2).max(120),
        })
        .parse(request.query ?? {});

      const brief = await integrations.lane(query.from, query.to);
      return reply.send(brief);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Weather for a load, using its stop coordinates. */
  app.get<{ Params: { id: string } }>(
    '/integrations/load/:id/weather',
    { preHandler: app.authenticate },
    async (request, reply) => {
      try {
        const actor = requireActor(request);
        const company = options.services.forCompany(actor.company);
        const load = await company.loads.findById(request.params.id);
        if (!load) throw Errors.notFound('Load', request.params.id);

        const pickup = load.stops?.find((stop) => stop.type === 'pickup')?.location;
        const delivery = load.stops?.find((stop) => stop.type === 'delivery')?.location;

        // Falls back to geocoding the written lane when the stops have no point.
        if (!pickup || !delivery) {
          const brief = await integrations.lane(load.origin, load.destination);
          return reply.send({ ...brief.weather, source: brief.geocoded ? brief.weather.source : 'none' });
        }

        const weather = await integrations.loadWeather(pickup, delivery);
        return reply.send(weather);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  /** Geocode a single location. */
  app.get('/integrations/geocode', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const query = z.object({ q: z.string().min(2).max(160) }).parse(request.query ?? {});
      const result = await integrations.geocode(query.q);

      if (!result.ok) {
        // Not found is a real answer; a transport failure is not a 500 either.
        return reply.send({
          ok: false,
          point: null,
          error: result.error ?? 'Could not resolve that location',
          hint: 'TruckDesk falls back to a state-centroid approximation when a lookup fails.',
        });
      }

      return reply.send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** VIN lookup for the truck form. */
  app.post('/integrations/vin', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const body = z.object({ vin: z.string().min(17).max(17) }).parse(request.body);
      const result = await integrations.decodeVin(body.vin);

      if (!result.ok) {
        return reply.status(400).send({
          ok: false,
          fields: null,
          error: result.error ?? 'Could not decode that VIN',
        });
      }

      return reply.send({ ok: true, fields: result.data, source: result.source });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Active severe alerts at a point. */
  app.get('/integrations/alerts', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const query = z
        .object({ lat: z.coerce.number(), lng: z.coerce.number() })
        .parse(request.query ?? {});

      const result = await integrations.alerts({ lat: query.lat, lng: query.lng });

      if (!result.ok) {
        return reply.send({ ok: false, alerts: [], error: result.error });
      }
      return reply.send({ ok: true, alerts: result.data });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function requireActor(request: { actor?: { company: string; sub: string; role: string } }) {
  if (!request.actor) throw Errors.unauthorized('Authentication required');
  return request.actor;
}