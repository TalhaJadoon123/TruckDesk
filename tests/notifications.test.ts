import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POLICY,
  ExpoPushProvider,
  LogOnlySmsProvider,
  Notifier,
  TEMPLATES,
  TwilioSmsProvider,
  channelsFor,
  compose,
  isQuietHours,
  localHourIn,
  normalizeE164,
  renderTemplate,
  smsAllowed,
  type NotificationRecipient,
} from '@truckdesk/sms';

/**
 * Notifications.
 *
 * Push is the free default and SMS is opt-in behind a cap. The tests here are
 * mostly about the policy layer, because that is where the money and the
 * irker-sent-at-3am problems actually live.
 */

const RECIPIENT: NotificationRecipient = {
  userId: 'us_1',
  pushToken: 'ExponentPushToken[abc123]',
  phone: '+16145550142',
  email: 'driver@example.com',
  timezone: 'America/New_York',
  quietHoursStart: 22,
  quietHoursEnd: 6,
};

function fetchStub(payload: unknown, ok = true, status = 200) {
  const calls: Array<{ url: string; body: unknown }> = [];

  const impl = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body });
    return {
      ok,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };

  return { impl: impl as unknown as typeof fetch, calls };
}

describe('phone normalization', () => {
  it('normalizes the US forms', () => {
    expect(normalizeE164('614-555-0142')).toBe('+16145550142');
    expect(normalizeE164('(614) 555.0142')).toBe('+16145550142');
    expect(normalizeE164('1-614-555-0142')).toBe('+16145550142');
    expect(normalizeE164('+16145550142')).toBe('+16145550142');
  });

  it('leaves an international number alone', () => {
    expect(normalizeE164('+447700900123')).toBe('+447700900123');
  });

  it('refuses rather than guessing', () => {
    expect(normalizeE164('')).toBeNull();
    expect(normalizeE164('555-0142')).toBeNull();
    expect(normalizeE164('12345')).toBeNull();
  });
});

describe('channel policy', () => {
  it('keeps SMS off by default', () => {
    expect(DEFAULT_POLICY.smsEnabled).toBe(false);
    expect(smsAllowed(DEFAULT_POLICY, RECIPIENT)).toBe(false);
  });

  it('enables SMS only when explicitly turned on', () => {
    const policy = { ...DEFAULT_POLICY, smsEnabled: true };
    expect(smsAllowed(policy, RECIPIENT)).toBe(true);
  });

  it('honours a per-recipient opt-out', () => {
    const policy = { ...DEFAULT_POLICY, smsEnabled: true };
    expect(smsAllowed(policy, { ...RECIPIENT, channels: { sms: false } })).toBe(false);
  });

  it('needs a push token for push and an address for email', () => {
    const channels = channelsFor(DEFAULT_POLICY, { userId: 'u' }, 'load_assigned');
    expect(channels).toContain('in_app');
    expect(channels).not.toContain('push');
    expect(channels).not.toContain('email');
  });

  it('skips a channel a recipient disabled', () => {
    const channels = channelsFor(DEFAULT_POLICY, { ...RECIPIENT, channels: { push: false } }, 'load_assigned');
    expect(channels).not.toContain('push');
  });
});

describe('quiet hours', () => {
  it('is quiet at 2am New York time', () => {
    // 06:00 UTC is 2am EDT.
    const verdict = isQuietHours(RECIPIENT, new Date('2026-03-16T06:00:00.000Z'), true);
    expect(verdict.quiet).toBe(true);
    expect(verdict.localHour).toBe(2);
    expect(verdict.untilIso).not.toBeNull();
  });

  it('is not quiet at noon', () => {
    const verdict = isQuietHours(RECIPIENT, new Date('2026-03-16T16:00:00.000Z'), true);
    expect(verdict.quiet).toBe(false);
  });

  it('respects the recipient timezone, not the server', () => {
    // 03:00 UTC is 11pm EDT: quiet. In UTC it is 3am, also quiet, so use a case
    // where they differ: 22:00 UTC is 6pm EDT (awake) and 10pm UTC (quiet).
    expect(isQuietHours(RECIPIENT, new Date('2026-03-16T22:00:00.000Z'), true).quiet).toBe(false);
    expect(isQuietHours(RECIPIENT, new Date('2026-03-17T02:00:00.000Z'), true).quiet).toBe(true);
  });

  it('can be switched off', () => {
    expect(isQuietHours(RECIPIENT, new Date('2026-03-16T06:00:00.000Z'), false).quiet).toBe(false);
  });

  it('falls back to UTC for a bad timezone rather than throwing', () => {
    expect(localHourIn('Not/AZone', new Date('2026-03-16T06:00:00.000Z'))).toBe(6);
  });
});

describe('ExpoPushProvider', () => {
  it('wraps a bare token', () => {
    const provider = new ExpoPushProvider({});
    expect(provider.normalizeToken('abc123')).toBe('ExponentPushToken[abc123]');
    expect(provider.normalizeToken('ExponentPushToken[abc]')).toBe('ExponentPushToken[abc]');
  });

  it('posts a payload with the deep link', async () => {
    const stub = fetchStub({ data: { status: 'ok', id: 'expo-1' } });
    const provider = new ExpoPushProvider({ fetchImpl: stub.impl });

    const receipt = await provider.send(
      compose('load_assigned', { lane: 'Columbus OH to Pittsburgh PA', rate: 1850 }),
      RECIPIENT,
    );

    expect(receipt.ok).toBe(true);
    expect(receipt.providerMessageId).toBe('expo-1');
    expect(receipt.costCents).toBe(0);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toContain('exp.host');
  });

  it('skips a recipient with no token', async () => {
    const provider = new ExpoPushProvider({ fetchImpl: fetchStub({}).impl });
    const receipt = await provider.send(compose('load_assigned', {}), { userId: 'u' });

    expect(receipt.ok).toBe(false);
    expect(receipt.skipped).toBe(true);
    expect(receipt.skipReason).toMatch(/push token/i);
  });

  it('reports an Expo rejection', async () => {
    const stub = fetchStub({ data: { status: 'error', message: 'DeviceNotRegistered' } });
    const provider = new ExpoPushProvider({ fetchImpl: stub.impl });
    const receipt = await provider.send(compose('load_assigned', {}), RECIPIENT);

    expect(receipt.ok).toBe(false);
    expect(receipt.error).toMatch(/DeviceNotRegistered/);
  });

  it('reports a transport error instead of throwing', async () => {
    const impl = async () => {
      throw new Error('offline');
    };
    const provider = new ExpoPushProvider({ fetchImpl: impl as unknown as typeof fetch });
    const receipt = await provider.send(compose('load_assigned', {}), RECIPIENT);

    expect(receipt.ok).toBe(false);
    expect(receipt.error).toMatch(/offline/);
  });
});

describe('TwilioSmsProvider', () => {
  it('is unconfigured without credentials', async () => {
    const provider = new TwilioSmsProvider({});
    expect(provider.isConfigured()).toBe(false);
    expect(provider.paid).toBe(true);

    const receipt = await provider.send(compose('load_assigned', {}), RECIPIENT);
    expect(receipt.skipped).toBe(true);
  });

  it('sends when configured', async () => {
    const stub = fetchStub({ sid: 'SM123', status: 'queued' });
    const provider = new TwilioSmsProvider({
      accountSid: 'AC123',
      authToken: 'token',
      messagingServiceSid: 'MG123',
      fetchImpl: stub.impl,
    });

    const receipt = await provider.send(compose('load_assigned', { lane: 'X to Y' }), RECIPIENT);

    expect(receipt.ok).toBe(true);
    expect(receipt.providerMessageId).toBe('SM123');
    expect(receipt.costCents).toBeGreaterThan(0);
    expect(stub.calls[0]?.url).toContain('api.twilio.com');
  });

  it('refuses a number that is not E.164', async () => {
    const provider = new TwilioSmsProvider({
      accountSid: 'AC123',
      authToken: 'token',
      from: '+15551234567',
      fetchImpl: fetchStub({}).impl,
    });

    const receipt = await provider.send(compose('load_assigned', {}), {
      userId: 'u',
      phone: '555-0142',
    });

    expect(receipt.skipped).toBe(true);
    expect(receipt.skipReason).toMatch(/E\.164/);
  });

  it('surfaces an API error', async () => {
    const stub = fetchStub({ message: 'Authenticate' }, false, 401);
    const provider = new TwilioSmsProvider({
      accountSid: 'AC123',
      authToken: 'bad',
      from: '+15551234567',
      fetchImpl: stub.impl,
    });

    const receipt = await provider.send(compose('load_assigned', {}), RECIPIENT);
    expect(receipt.ok).toBe(false);
    expect(receipt.error).toMatch(/Authenticate/);
  });

  it('logs instead of sending when unconfigured', async () => {
    const provider = new LogOnlySmsProvider();
    const receipt = await provider.send(compose('load_assigned', { lane: 'A to B' }), RECIPIENT);

    expect(receipt.ok).toBe(true);
    expect(receipt.costCents).toBe(0);
    expect(provider.outbox[0]?.body).toContain('A to B');
  });
});

describe('Notifier', () => {
  const NOW = new Date('2026-03-16T16:00:00.000Z');

  it('sends to push for an assigned load', async () => {
    const stub = fetchStub({ data: { status: 'ok', id: 'p1' } });
    const notifier = new Notifier({
      push: { fetchImpl: stub.impl },
      now: () => NOW,
    });

    const result = await notifier.send({
      kind: 'load_assigned',
      recipients: [RECIPIENT],
      context: { lane: 'Columbus OH to Pittsburgh PA', rate: 1850, pickup: 'tomorrow 08:00' },
    });

    expect(result.delivered).toBeGreaterThanOrEqual(1);
    expect(stub.calls).toHaveLength(1);
  });

  it('holds a non-urgent message during quiet hours', async () => {
    const night = new Date('2026-03-16T06:00:00.000Z');
    const stub = fetchStub({ data: { status: 'ok', id: 'p1' } });
    const notifier = new Notifier({ push: { fetchImpl: stub.impl }, now: () => night });

    const result = await notifier.send({
      kind: 'load_assigned',
      recipients: [RECIPIENT],
      context: { lane: 'X to Y' },
    });

    expect(result.delivered).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(stub.calls).toHaveLength(0);
    expect(result.receipts.some((receipt) => receipt.skipReason?.includes('Quiet hours'))).toBe(true);
  });

  it('still delivers an urgent message during quiet hours', async () => {
    const night = new Date('2026-03-16T06:00:00.000Z');
    const stub = fetchStub({ data: { status: 'ok', id: 'p1' } });
    const notifier = new Notifier({ push: { fetchImpl: stub.impl }, now: () => night });

    const result = await notifier.send({
      kind: 'hos_violation',
      recipients: [RECIPIENT],
      context: { driver: 'Marcus', message: 'Drive time exceeded' },
    });

    expect(result.delivered).toBe(1);
  });

  it('deduplicates the same message inside the window', async () => {
    const stub = fetchStub({ data: { status: 'ok', id: 'p1' } });
    const notifier = new Notifier({ push: { fetchImpl: stub.impl }, now: () => NOW });

    const first = await notifier.send({
      kind: 'load_assigned',
      entityId: 'ld_1',
      recipients: [RECIPIENT],
      context: { lane: 'X to Y' },
    });
    const second = await notifier.send({
      kind: 'load_assigned',
      entityId: 'ld_1',
      recipients: [RECIPIENT],
      context: { lane: 'X to Y' },
    });

    expect(first.delivered).toBe(1);
    expect(second.delivered).toBe(0);
    expect(second.receipts.some((receipt) => receipt.skipReason?.includes('Duplicate'))).toBe(true);
  });

  it('enforces the SMS daily cap', async () => {
    const notifier = new Notifier({
      // No Twilio credentials, so this uses the log-only provider: the point
      // under test is the cap, not the transport.
      policy: { smsEnabled: true, smsDailyCap: 2, respectQuietHours: false, dedupeWindowMs: 0 },
      now: () => NOW,
    });

    let delivered = 0;
    for (let i = 0; i < 4; i += 1) {
      const result = await notifier.send({
        kind: 'invoice_overdue',
        entityId: `in_${i}`,
        recipients: [RECIPIENT],
        context: { broker: 'Test', daysOverdue: 30, amount: 1000 },
      });
      delivered += result.delivered;
    }

    expect(delivered).toBe(2);
  });

  it('writes in-app notifications through the sink', async () => {
    const seen: string[] = [];
    const notifier = new Notifier({
      now: () => NOW,
      inAppSink: (message) => {
        seen.push(message.kind);
      },
    });

    const result = await notifier.send({
      kind: 'settlement_ready',
      recipients: [RECIPIENT],
      context: { week: '2026-03-16', net: 42000 },
    });

    expect(seen).toContain('settlement_ready');
    expect(result.receipts.some((receipt) => receipt.channel === 'in_app' && receipt.ok)).toBe(true);
  });

  it('reports provider status', () => {
    const free = new Notifier({}).providerStatus();
    expect(free.find((entry) => entry.name === 'push')?.configured).toBe(true);
    // With no Twilio credentials the SMS channel falls back to log-only, which
    // records the message without sending or spending credit.
    expect(free.find((entry) => entry.name === 'sms')?.paid).toBe(false);

    const paid = new Notifier({
      twilio: { accountSid: 'AC123', authToken: 'x', from: '+15551234567' },
    }).providerStatus();
    expect(paid.find((entry) => entry.name === 'sms')?.paid).toBe(true);
  });

  it('reports a recipient with no reachable channel', async () => {
    const notifier = new Notifier({
      now: () => NOW,
      // Disable the in-app channel so nothing at all is deliverable.
      policy: { enabledChannels: ['push'] },
    });
    const result = await notifier.send({
      kind: 'load_assigned',
      recipients: [{ userId: 'u' }],
      context: {},
    });

    expect(result.receipts[0]?.skipped).toBe(true);
    expect(result.receipts[0]?.skipReason).toMatch(/no channel/i);
  });
});

describe('templates', () => {
  it('has copy for every notification kind', () => {
    for (const kind of Object.keys(TEMPLATES)) {
      const rendered = renderTemplate(kind as never, { lane: 'X to Y', driver: 'D' });
      expect(rendered.title.length).toBeGreaterThan(0);
      expect(rendered.body.length).toBeGreaterThan(0);
    }
  });

  it('renders a readable summary', () => {
    const rendered = renderTemplate('load_assigned', {
      lane: 'Columbus, OH to Pittsburgh, PA',
      rate: 1850,
      pickup: 'tomorrow 08:00',
    });

    expect(rendered.title).toBe('New load');
    expect(rendered.body).toContain('Columbus, OH to Pittsburgh, PA');
    expect(rendered.body).toContain('1850');
  });

  it('assigns a sensible default priority', () => {
    expect(compose('hos_violation', {}).priority).toBe('urgent');
    expect(compose('load_assigned', {}).priority).toBe('high');
    expect(compose('settlement_paid', {}).priority).toBe('low');
  });

  it('carries context into the message data for deep links', () => {
    const message = compose('load_assigned', { lane: 'A to B', rate: 100 });
    expect(message.data['lane']).toBe('A to B');
  });
});