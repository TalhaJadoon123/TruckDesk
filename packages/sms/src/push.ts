import {
  type DeliveryReceipt,
  type NotificationMessage,
  type NotificationProvider,
  type NotificationRecipient,
} from './types.js';

/**
 * Expo push provider (the free path).
 *
 * Expo's push service has no per-message fee, which is why push is the default
 * channel. The API is a single batched POST to a public endpoint, so this is
 * plain `fetch` with no SDK.
 *
 * Docs: https://docs.expo.dev/push-notifications/sending-notifications/
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushOptions {
  accessToken?: string;
  /** Override for tests and for regional endpoints. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Dev builds cannot receive push; this makes the provider a no-op. */
  enabled?: boolean;
}

export class ExpoPushProvider implements NotificationProvider {
  readonly name = 'expo_push';
  readonly paid = false;

  private readonly options: ExpoPushOptions;

  constructor(options: ExpoPushOptions = {}) {
    this.options = options;
  }

  /** Expo push works without a token, but priority and expiry need one. */
  isConfigured(): boolean {
    return this.options.enabled !== false;
  }

  normalizeToken(token: string): string {
    if (token.startsWith('ExponentPushToken[')) return token;
    if (token.startsWith('ExpoPushToken[')) return token;
    return `ExponentPushToken[${token}]`;
  }

  async send(
    message: NotificationMessage,
    recipient: NotificationRecipient,
  ): Promise<DeliveryReceipt> {
    const at = new Date().toISOString();

    if (!recipient.pushToken) {
      return {
        channel: 'push',
        provider: this.name,
        ok: false,
        skipped: true,
        skipReason: 'Recipient has no push token',
        at,
      };
    }

    if (!this.isConfigured()) {
      return {
        channel: 'push',
        provider: this.name,
        ok: false,
        skipped: true,
        skipReason: 'Push is disabled on this deployment',
        at,
      };
    }

    const priority = message.priority === 'urgent' || message.priority === 'high' ? 'high' : 'default';

    const payload = {
      to: this.normalizeToken(recipient.pushToken),
      title: message.title.slice(0, 100),
      body: message.body.slice(0, 400),
      data: {
        ...(message.data ?? {}),
        kind: message.kind,
        url: message.url ?? '',
        entityId: message.entityId ?? '',
        entityType: message.entityType ?? '',
      },
      sound: priority === 'high' ? 'default' : undefined,
      priority,
      channelId: message.priority === 'urgent' ? 'urgent' : 'default',
      // 30 days is Expo's own cap.
      ttl: 60 * 60 * 24 * 30,
    };

    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);

      try {
        const response = await fetchImpl(this.options.endpoint ?? EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.options.accessToken
              ? { Authorization: `Bearer ${this.options.accessToken}` }
              : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return {
            channel: 'push',
            provider: this.name,
            ok: false,
            error: `Expo push ${response.status}: ${text.slice(0, 200)}`,
            at,
          };
        }

        const result = (await response.json()) as {
          data?: { status?: string; id?: string; message?: string };
        };
        const status = result.data?.status ?? 'ok';

        if (status === 'error') {
          return {
            channel: 'push',
            provider: this.name,
            ok: false,
            error: result.data?.message ?? 'Expo rejected the message',
            providerMessageId: result.data?.id,
            at,
          };
        }

        return {
          channel: 'push',
          provider: this.name,
          ok: true,
          providerMessageId: result.data?.id ?? '',
          costCents: 0,
          at,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return {
        channel: 'push',
        provider: this.name,
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown push transport error',
        at,
      };
    }
  }
}

/**
 * Check whether a push token is still valid.
 *
 * Expo returns `DeviceNotRegistered` once an app is uninstalled. Those tokens
 * must be deleted rather than retried, otherwise you pay (or burn rate limit)
 * forever on a dead address.
 */
export function isDeadTokenError(message: string | undefined): boolean {
  if (!message) return false;
  return /DeviceNotRegistered|device not registered/i.test(message);
}

export function isPushTokenValid(token: string | undefined | null): boolean {
  if (!token) return false;
  return /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(token.trim());
}