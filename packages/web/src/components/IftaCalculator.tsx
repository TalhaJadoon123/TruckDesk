'use client';

import { useState } from 'react';

import { endpoints, type IftaResponse } from '@/lib/api';
import { Banner, Button, Card, Field, Input, Money, Tag } from '@/components/ui';

/**
 * The free IFTA calculator.
 *
 * This is the whole acquisition strategy for a product with a $0 tier: a
 * dispatcher can find out their quarterly exposure in about forty seconds without
 * giving anyone a credit card. It runs the same apportionment engine the paid app
 * uses, so the number here is the number they will get in the product.
 */

interface StateRow {
  state: string;
  miles: string;
  gallons: string;
}

const DEFAULT_ROWS: StateRow[] = [
  { state: 'OH', miles: '4200', gallons: '' },
  { state: 'PA', miles: '2800', gallons: '' },
  { state: 'IN', miles: '900', gallons: '' },
];

const QUICK_STATES = [
  'OH', 'PA', 'IN', 'IL', 'MI', 'NY', 'NJ', 'KY', 'WV', 'NC',
  'TN', 'GA', 'AL', 'MS', 'LA', 'AR', 'MO', 'WI', 'MN', 'IA',
  'NE', 'KS', 'OK', 'TX', 'NM', 'AZ', 'UT', 'CO', 'WY', 'MT',
  'ID', 'WA', 'OR', 'CA', 'NV', 'ND', 'SD',
];

export function IftaCalculator() {
  const [rows, setRows] = useState<StateRow[]>(DEFAULT_ROWS);
  const [mpg, setMpg] = useState('6.2');
  const [result, setResult] = useState<IftaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setRow = (index: number, patch: Partial<StateRow>) => {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );
  };

  const addRow = () => {
    const used = new Set(rows.map((row) => row.state.toUpperCase()));
    const next = QUICK_STATES.find((state) => !used.has(state)) ?? 'OH';
    setRows((current) => [...current, { state: next, miles: '', gallons: '' }]);
  };

  const removeRow = (index: number) => {
    setRows((current) => current.filter((_, rowIndex) => rowIndex !== index));
  };

  async function calculate() {
    setBusy(true);
    setError(null);

    const milesByState: Record<string, number> = {};
    const gallonsByState: Record<string, number> = {};

    for (const row of rows) {
      const code = row.state.trim().toUpperCase();
      const miles = Number.parseFloat(row.miles);
      if (!code || !Number.isFinite(miles) || miles <= 0) continue;
      milesByState[code] = (milesByState[code] ?? 0) + miles;

      const gallons = Number.parseFloat(row.gallons);
      if (Number.isFinite(gallons) && gallons > 0) gallonsByState[code] = gallons;
    }

    try {
      const response = await endpoints.publicIfta({
        milesByState,
        ...(gallonsByState ? { gallonsByState } : {}),
        ...(Number.parseFloat(mpg) > 0 ? { mpg: Number.parseFloat(mpg) } : {}),
      });
      setResult(response);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : 'Calculation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Card title="Your miles" className="p-4">
        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={index} className="grid grid-cols-[5rem_1fr_1fr_2rem] items-end gap-2">
              <Field label={index === 0 ? 'State' : ''}>
                <Input
                  value={row.state}
                  maxLength={3}
                  onChange={(event) => setRow(index, { state: event.target.value.toUpperCase() })}
                  placeholder="OH"
                  aria-label="State code"
                />
              </Field>
              <Field label={index === 0 ? 'Miles' : ''}>
                <Input
                  value={row.miles}
                  inputMode="numeric"
                  onChange={(event) => setRow(index, { miles: event.target.value })}
                  placeholder="4200"
                  aria-label="Miles"
                />
              </Field>
              <Field label={index === 0 ? 'Gallons (optional)' : ''}>
                <Input
                  value={row.gallons}
                  inputMode="decimal"
                  onChange={(event) => setRow(index, { gallons: event.target.value })}
                  placeholder="auto"
                  aria-label="Gallons"
                />
              </Field>
              <button
                type="button"
                onClick={() => removeRow(index)}
                disabled={rows.length <= 1}
                className="mb-1 h-8 w-8 rounded text-[var(--color-ink-faint)] hover:text-[var(--color-alert)] disabled:opacity-30"
                aria-label={`Remove ${row.state}`}
              >
                &times;
              </button>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div className="w-32">
            <Field label="Truck MPG" hint="Leave at 6.2 if unsure">
              <Input value={mpg} inputMode="decimal" onChange={(event) => setMpg(event.target.value)} />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={addRow}>
              Add state
            </Button>
            <Button onClick={calculate} disabled={busy}>
              {busy ? 'Calculating...' : 'Calculate my IFTA'}
            </Button>
          </div>
        </div>

        {error ? (
          <div className="mt-3">
            <Banner tone="bad" title="Could not calculate">
              {error}
            </Banner>
          </div>
        ) : null}

        <p className="mt-4 text-xs leading-relaxed text-[var(--color-ink-faint)]">
          Gallons are derived from your miles and MPG using the IRP standard when you leave them
          blank. Enter gallons for the states you want credits in exactly. Free, no account.
        </p>
      </Card>

      <Card title={result ? `${result.period.label} estimate` : 'Result'}>
        {!result ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <div className="text-sm text-[var(--color-ink-dim)]">Your quarterly estimate appears here</div>
            <div className="max-w-xs text-xs text-[var(--color-ink-faint)]">
              IFTA apportions fuel tax across every state you ran in. Most carriers find a credit
              they did not know about.
            </div>
          </div>
        ) : (
          <div className="animate-in">
            <div className="flex items-baseline justify-between border-b border-[var(--color-edge)] px-4 py-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                  Net tax due
                </div>
                <div
                  className={`money text-3xl font-semibold ${
                    result.netTaxDueCents < 0
                      ? 'text-[var(--color-available)]'
                      : 'text-[var(--color-empty)]'
                  }`}
                >
                  {result.netTaxDueCents < 0 ? '-' : ''}
                  {Math.abs(result.netTaxDueCents / 100).toLocaleString('en-US', {
                    style: 'currency',
                    currency: 'USD',
                  })}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-[var(--color-ink-faint)]">Taxable miles</div>
                <div className="miles text-lg font-medium">{result.totalMilesFormatted}</div>
              </div>
            </div>

            <div className="max-h-72 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[var(--color-panel)] text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">State</th>
                    <th className="px-2 py-2 text-right font-medium">Miles</th>
                    <th className="px-2 py-2 text-right font-medium">Share</th>
                    <th className="px-2 py-2 text-right font-medium">Tax</th>
                    <th className="px-4 py-2 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {result.lines.map((line) => (
                    <tr key={line.state} className="border-t border-[var(--color-edge)]">
                      <td className="px-4 py-2">
                        <span className="font-medium">{line.state}</span>{' '}
                        <span className="text-xs text-[var(--color-ink-faint)]">{line.name}</span>
                      </td>
                      <td className="miles px-2 py-2 text-right">{line.miles.toLocaleString()}</td>
                      <td className="money px-2 py-2 text-right text-[var(--color-ink-dim)]">
                        {(line.taxableFraction * 100).toFixed(1)}%
                      </td>
                      <td className="money px-2 py-2 text-right text-[var(--color-ink-dim)]">
                        <Money cents={line.taxCents} />
                      </td>
                      <td className="money px-4 py-2 text-right font-medium">
                        <Money cents={line.netCents} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="border-t border-[var(--color-edge)] px-4 py-3">
              <Banner tone={result.netTaxDueCents < 0 ? 'good' : 'info'} title={result.note}>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Tag>Apportioned tax {formatMoney(result.apportionedTaxCents)}</Tag>
                  <Tag>Fuel credits {formatMoney(result.creditsCents)}</Tag>
                  <Tag>{result.lines.length} jurisdictions</Tag>
                </div>
              </Banner>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function formatMoney(cents: number): string {
  return `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}