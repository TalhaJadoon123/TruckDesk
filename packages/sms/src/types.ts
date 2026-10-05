import type { Iso } from '@truckdesk/shared';

/**
 * Notification ports and the message shape every channel receives.
 *
 * v1 ships push as the primary channel because push is genuinely free (Expo's
 * push service has no per-message charge), and SMS behind an explicit guard so a
 * carrier cannot accidentally burn their Twilio trial credit overnight. SMS is
 * opt-in per carrier and per recipient.
 */

export type NotificationChannel = 'push' | 'sms' | 'email' | 'in_app';

export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export type NotificationKind =
  | 'load_assigned'
  | 'load_delivered'
  | 'load_cancelled'
  | 'stop_arrived'
  | 'pod_missing'
  | 'rate_con_ready'
  | 'hos_warning'
  | 'hos_violation'
  | 'invoice_sent'
  | 'invoice_paid'
  | 'invoice_overdue'
  | 'settlement_ready'
  | 'settlement_paid'
  | 'truck_maintenance'
  | 'document_rejected';

export interface NotificationMessage {
  id: string;
  companyId?: string;
  kind: NotificationKind;
  priority: NotificationPriority;
  /** Short title for the push banner. Max ~40 characters before truncation. */
  title: string;
  body: string;
  /** Deep link into the app, e.g. `/driver/loads/ld_123`. */
  url?: string;
  /** Id of the entity this is about. */
  entityType?: 'load' | 'truck' | 'driver' | 'invoice' | 'settlement';
  entityId?: string;
  /** Free-form key/value pairs for the client's deep-link resolver. */
  data?: Record<string, string | number | boolean>;
  createdAt: Iso;
}

export interface NotificationRecipient {
  /** User id, when the recipient is a logged-in user. */
  userId?: string;
  driverId?: string;
  /** Expo push token: ExponentPushToken[xxx] or a raw token. */
  pushToken?: string;
  /** E.164, e.g. +15551234567. */
  phone?: string;
  email?: string;
  name?: string;
  role?: 'driver' | 'dispatcher' | 'owner' | 'admin';
  /** Per-recipient channel opt-outs, applied after the carrier-level policy. */
  channels?: Partial<Record<NotificationChannel, boolean>>;
  timezone?: string;
  /** Local hour, 0-23, after which non-urgent messages are held. */
  quietHoursStart?: number;
  quietHoursEnd?: number;
}

export interface DeliveryReceipt {
  channel: NotificationChannel;
  provider: string;
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  /** True when the message was skipped (quiet hours, opt-out, no address). */
  skipped?: boolean;
  skipReason?: string;
  costCents?: number;
  at: Iso;
}

export interface DeliveryResult {
  messageId: string;
  receipts: DeliveryReceipt[];
  delivered: number;
  failed: number;
  skipped: number;
}

export interface NotificationProvider {
  readonly name: string;
  /** False when the provider has no credentials and cannot send. */
  isConfigured(): boolean;
  /** True when the provider costs money per message. */
  readonly paid: boolean;
  send(message: NotificationMessage, recipient: NotificationRecipient): Promise<DeliveryReceipt>;
}

/* -------------------------------------------------------------------------- */
/* Delivery policy                                                               */
/* -------------------------------------------------------------------------- */

export interface DeliveryPolicy {
  /** Channels the carrier has enabled. */
  enabledChannels: NotificationChannel[];
  /** Suppress SMS entirely. True by default in v1. */
  smsEnabled: boolean;
  /** Hard cap on SMS per day, per recipient. Protects free trial credit. */
  smsDailyCap: number;
  /** Deduplicate identical (kind, entityId) messages inside this window. */
  dedupeWindowMs: number;
  /** Hold non-urgent messages during the recipient's quiet hours. */
  respectQuietHours: boolean;
  /** Kinds that ignore quiet hours. */
  alwaysUrgent: NotificationKind[];
}

export const DEFAULT_POLICY: DeliveryPolicy = {
  enabledChannels: ['push', 'in_app'],
  smsEnabled: false,
  smsDailyCap: 20,
  dedupeWindowMs: 5 * 60_000,
  respectQuietHours: true,
  alwaysUrgent: ['hos_violation', 'invoice_overdue'],
};

/** SMS is free-tier-hostile, so it must be enabled on purpose. */
export function smsAllowed(policy: DeliveryPolicy, recipient: NotificationRecipient): boolean {
  if (!policy.smsEnabled) return false;
  if (!recipient.phone) return false;
  if (recipient.channels?.sms === false) return false;
  return true;
}

export function channelsFor(
  policy: DeliveryPolicy,
  recipient: NotificationRecipient,
  kind: NotificationKind,
): NotificationChannel[] {
  const urgent = policy.alwaysUrgent.includes(kind);

  // `smsEnabled` is the switch that matters for SMS; `enabledChannels` is the
  // list the carrier configured for push and in-app. Turning SMS on without also
  // listing it here would silently never deliver, which is a trap, so it is
  // unioned in rather than left to the caller to remember.
  const enabled = policy.smsEnabled
    ? ([...new Set([...policy.enabledChannels, 'sms'])] as NotificationChannel[])
    : policy.enabledChannels;

  return enabled.filter((channel) => {
    if (recipient.channels && recipient.channels[channel] === false) return false;

    if (channel === 'sms') {
      if (!urgent) return smsAllowed(policy, recipient);
      // Urgent SMS still needs the carrier to have opted in.
      return policy.smsEnabled && Boolean(recipient.phone);
    }

    if (channel === 'push' && !recipient.pushToken) return false;
    if (channel === 'email' && !recipient.email) return false;
    return true;
  });
}

export interface QuietHoursVerdict {
  quiet: boolean;
  untilIso: Iso | null;
  localHour: number;
}

/**
 * Quiet hours are evaluated in the recipient's local time. This matters: a
 * driver in Fresno should not be woken at 4am UTC because the server is UTC.
 */
export function isQuietHours(
  recipient: NotificationRecipient,
  now: Date,
  respectQuietHours: boolean,
): QuietHoursVerdict {
  const start = recipient.quietHoursStart ?? 22;
  const end = recipient.quietHoursEnd ?? 6;

  if (!respectQuietHours) {
    return { quiet: false, untilIso: null, localHour: now.getUTCHours() };
  }

  const hour = localHourIn(recipient.timezone, now);

  // Windows that wrap midnight, e.g. 22 -> 6.
  const wraps = start > end;
  const quiet = wraps ? hour >= start || hour < end : hour >= start && hour < end;

  if (!quiet) return { quiet: false, untilIso: null, localHour: hour };

  const until = new Date(now.getTime() + hoursUntilLocal(end, hour) * 3_600_000);
  return { quiet: true, untilIso: until.toISOString(), localHour: hour };
}

function hoursUntilLocal(endHour: number, currentHour: number): number {
  return endHour > currentHour ? endHour - currentHour : 24 - currentHour + endHour;
}

/**
 * Local hour for an IANA timezone. Uses Intl, which is available on Node, in
 * Workers and in Hermes; falls back to UTC if the zone string is wrong rather
 * than throwing in a notification path.
 */
export function localHourIn(timezone: string | undefined, now: Date): number {
  if (!timezone) return now.getUTCHours();
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    });
    const parsed = Number.parseInt(formatter.format(now), 10);
    return Number.isFinite(parsed) ? parsed % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                     */
/* -------------------------------------------------------------------------- */

export interface TemplateContext {
  [key: string]: string | number | boolean | undefined | null;
}

export type MessageTemplate = { title: string; body: string };

/**
 * Copy lives here so a dispatcher can read every message the product sends
 * without opening a component, and so tone stays consistent.
 */
export const TEMPLATES: Record<NotificationKind, (ctx: TemplateContext) => MessageTemplate> = {
  load_assigned: (ctx) => ({
    title: 'New load',
    body: `${String(ctx.lane ?? 'Load')}${ctx.rate ? ` - $${ctx.rate}` : ''}. Pickup ${String(ctx.pickup ?? '')}.`,
  }),
  load_delivered: (ctx) => ({
    title: 'Delivered',
    body: `${String(ctx.lane ?? 'Load')} delivered. POD ${ctx.hasPod ? 'captured' : 'still missing'}.`,
  }),
  load_cancelled: (ctx) => ({
    title: 'Load cancelled',
    body: `${String(ctx.lane ?? 'Load')} was cancelled. ${String(ctx.reason ?? '')}`.trim(),
  }),
  stop_arrived: (ctx) => ({
    title: 'Arrived',
    body: `Arrived at ${String(ctx.facility ?? 'the stop')}.`,
  }),
  pod_missing: (ctx) => ({
    title: 'POD needed',
    body: `${String(ctx.lane ?? 'Load')} is delivered with no POD on file.`,
  }),
  rate_con_ready: (ctx) => ({
    title: 'Rate con ready',
    body: `Rate con for ${String(ctx.lane ?? 'the load')} is ready to review.`,
  }),
  hos_warning: (ctx) => ({
    title: 'HOS warning',
    body: `${String(ctx.driver ?? 'Driver')}: ${String(ctx.message ?? 'hours-of-service warning')}`,
  }),
  hos_violation: (ctx) => ({
    title: 'HOS violation',
    body: `${String(ctx.driver ?? 'Driver')}: ${String(ctx.message ?? 'hours-of-service violation')}`,
  }),
  invoice_sent: (ctx) => ({
    title: 'Invoice sent',
    body: `${String(ctx.broker ?? 'Broker')} invoice ${String(ctx.number ?? '')} for $${String(ctx.amount ?? 0)}.`,
  }),
  invoice_paid: (ctx) => ({
    title: 'Payment received',
    body: `${String(ctx.broker ?? 'Broker')} paid ${String(ctx.amount ?? '')}.`,
  }),
  invoice_overdue: (ctx) => ({
    title: 'Invoice overdue',
    body: `${String(ctx.broker ?? 'Broker')} is ${String(ctx.daysOverdue ?? 0)} days past due on $${String(ctx.amount ?? 0)}.`,
  }),
  settlement_ready: (ctx) => ({
    title: 'Settlement ready',
    body: `Week of ${String(ctx.week ?? '')}: net $${String(ctx.net ?? 0)} ready to sign.`,
  }),
  settlement_paid: (ctx) => ({
    title: 'Settlement paid',
    body: `Week of ${String(ctx.week ?? '')} paid: $${String(ctx.net ?? 0)}.`,
  }),
  truck_maintenance: (ctx) => ({
    title: 'Truck in maintenance',
    body: `${String(ctx.unit ?? 'Truck')} is in the shop.`,
  }),
  document_rejected: (ctx) => ({
    title: 'Document rejected',
    body: `${String(ctx.fileName ?? 'A document')} was rejected: ${String(ctx.reason ?? '')}`,
  }),
};

export function renderTemplate(
  kind: NotificationKind,
  context: TemplateContext,
): MessageTemplate {
  const template = TEMPLATES[kind];
  return template ? template(context) : { title: 'TruckDesk', body: String(context.message ?? '') };
}