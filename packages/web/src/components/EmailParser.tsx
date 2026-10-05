'use client';

import { useState } from 'react';

import { endpoints, type ParseEmailResponse } from '@/lib/api';
import { Banner, Button, Card, Field, Input, Money, Tag } from '@/components/ui';

/**
 * Broker email parser.
 *
 * The screen makes the honesty explicit: confidence per field, what the parser
 * could not read, and a Book button that only appears when the four fields that
 * matter are present. A dispatcher should never have to guess whether a number
 * came from the email or from a model.
 */
export function EmailParser({ token }: { token: string }) {
  const [email, setEmail] = useState({
    subject: '',
    from: '',
    body: '',
  });
  const [result, setResult] = useState<ParseEmailResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function parse(book: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await endpoints.parseEmail(token, { ...email, book });
      setResult(response);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : 'Parse failed');
    } finally {
      setBusy(false);
    }
  }

  const canBook =
    result !== null &&
    result.createdLoadId === null &&
    result.parsed.origin &&
    result.parsed.destination &&
    result.parsed.rateDollars &&
    result.parsed.miles;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Paste the broker email" className="p-4">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From">
              <Input
                value={email.from}
                onChange={(event) => setEmail((current) => ({ ...current, from: event.target.value }))}
                placeholder="dispatch@broker.com"
              />
            </Field>
            <Field label="Subject">
              <Input
                value={email.subject}
                onChange={(event) => setEmail((current) => ({ ...current, subject: event.target.value }))}
                placeholder="Tender - Columbus OH to Pittsburgh PA"
              />
            </Field>
          </div>

          <Field label="Body">
            <textarea
              value={email.body}
              onChange={(event) => setEmail((current) => ({ ...current, body: event.target.value }))}
              rows={14}
              placeholder={'Load: Columbus, OH to Pittsburgh, PA\nRate: $1,850.00 flat\nMiles: 185\nPickup: tomorrow 08:00'}
              className="w-full rounded-md border border-[var(--color-edge)] bg-[var(--color-board)] px-3 py-2 font-mono text-xs text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)]"
            />
          </Field>

          <div className="flex items-center justify-between">
            <Button onClick={() => void parse(false)} disabled={busy || !email.body.trim()}>
              {busy ? 'Reading...' : 'Extract load'}
            </Button>
            {result && !result.llmLive ? (
              <Tag tone="warn">deterministic parser (no GROQ_API_KEY)</Tag>
            ) : result?.llmLive ? (
              <Tag tone="good">Groq</Tag>
            ) : null}
          </div>

          {error ? (
            <Banner tone="bad" title="Could not read that email">
              {error}
            </Banner>
          ) : null}
        </div>
      </Card>

      <Card title="Extracted">
        {!result ? (
          <div className="flex h-full items-center justify-center px-6 py-16 text-center text-sm text-[var(--color-ink-dim)]">
            The parsed load and its confidence appear here
          </div>
        ) : (
          <div className="animate-in space-y-3 p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{result.summary}</div>
              <div className="text-right">
                <div className="money text-xl font-semibold text-[var(--color-accent)]">
                  {Math.round(result.overallConfidence * 100)}%
                </div>
                <div className="text-[10px] text-[var(--color-ink-faint)]">confidence</div>
              </div>
            </div>

            <dl className="grid gap-1.5 text-sm">
              {(
                [
                  ['Broker', result.parsed.broker],
                  ['Origin', result.parsed.origin],
                  ['Destination', result.parsed.destination],
                  ['Commodity', result.parsed.commodity],
                  ['Rate', result.parsed.rateCents ? <Money key="r" cents={result.parsed.rateCents} /> : null],
                  ['Miles', result.parsed.miles],
                  ['Weight', result.parsed.weightLbs ? `${result.parsed.weightLbs.toLocaleString()} lbs` : null],
                  ['Pickup', result.parsed.pickupDate?.slice(0, 16).replace('T', ' ')],
                  ['Delivery', result.parsed.deliveryDate?.slice(0, 16).replace('T', ' ')],
                ] as Array<[string, React.ReactNode]>
              ).map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3 border-b border-[var(--color-edge)] pb-1">
                  <dt className="text-xs text-[var(--color-ink-faint)]">{label}</dt>
                  <dd
                    className={`text-right ${
                      value ? 'text-[var(--color-ink)]' : 'text-[var(--color-alert)]'
                    }`}
                  >
                    {value ?? 'not stated'}
                  </dd>
                </div>
              ))}
            </dl>

            {result.needsReview.length > 0 ? (
              <Banner tone="warn" title="Confirm before booking">
                <ul className="mt-1 list-inside list-disc">
                  {result.needsReview.map((item) => (
                    <li key={item.field}>{item.reason}</li>
                  ))}
                </ul>
              </Banner>
            ) : null}

            {result.warnings.map((warning) => (
              <Banner key={warning} tone="info" title={warning} />
            ))}

            {result.createdLoadId ? (
              <Banner tone="good" title="Booked">
                Load {result.createdLoadId} is on the board.
              </Banner>
            ) : canBook ? (
              <Button onClick={() => void parse(true)} disabled={busy}>
                Book this load
              </Button>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}