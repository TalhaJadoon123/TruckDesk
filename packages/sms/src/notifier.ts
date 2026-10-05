import { isoNow, uuid, type Iso } from '@truckdesk/shared';

import { ExpoPushProvider, isDeadTokenError, type ExpoPushOptions } from './push.js';
import { LogOnlySmsProvider, TwilioSmsProvider, type TwilioOptions } from './twilio.js';
import {
  DEFAULT_POLICY,
  channelsFor,
  isQuietHours,
  renderTemplate,
  type DeliveryPolicy,
  type DeliveryReceipt,
  type DeliveryResult,
  type MessageTemplate,
  type NotificationKind,
  type NotificationMessage,
  type NotificationProvider,
  type NotificationRecipient,
  type TemplateContext,
} from './types.js';

/**
 * Notifier: decides who gets what, on which channel, and when.
 *
 * The policy (channel opt-ins, quiet hours, dedupe, SMS caps) is enforced here
 * rather than in each provider, so a new channel inherits the rules instead of
 * needing them reimplemented.
 */

export interface NotifierOptions {
  push?: ExpoPushOptions;
  twilio?: TwilioOptions;
  policy?: Partial<DeliveryPolicy>;
  /** Clock, injected so tests are deterministic. */
  now?: () => Date;
  /** Sink for in-app notifications. In `packages/api` this writes a row. */
  inAppSink?: (message: NotificationMessage, recipient: NotificationRecipient) => Promise<void> | void;
}

export interface SendInput {
  kind: NotificationKind;
  recipients: NotificationRecipient[];
  context?: TemplateContext;
  companyId?: string;
  priority?: NotificationMessage['priority'];
  entityType?: NotificationMessage['entityType'];
  entityId?: string;
  url?: string;
  data?: Record<string, string | number | boolean>;
  /** Override the template entirely. */
  message?: MessageTemplate;
}

export class Notifier {
  private readonly push: NotificationProvider;
  private readonly sms: NotificationProvider;
  private readonly policy: DeliveryPolicy;
  private readonly now: () => Date;
  private readonly inAppSink?: NotifierOptions['inAppSink'];

  /** (kind, entityId, recipient) -> timestamp of the last send. */
  private readonly dedupe = new Map<string, number>();
  /** recipientKey -> [YYYY-MM-DD, count] for the SMS daily cap. */
  private readonly smsCounters = new Map<string, { day: string; count: number }>();

  constructor(options: NotifierOptions = {}) {
    this.push = new ExpoPushProvider(options.push ?? {});
    this.sms =
      options.twilio && (options.twilio.accountSid || options.twilio.enabled === false)
        ? new TwilioSmsProvider(options.twilio)
        : new LogOnlySmsProvider();
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.now = options.now ?? (() => new Date());
    this.inAppSink = options.inAppSink;
  }

  get activePolicy(): DeliveryPolicy {
    return this.policy;
  }

  /** Which providers are live, for the settings screen. */
  providerStatus(): Array<{ name: string; configured: boolean; paid: boolean }> {
    return [
      { name: 'push', configured: this.push.isConfigured(), paid: this.push.paid },
      { name: 'sms', configured: this.sms.isConfigured(), paid: this.sms.paid },
    ];
  }

  async send(input: SendInput): Promise<DeliveryResult> {
    const now = this.now();
    const template = input.message ?? renderTemplate(input.kind, input.context ?? {});

    const message: NotificationMessage = {
      id: uuid(),
      companyId: input.companyId,
      kind: input.kind,
      priority: input.priority ?? defaultPriority(input.kind),
      title: template.title,
      body: template.body,
      url: input.url,
      entityType: input.entityType,
      entityId: input.entityId,
      data: input.data,
      createdAt: now.toISOString(),
    };

    const receipts: DeliveryReceipt[] = [];

    for (const recipient of input.recipients) {
      const channels = channelsFor(this.policy, recipient, input.kind);

      if (channels.length === 0) {
        receipts.push({
          channel: 'in_app',
          provider: 'policy',
          ok: false,
          skipped: true,
          skipReason: 'No channel available for this recipient',
          at: now.toISOString(),
        });
        continue;
      }

      // Quiet hours hold everything except the kinds the policy marks urgent.
      const quiet = isQuietHours(recipient, now, this.policy.respectQuietHours);
      const isUrgent = this.policy.alwaysUrgent.includes(input.kind);

      for (const channel of channels) {
        if (channel === 'in_app') {
          if (this.inAppSink) {
            try {
              await this.inAppSink(message, recipient);
              receipts.push({
                channel: 'in_app',
                provider: 'sink',
                ok: true,
                at: now.toISOString(),
              });
            } catch (error) {
              receipts.push({
                channel: 'in_app',
                provider: 'sink',
                ok: false,
                error: error instanceof Error ? error.message : 'in_app sink failed',
                at: now.toISOString(),
              });
            }
          } else {
            receipts.push({
              channel: 'in_app',
              provider: 'sink',
              ok: false,
              skipped: true,
              skipReason: 'No in-app sink configured',
              at: now.toISOString(),
            });
          }
          continue;
        }

        if (quiet.quiet && !isUrgent) {
          receipts.push({
            channel,
            provider: 'policy',
            ok: false,
            skipped: true,
            skipReason: `Quiet hours until ${quiet.untilIso ?? 'later'}`,
            at: now.toISOString(),
          });
          continue;
        }

        if (this.isDuplicate(message, recipient, now)) {
          receipts.push({
            channel,
            provider: 'policy',
            ok: false,
            skipped: true,
            skipReason: 'Duplicate inside the dedupe window',
            at: now.toISOString(),
          });
          continue;
        }

        if (channel === 'sms' && !this.consumeSmsQuota(recipient, now)) {
          receipts.push({
            channel,
            provider: 'policy',
            ok: false,
            skipped: true,
            skipReason: `Daily SMS cap of ${this.policy.smsDailyCap} reached`,
            at: now.toISOString(),
          });
          continue;
        }

        const provider = channel === 'push' ? this.push : this.sms;
        const receipt = await provider.send(message, recipient);
        receipts.push(receipt);

        // A dead push token is a permanent address failure: drop it so the
        // dispatcher stops seeing failures for an uninstalled app.
        if (channel === 'push' && !receipt.ok && isDeadTokenError(receipt.error)) {
          receipts.push({
            channel: 'push',
            provider: 'token-cleanup',
            ok: true,
            skipped: true,
            skipReason: 'Push token unregistered; recipient should re-register',
            at: now.toISOString(),
          });
        }
      }
    }

    const delivered = receipts.filter((receipt) => receipt.ok).length;
    const failed = receipts.filter((receipt) => !receipt.ok && !receipt.skipped).length;
    const skipped = receipts.filter((receipt) => receipt.skipped).length;

    return { messageId: message.id, receipts, delivered, failed, skipped };
  }

  private dedupeKey(message: NotificationMessage, recipient: NotificationRecipient): string {
    return `${message.kind}:${message.entityId ?? 'none'}:${recipient.userId ?? recipient.driverId ?? recipient.phone ?? 'anon'}`;
  }

  private isDuplicate(
    message: NotificationMessage,
    recipient: NotificationRecipient,
    now: Date,
  ): boolean {
    const key = this.dedupeKey(message, recipient);
    const last = this.dedupe.get(key);
    if (last !== undefined && now.getTime() - last < this.policy.dedupeWindowMs) {
      return true;
    }
    this.dedupe.set(key, now.getTime());
    return false;
  }

  private consumeSmsQuota(recipient: NotificationRecipient, now: Date): boolean {
    const key = recipient.userId ?? recipient.driverId ?? recipient.phone ?? 'anon';
    const day = now.toISOString().slice(0, 10);
    const entry = this.smsCounters.get(key);

    if (!entry || entry.day !== day) {
      this.smsCounters.set(key, { day, count: 1 });
      return true;
    }
    if (entry.count >= this.policy.smsDailyCap) return false;

    entry.count += 1;
    return true;
  }

  /** Send one templated message to every recipient of a company. */
  async broadcast(
    companyId: string,
    kind: NotificationKind,
    recipients: NotificationRecipient[],
    context: TemplateContext = {},
  ): Promise<DeliveryResult> {
    return this.send({ companyId, kind, recipients, context });
  }
}

function defaultPriority(kind: NotificationKind): NotificationMessage['priority'] {
  switch (kind) {
    case 'hos_violation':
    case 'invoice_overdue':
      return 'urgent';
    case 'hos_warning':
    case 'load_assigned':
    case 'stop_arrived':
      return 'high';
    case 'pod_missing':
    case 'settlement_ready':
      return 'normal';
    default:
      return 'low';
  }
}

/** Compose a message without sending it. Used by tests and previews. */
export function compose(
  kind: NotificationKind,
  context: TemplateContext,
  now: Iso = isoNow(),
): NotificationMessage {
  const template = renderTemplate(kind, context);
  return {
    id: uuid(),
    kind,
    priority: defaultPriority(kind),
    title: template.title,
    body: template.body,
    createdAt: now,
    data: Object.fromEntries(
      Object.entries(context).filter(
        (entry): entry is [string, string | number | boolean] =>
          typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean',
      ),
    ),
  };
}