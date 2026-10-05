import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { Errors, PLANS, PLANS as PLANS_TABLE, formatUsd, startOfWeekIso } from '@truckdesk/shared';
import { planCatalog } from '@truckdesk/core';
import { importCsv, normalizeLoadDraft } from '@truckdesk/loads';
import { parseBrokerEmail, summarizeOutcome } from '@truckdesk/llm';

import { sendError } from '../auth.plugin.js';
import { createLoadService } from '../services/dispatch.service.js';
import {
  calculateIftaService,
  iftaJurisdictions,
  publicIftaCalculator,
} from '../services/ifta.service.js';
import {
  aging,
  approveSettlementService,
  buildInvoiceForBroker,
  invoicePdf,
  type BillingOutcome,
  loadQuickPay,
  paySettlementService,
  quickPayQuoteFor,
  recordPayment,
  runSettlements,
  sendInvoice,
  signSettlementService,
  weeklyBilling,
} from '../services/money.service.js';
import type { Services } from '../services/container.js';

/**
 * Money routes plus the public, unauthenticated endpoints: the marketing IFTA
 * calculator, pricing, and health.
 */

export default async function financeRoutes(app: FastifyInstance, options: { services: Services }): Promise<void> {
  const { services } = options;

  /* ----------------------------------------------------------------- IFTA */

  app.get('/ifta/jurisdictions', { preHandler: app.authenticate }, async (_request, reply) => {
    return reply.send({ jurisdictions: iftaJurisdictions() });
  });

  app.post('/ifta/calculate', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({
          periodLabel: z.string().optional(),
          year: z.number().int().optional(),
          quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
          truckIds: z.array(z.string()).optional(),
          mileage: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
          overrides: z.record(z.string(), z.record(z.string(), z.union([z.number(), z.boolean()]))).optional(),
        })
        .parse(request.body ?? {});

      const result = await calculateIftaService(services, actor.company, body as never);

      return reply.send({
        ...result,
        formatted: { netTaxDue: formatUsd(result.netTaxDueCents), fuelCost: formatUsd(result.fuelCostCents) },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* ---------------------------------------------------------- settlements */

  app.post('/settle', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({
          week: z.string().optional(),
          driverId: z.string().optional(),
          persist: z.boolean().optional(),
        })
        .parse(request.body ?? {});

      const week = body.week ? startOfWeekIso(body.week) : undefined;

      const result = await runSettlements(services, actor.company, {
        ...(week ? { week } : {}),
        ...(body.driverId ? { driverId: body.driverId } : {}),
        ...(body.persist !== undefined ? { persist: body.persist } : {}),
      });

      return reply.send({
        ...result,
        formatted: {
          totalNet: formatUsd(result.totalNetCents),
          totalMargin: formatUsd(result.totalMarginCents),
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/settle', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const query = z
        .object({
          driverId: z.string().optional(),
          status: z.enum(['draft', 'approved', 'paid', 'void']).optional(),
        })
        .parse(request.query ?? {});

      const settlements = await company.settlements.query(actor.company, {
        ...(query.driverId ? { driverId: query.driverId } : {}),
        ...(query.status ? { status: query.status } : {}),
      });

      return reply.send({ settlements });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/settle/:id/approve', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const settlement = await approveSettlementService(services, actor.company, request.params.id, actor.sub);
      return reply.send({ settlement });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/settle/:id/sign', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z.object({ signatureName: z.string().min(1) }).parse(request.body);
      const settlement = await signSettlementService(
        services,
        actor.company,
        request.params.id,
        body.signatureName,
      );
      return reply.send({ settlement });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/settle/:id/pay', { preHandler: app.requireBilling }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({ method: z.enum(['direct_deposit', 'check', 'fuel_card', 'other']).optional() })
        .parse(request.body ?? {});
      const settlement = await paySettlementService(
        services,
        actor.company,
        request.params.id,
        body.method ?? 'direct_deposit',
      );
      return reply.send({ settlement });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* ------------------------------------------------------------- invoices */

  app.post('/invoice', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({
          broker: z.string().optional(),
          week: z.string().optional(),
          termsDays: z.number().int().min(0).max(120).optional(),
          quickPayBps: z.number().int().min(0).max(5000).optional(),
        })
        .parse(request.body ?? {});

      let result: BillingOutcome;
      if (body.broker) {
        const invoice = await buildInvoiceForBroker(services, actor.company, body.broker, {
          ...(body.week ? { week: startOfWeekIso(body.week) } : {}),
          ...(body.termsDays !== undefined ? { termsDays: body.termsDays } : {}),
          ...(body.quickPayBps !== undefined ? { quickPayBps: body.quickPayBps } : {}),
        });
        result = {
          invoices: [invoice],
          skipped: [],
          totalCents: invoice.totalCents,
          summary: [`${invoice.brokerName}: ${invoice.lines.length} lines, ${formatUsd(invoice.totalCents)}`],
        };
      } else {
        result = await weeklyBilling(services, actor.company, {
          ...(body.week ? { week: startOfWeekIso(body.week) } : {}),
          ...(body.termsDays !== undefined ? { termsDays: body.termsDays } : {}),
          ...(body.quickPayBps !== undefined ? { quickPayBps: body.quickPayBps } : {}),
        });
      }

      return reply.send({ ...result, formatted: { total: formatUsd(result.totalCents) } });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/invoice', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const company = services.forCompany(actor.company);
      const query = z
        .object({ broker: z.string().optional(), openOnly: z.coerce.boolean().optional() })
        .parse(request.query ?? {});

      const invoices = await company.invoices.query(actor.company, {
        ...(query.broker ? { broker: query.broker } : {}),
        ...(query.openOnly !== undefined ? { openOnly: query.openOnly } : {}),
      });

      return reply.send({ invoices });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/invoice/:id/send', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const invoice = await sendInvoice(services, actor.company, request.params.id);
      return reply.send({ invoice });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/invoice/:id/pay', { preHandler: app.requireBilling }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({
          amountCents: z.number().int().positive().optional(),
          amount: z.number().positive().optional(),
          method: z.enum(['ach', 'check', 'card', 'wire', 'quickpay', 'offset', 'other']),
          reference: z.string().optional(),
          note: z.string().optional(),
          at: z.string().optional(),
        })
        .parse(request.body);

      const amountCents = body.amountCents ?? (body.amount !== undefined ? Math.round(body.amount * 100) : 0);
      if (amountCents <= 0) {
        return reply.code(400).send({
          error: { code: 'INVALID_INPUT', message: 'Provide amountCents or amount' },
        });
      }

      const invoice = await recordPayment(services, actor.company, request.params.id, {
        amountCents,
        method: body.method,
        reference: body.reference,
        note: body.note,
        at: body.at,
      });

      return reply.send({ invoice });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/invoice/:id/quickpay', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const query = z.object({ bps: z.coerce.number().optional() }).parse(request.query ?? {});
      const quote = await quickPayQuoteFor(services, actor.company, request.params.id, query.bps);
      return reply.send({ quote, formatted: { payout: formatUsd(quote.payoutCents), discount: formatUsd(quote.discountCents) } });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/invoice/:id/pdf', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const bytes = await invoicePdf(services, actor.company, request.params.id, {
        name: `TruckDesk (${actor.company})`,
      });
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="invoice-${request.params.id}.pdf"`)
        .send(Buffer.from(bytes));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/invoice/aging', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const report = await aging(services, actor.company);
      return reply.send({
        ...report,
        formatted: {
          totalOutstanding: formatUsd(report.totalOutstandingCents),
          totalOverdue: formatUsd(report.totalOverdueCents),
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /* --------------------------------------------------- broker email parse */

  /**
   * The feature that saves a dispatcher the most time: paste a broker email and
   * get a load. Returns the parse with per-field confidence so the dispatcher
   * confirms rather than trusts.
   */
  app.post('/loads/parse-email', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z
        .object({
          subject: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          body: z.string().min(1),
          receivedAt: z.string().optional(),
          /** Set false to skip the model and use the deterministic parser. */
          useLlm: z.boolean().optional(),
          /** Create the load as well as parsing it. */
          book: z.boolean().optional(),
        })
        .parse(request.body);

      const result = await parseBrokerEmail(
        {
          subject: body.subject,
          from: body.from,
          to: body.to,
          body: body.body,
          receivedAt: body.receivedAt,
        },
        services.llm,
        {
          companyId: actor.company,
          deterministic: body.useLlm === false,
        },
      );

      if (!result.ok) throw result.error;

      const outcome = result.value;

      let createdLoadId: string | null = null;
      if (body.book && outcome.load) {
        const created = await createLoadService(
          services,
          actor.company,
          {
            broker: outcome.load.broker,
            origin: outcome.load.origin,
            destination: outcome.load.destination,
            rate: outcome.load.rate,
            miles: outcome.load.miles,
            reference: outcome.load.reference,
            commodity: outcome.load.commodity,
            weightLbs: outcome.load.weightLbs,
            equipment: outcome.load.equipment,
            pickupDate: outcome.load.pickupDate,
            deliveryDate: outcome.load.deliveryDate,
            source: 'email',
            notes: outcome.load.notes,
          },
          actor.sub,
        );
        createdLoadId = created.id;
      }

      return reply.send({
        ...outcome,
        summary: summarizeOutcome(outcome),
        createdLoadId,
        llmLive: services.llm.isLive(),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** CSV bulk import from a broker's export. */
  app.post('/loads/import-csv', { preHandler: app.requireDispatch }, async (request, reply) => {
    try {
      const actor = requireActor(request);
      const body = z.object({ csv: z.string().min(1), book: z.boolean().optional() }).parse(request.body);

      const parsed = importCsv(body.csv);
      const created: string[] = [];

      if (body.book) {
        for (const entry of parsed.drafts) {
          const load = await createLoadService(
            services,
            actor.company,
            {
              broker: entry.draft.broker,
              origin: entry.draft.origin,
              destination: entry.draft.destination,
              rate: entry.draft.rateCents,
              miles: entry.draft.miles,
              reference: entry.draft.reference,
              commodity: entry.draft.commodity,
              weightLbs: entry.draft.weightLbs,
              equipment: entry.draft.equipment,
              pickupDate: entry.draft.pickupDate,
              deliveryDate: entry.draft.deliveryDate,
              source: 'import',
            },
            actor.sub,
          );
          created.push(load.id);
        }
      }

      return reply.send({
        totalRows: parsed.rows.length,
        valid: parsed.drafts.length,
        failed: parsed.failures.length,
        drafts: body.book ? undefined : parsed.drafts,
        failures: parsed.failures,
        createdCount: created.length,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Normalize a single ad-hoc payload without persisting it. */
  app.post('/loads/normalize', { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const body = z.record(z.string(), z.unknown()).parse(request.body);
      return reply.send(normalizeLoadDraft(body));
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

/**
 * Public routes: no auth, capped, read-only. These power the marketing site and
 * are also what a carrier can hit before anyone has created an account.
 */
export async function publicRoutes(app: FastifyInstance, options: { services: Services }): Promise<void> {
  const { services } = options;

  app.get('/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      service: 'truckdesk-api',
      version: '1.0.0',
      mode: services.memory ? 'memory' : 'postgres',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, string> = { api: 'ok' };
    checks['database'] = services.db ? 'ok' : 'skipped (in-memory)';
    checks['groq'] = services.llm.isLive() ? 'ok' : 'fallback (no API key)';
    checks['push'] = services.notifier.providerStatus().find((p) => p.name === 'push')?.configured
      ? 'ok'
      : 'disabled';

    const ready = Boolean(services.db) || services.memory;
    return reply.code(ready ? 200 : 503).send({ ready, checks });
  });

  app.get('/pricing', async (_request, reply) => {
    const catalog = planCatalog();
    return reply.send({
      plans: catalog.plans.map((plan) => ({
        ...plan,
        priceFormatted: plan.priceCents === 0 ? 'Free' : formatUsd(plan.priceCents),
        annualCents: catalog.prices[plan.id].annualCents,
        annualFormatted: formatUsd(catalog.prices[plan.id].annualCents),
      })),
      features: catalog.features,
    });
  });

  /** Public plan catalog, also used by the marketing pricing table. */
  app.get('/public/plans', async (_request, reply) => {
    const catalog = planCatalog();
    return reply.send({
      plans: catalog.plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        tagline: plan.tagline,
        priceCents: plan.priceCents,
        priceFormatted: plan.priceCents === 0 ? 'Free' : `${formatUsd(plan.priceCents)}/mo`,
        maxTrucks: plan.maxTrucks,
        maxDrivers: plan.maxDrivers,
        features: plan.features,
        limits: plan.limits,
        highlight: plan.highlight ?? false,
        cta: plan.cta,
      })),
      features: catalog.features,
    });
  });

  app.get('/plans', async (_request, reply) => {
    return reply.send({ plans: PLANS_TABLE });
  });

  /**
   * The free IFTA calculator.
   *
   * Public by design: it is the marketing hook and it does the same work as the
   * in-app calculator, so a prospect can check their own quarterly exposure
   * before paying for anything.
   */
  app.post('/public/ifta', async (request, reply) => {
    try {
      const body = z
        .object({
          milesByState: z.record(z.string(), z.number().min(0)),
          gallonsByState: z.record(z.string(), z.number().min(0)).optional(),
          mpg: z.number().positive().optional(),
          period: z.string().optional(),
          rateOverrides: z.record(z.string(), z.number()).optional(),
        })
        .parse(request.body);

      return reply.send(publicIftaCalculator(body));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Sign in.
   *
   * Validates a scrypt password hash against the users table and returns an
   * API token. Kept public because it is the credential exchange itself; it is
   * rate limited by the global limiter and always performs a scrypt comparison,
   * so a wrong email costs the same as a wrong password.
   */
  app.post('/public/login', async (request, reply) => {
    try {
      const body = z
        .object({
          email: z.email(),
          password: z.string().min(1),
        })
        .parse(request.body);

      if (!services.db) {
      app.recordLoginFailure(request.ip);
        return reply.code(503).send({
          error: {
            code: 'CONFIGURATION',
            message:
              'Sign-in needs a database. Run `pnpm seed` for the in-memory demo, or set DATABASE_URL.',
          },
        });
      }

      const { users } = await import('../db/schema.js');
      const { eq } = await import('drizzle-orm');

      const rows = await services.db
        .select()
        .from(users)
        .where(eq(users.email, body.email.toLowerCase()))
        .limit(1);

      const row = rows[0];

      const { verifyPassword } = await import('../auth.js');

      // Always run the comparison so a missing user is not faster than a
      // wrong password.
      const ok = await verifyPassword(
        body.password,
        row?.passwordHash ?? 'scrypt$00$00',
      );

      if (!row || !ok) {
        // Counted so the per-IP lockout in server.ts can trip.
        app.recordLoginFailure(request.ip);
        return reply.code(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Those credentials did not work' },
        });
      }

      const { issueApiToken } = await import('../auth.js');
      const secret = services.env.API_TOKEN_SECRET ?? services.env.AUTH_SECRET;
      if (!secret) {
        return reply.code(500).send({
          error: { code: 'CONFIGURATION', message: 'API_TOKEN_SECRET is not configured' },
        });
      }

      await services.db
        .update(users)
        .set({ lastLoginAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, row.id));

      return reply.send({
        token: issueApiToken(
          {
            sub: row.id,
            company: row.companyId,
            role: row.role,
            ...(row.driverId ? { driverId: row.driverId } : {}),
          },
          secret,
          60 * 60 * 12,
        ),
        userId: row.id,
        companyId: row.companyId,
        role: row.role,
        name: row.name,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Trial signup. Creates the company and a dispatcher user in one call. */
  app.post('/signup', async (request, reply) => {
    try {
      const body = z
        .object({
          companyName: z.string().min(1),
          email: z.email(),
          name: z.string().min(1),
          password: z.string().min(8),
          trucks: z.number().int().min(0).max(50).optional(),
        })
        .parse(request.body);

      const result = await signup(services, body);
      return reply.code(201).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

async function signup(
  services: Services,
  input: { companyName: string; email: string; name: string; password: string; trucks?: number },
) {
  const { hashPassword, issueApiToken } = await import('../auth.js');
  const companyId = `co_${input.email.split('@')[1]?.replace(/\W/g, '').slice(0, 8) ?? 'demo'}`;
  const userId = `us_${input.email.length}${Date.now().toString(36).slice(-6)}`;

  if (services.db) {
    const { companies, users } = await import('../db/schema.js');
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + 14 * 86_400_000);

    const exists = await services.db
      .select({ id: users.id })
      .from(users)
      .where((await import('drizzle-orm')).eq(users.email, input.email))
      .limit(1);

    if (exists.length > 0) {
      throw (await import('@truckdesk/shared')).Errors.conflict('An account with that email already exists');
    }

    await services.db.insert(companies).values({
      id: companyId,
      name: input.companyName,
      plan: 'starter',
      trialEndsAt,
      subscriptionStatus: 'trialing',
      createdAt: now,
      updatedAt: now,
    });

    await services.db.insert(users).values({
      id: userId,
      companyId,
      email: input.email,
      name: input.name,
      role: 'owner',
      passwordHash: await hashPassword(input.password),
      plan: 'starter',
      createdAt: now,
      updatedAt: now,
    });
  }

  const secret = services.env.API_TOKEN_SECRET ?? services.env.AUTH_SECRET;
  const token = secret
    ? issueApiToken({ sub: userId, company: companyId, role: 'owner' }, secret, 60 * 60 * 24 * 30)
    : null;

  return {
    companyId,
    userId,
    token,
    plan: 'starter',
    trialDays: 14,
    note: services.db
      ? 'Account created. Seed trucks with `pnpm seed:demo`.'
      : 'Running without a database: the account is not persisted. Set DATABASE_URL to keep it.',
  };
}

function requireActor(request: { actor?: { company: string; sub: string; role: string; driverId?: string } }) {
  if (!request.actor) throw Errors.unauthorized('Authentication required');
  return request.actor;
}

export { PLANS, loadQuickPay };
