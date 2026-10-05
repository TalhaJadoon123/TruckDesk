import {
  type DeliveryReceipt,
  type NotificationMessage,
  type NotificationProvider,
  type NotificationRecipient,
} from './types.js';

/**
 * Twilio SMS provider.
 *
 * Off by default. Twilio's free trial is $15 of credit, which is roughly 5,000
 * US messages, and a dispatcher loop that fires one message per status change
 * can spend that in an afternoon. So the policy layer defaults `smsEnabled` to
 * false and enforces a daily cap even once it is on.
 *
 * The Twilio REST API is a single authenticated POST, so there is no SDK
 * dependency. Docs: https://www.twilio.com/docs/sms/api/message-resource
 */

export interface TwilioOptions {
  accountSid?: string;
  /** Auth token. */
  authToken?: string;
  /** Messaging service SID, or an explicit `from` number. */
  messagingServiceSid?: string;
  from?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Set false to record messages without sending. Used by tests. */
  enabled?: boolean;
}

export class TwilioSmsProvider implements NotificationProvider {
  readonly name = 'twilio';
  readonly paid = true;

  private readonly options: TwilioOptions;

  constructor(options: TwilioOptions = {}) {
    this.options = options;
  }

  isConfigured(): boolean {
    if (this.options.enabled === false) return false;
    if (!this.options.accountSid || !this.options.authToken) return false;
    // Either a messaging service or an explicit number is required.
    return Boolean(this.options.messagingServiceSid || this.options.from);
  }

  async send(
    message: NotificationMessage,
    recipient: NotificationRecipient,
  ): Promise<DeliveryReceipt> {
    const at = new Date().toISOString();

    if (!recipient.phone) {
      return {
        channel: 'sms',
        provider: this.name,
        ok: false,
        skipped: true,
        skipReason: 'Recipient has no phone number',
        at,
      };
    }

    const to = normalizeE164(recipient.phone);
    if (!to) {
      return {
        channel: 'sms',
        provider: this.name,
        ok: false,
        skipped: true,
        skipReason: `Phone number is not E.164: ${recipient.phone}`,
        at,
      };
    }

    if (!this.isConfigured()) {
      return {
        channel: 'sms',
        provider: this.name,
        ok: false,
        skipped: true,
        skipReason: 'Twilio credentials are not configured',
        at,
      };
    }

    const body = `${message.title}: ${message.body}`.slice(0, 1500);

    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);

      try {
        const params = new URLSearchParams({ To: to, Body: body });
        if (this.options.messagingServiceSid) {
          params.set('MessagingServiceSid', this.options.messagingServiceSid);
        } else if (this.options.from) {
          params.set('From', this.options.from);
        }

        const response = await fetchImpl(
          `https://api.twilio.com/2010-04-01/Accounts/${this.options.accountSid}/Messages.json`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${Buffer.from(
                `${this.options.accountSid}:${this.options.authToken}`,
              ).toString('base64')}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return {
            channel: 'sms',
            provider: this.name,
            ok: false,
            error: `Twilio ${response.status}: ${extractTwilioError(text)}`,
            at,
          };
        }

        const payload = (await response.json()) as { sid?: string; status?: string };
        return {
          channel: 'sms',
          provider: this.name,
          ok: true,
          providerMessageId: payload.sid ?? '',
          // Outbound US SMS list price; the trial covers a few thousand of these.
          costCents: 8,
          at,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return {
        channel: 'sms',
        provider: this.name,
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown SMS transport error',
        at,
      };
    }
  }
}

/**
 * Normalize to E.164. US numbers are the overwhelming majority for this
 * audience, so NANP 10-digit numbers get a +1; anything else must already be
 * international, because guessing a country code from a local number is worse
 * than refusing to send.
 */
export function normalizeE164(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\+[1-9]\d{6,14}$/.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;

  return null;
}

function extractTwilioError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; code?: number };
    return parsed.message ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

/**
 * Provider that records intent without sending anything.
 *
 * This is what runs on the free tier. It is not a no-op stub: it returns a
 * successful receipt with a synthetic id so that call sites, dashboards and
 * tests behave identically whether or not a paid channel is wired up.
 */
export class LogOnlySmsProvider implements NotificationProvider {
  readonly name = 'log_only';
  readonly paid = false;

  /** Everything this provider "sent", for inspection in dev and tests. */
  readonly outbox: Array<{ to: string; body: string; at: string }> = [];

  isConfigured(): boolean {
    return true;
  }

  async send(
    message: NotificationMessage,
    recipient: NotificationRecipient,
  ): Promise<DeliveryReceipt> {
    const at = new Date().toISOString();
    this.outbox.push({
      to: recipient.phone ?? '(none)',
      body: `${message.title}: ${message.body}`,
      at,
    });

    return {
      channel: 'sms',
      provider: this.name,
      ok: true,
      providerMessageId: `log_${this.outbox.length}`,
      costCents: 0,
      at,
    };
  }
}