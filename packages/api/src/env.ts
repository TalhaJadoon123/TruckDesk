import { z } from 'zod';

/**
 * Environment.
 *
 * Every variable has a default that makes the app boot. That is deliberate:
 * a carrier should be able to `pnpm dev` and see a working dispatch board
 * before signing up for anything. A missing key degrades a feature; it never
 * crashes the process.
 */

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  });

const stringish = z.string().optional().transform((value) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
});

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /* --- server ---------------------------------------------------------- */
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  /** Comma-separated list of allowed origins. `*` in development only. */
  CORS_ORIGINS: stringish,

  /* --- database -------------------------------------------------------- */
  /**
   * Works with Neon, Supabase (direct or pooler), or a local Postgres.
   * Supabase pooler hostnames need `?sslmode=require`, which the docs cover.
   */
  DATABASE_URL: stringish,
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** `prepare: false` is required for transaction-mode poolers (Supabase). */
  DATABASE_PREPARE: boolish.default(true),

  /* --- supabase (optional: realtime tracking + storage) ---------------- */
  SUPABASE_URL: stringish,
  SUPABASE_ANON_KEY: stringish,
  SUPABASE_SERVICE_ROLE_KEY: stringish,

  /* --- auth ------------------------------------------------------------ */
  AUTH_SECRET: stringish,
  /** Used to sign API tokens the web app sends to the API. */
  API_TOKEN_SECRET: stringish,
  /** Comma-separated list of user ids that may act as a dispatcher in dev. */
  DEV_ADMIN_IDS: stringish,

  /* --- llm -------------------------------------------------------------- */
  GROQ_API_KEY: stringish,
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_BASE_URL: z.string().default('https://api.groq.com/openai/v1'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

  /* --- notifications ---------------------------------------------------- */
  EXPO_ACCESS_TOKEN: stringish,
  TWILIO_ACCOUNT_SID: stringish,
  TWILIO_AUTH_TOKEN: stringish,
  TWILIO_MESSAGING_SERVICE_SID: stringish,
  TWILIO_FROM: stringish,
  /** Off by default: see packages/sms for why. */
  SMS_ENABLED: boolish.default(false),

  /* --- eld (optional) ---------------------------------------------------- */
  SAMSARA_TOKEN: stringish,
  MOTIVE_ACCESS_TOKEN: stringish,

  /* --- email (optional) ------------------------------------------------- */
  /** Cloudflare Email Worker binding name or SMTP-less HTTP endpoint. */
  EMAIL_WORKER_URL: stringish,
  EMAIL_FROM: z.string().default('TruckDesk <no-reply@truckdesk.app>'),

  /* --- payments --------------------------------------------------------- */
  POLAR_API_KEY: stringish,
  POLAR_WEBHOOK_SECRET: stringish,
  PAYMENTS_PROVIDER: z.enum(['polar', 'lemonsqueezy', 'none']).default('polar'),

  /* --- storage ---------------------------------------------------------- */
  /** Supabase Storage bucket for BOL/POD images. */
  STORAGE_BUCKET: z.string().default('load-documents'),
  /**
   * Maximum size of a single uploaded file. Kept in step with
   * `MAX_PHOTO_BYTES` in `@truckdesk/loads`; the Fastify body limit is derived
   * from this to allow for base64 inflation.
   */
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(25 * 1024 * 1024).default(12 * 1024 * 1024),

  /* --- ops -------------------------------------------------------------- */
  /** Restrict destructive/seed endpoints. */
  ALLOW_SEED: boolish.default(false),
  /** Seeded demo login, dev only. */
  DEMO_EMAIL: z.string().default('dispatcher@ridgewayfreight.com'),
  DEMO_PASSWORD: z.string().default('truckdesk-demo'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}

/** In production, warn loudly about the optional keys that are missing. */
export function describeCapabilities(env: Env): {
  name: string;
  enabled: boolean;
  detail: string;
}[] {
  return [
    {
      name: 'database',
      enabled: Boolean(env.DATABASE_URL),
      detail: env.DATABASE_URL
        ? 'Postgres via Drizzle'
        : 'No DATABASE_URL: running on the in-memory store. Data resets on restart.',
    },
    {
      name: 'supabase-realtime',
      enabled: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
      detail: env.SUPABASE_URL
        ? 'Realtime tracking channel enabled'
        : 'No Supabase keys: tracking runs on the in-process engine only',
    },
    {
      name: 'groq-llm',
      enabled: Boolean(env.GROQ_API_KEY),
      detail: env.GROQ_API_KEY
        ? `Broker email parsing via ${env.GROQ_MODEL}`
        : 'No GROQ_API_KEY: broker emails parse with the deterministic parser',
    },
    {
      name: 'expo-push',
      enabled: true,
      detail: env.EXPO_ACCESS_TOKEN
        ? 'Push enabled (with access token for higher limits)'
        : 'Push enabled on the free tier (no token)',
    },
    {
      name: 'twilio-sms',
      enabled: env.SMS_ENABLED && Boolean(env.TWILIO_ACCOUNT_SID),
      detail: env.SMS_ENABLED
        ? 'SMS enabled on Twilio free trial credit'
        : 'SMS disabled by default; push carries driver notifications',
    },
    {
      name: 'email',
      enabled: Boolean(env.EMAIL_WORKER_URL),
      detail: env.EMAIL_WORKER_URL ? 'Cloudflare Email Worker' : 'No email worker configured',
    },
    {
      name: 'payments',
      enabled: Boolean(env.POLAR_API_KEY),
      detail: env.POLAR_API_KEY ? `Billing via ${env.PAYMENTS_PROVIDER}` : 'No payment provider key',
    },
  ];
}

let cached: Env | null = null;

/** Process-wide env singleton. Tests can call `resetEnvForTests`. */
export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

export function resetEnvForTests(): void {
  cached = null;
}

/** Read an env var without validating the whole schema. Used by the Worker. */
export function envValue(source: Record<string, string | undefined>, key: string): string | undefined {
  const value = source[key];
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}