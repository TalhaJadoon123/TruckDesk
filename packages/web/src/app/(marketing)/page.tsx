import type { Metadata } from 'next';
import Link from 'next/link';

import { PLANS, PLANS as PLAN_TABLE, FEATURES } from '@truckdesk/shared';

import { IftaCalculator } from '@/components/IftaCalculator';
import { Card, Tag } from '@/components/ui';

/**
 * Marketing page.
 *
 * One job: a small carrier owner reads the headline, believes it is written for
 * them, and either starts free or calculates their IFTA exposure. Everything below
 * the fold exists to remove a specific objection, not to fill space.
 */

export const metadata: Metadata = {
  title: 'TruckDesk - Dispatch for four trucks. Not four hundred.',
  description:
    'Dispatch, tracking, IFTA, settlements and invoicing for trucking companies running 4 to 20 trucks. Free for 2 trucks. No per-seat pricing.',
  openGraph: {
    title: 'TruckDesk - Dispatch built for small carriers',
    description: 'Free tier. No contracts. Works on a phone in a yard with no signal.',
    type: 'website',
  },
};

const PLAN_ORDER = ['free', 'starter', 'business'] as const;

export default function MarketingPage() {
  return (
    <div className="min-h-screen">
      {/* ---------------------------------------------------------- nav */}
      <header className="sticky top-0 z-30 border-b border-[var(--color-edge)] bg-[var(--color-board)]/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded bg-[var(--color-accent)] text-sm font-bold text-black">
              TD
            </span>
            <span className="font-semibold tracking-tight">TruckDesk</span>
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-[var(--color-ink-dim)] sm:flex">
            <a href="#ifta" className="hover:text-[var(--color-ink)]">IFTA calculator</a>
            <a href="#pricing" className="hover:text-[var(--color-ink)]">Pricing</a>
            <a href="#how" className="hover:text-[var(--color-ink)]">How it works</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-md px-3 py-1.5 text-sm text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-black hover:brightness-110"
            >
              Start free
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* --------------------------------------------------------- hero */}
        <section className="mx-auto max-w-6xl px-5 pb-16 pt-16 sm:pt-24">
          <div className="max-w-3xl">
            <Tag tone="good">Free for 2 trucks. No card.</Tag>
            <h1 className="mt-5 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
              Dispatch for four trucks.
              <br />
              <span className="text-[var(--color-ink-dim)]">Not four hundred.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-[var(--color-ink-dim)]">
              TruckDesk is a dispatch board, load tracker, IFTA calculator, driver settlement and
              invoicing system for the carriers the big TMS companies keep ignoring. Eight trucks or
              eighty, the screen looks the same and it stays fast.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/register"
                className="rounded-md bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold text-black hover:brightness-110"
              >
                Start free, 2 trucks
              </Link>
              <a
                href="#ifta"
                className="rounded-md border border-[var(--color-edge)] px-5 py-2.5 text-sm font-medium hover:bg-[var(--color-panel)]"
              >
                Calculate your IFTA
              </a>
            </div>

            <p className="mt-4 text-xs text-[var(--color-ink-faint)]">
              $49/month for 10 trucks. $149 for 25. Per company, not per seat, because a dispatcher
              and an owner both need to see the board.
            </p>
          </div>

          {/* Board preview: a real board shape, not a mockup screenshot. */}
          <div className="mt-14 grid gap-3 sm:grid-cols-4">
            {[
              { label: 'Booked', tone: 'var(--color-booked)', rows: 6, unit: 'Columbus OH -> Pittsburgh PA', rate: '$1,850' },
              { label: 'Dispatched', tone: 'var(--color-transit)', rows: 4, unit: 'Dayton OH -> Detroit MI', rate: '$1,580' },
              { label: 'In transit', tone: 'var(--color-transit)', rows: 3, unit: 'Cleveland OH -> Pittsburgh PA', rate: '$860' },
              { label: 'Delivered', tone: 'var(--color-delivered)', rows: 6, unit: 'Akron OH -> Columbus OH', rate: '$520' },
            ].map((column) => (
              <div
                key={column.label}
                className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-3"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide">{column.label}</span>
                  <span
                    className="money rounded px-1.5 py-0.5 text-[11px] font-medium"
                    style={{
                      background: `color-mix(in oklch, ${column.tone} 20%, transparent)`,
                      color: column.tone,
                    }}
                  >
                    {column.rows}
                  </span>
                </div>
                <div className="space-y-2">
                  {Array.from({ length: Math.min(3, column.rows) }).map((_, index) => (
                    <div
                      key={index}
                      className="rounded border border-[var(--color-edge)] bg-[var(--color-board)] p-2 text-[11px]"
                    >
                      <div className="truncate font-medium">{column.unit}</div>
                      <div className="money mt-1 flex justify-between text-[var(--color-ink-dim)]">
                        <span>{index === 0 ? column.rate : `$${(900 - index * 190).toLocaleString()}`}</span>
                        <span>{[185, 118, 74][index]} mi</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* --------------------------------------------------------- how */}
        <section id="how" className="border-y border-[var(--color-edge)] bg-[var(--color-panel)]/40">
          <div className="mx-auto max-w-6xl px-5 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">
              Built around the four things a small carrier actually does
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                {
                  title: 'Book it from the email',
                  body: 'Forward a broker tender. TruckDesk reads origin, destination, rate, weight and dates out of the message and drops a row on your board, flagging anything it is not sure about.',
                },
                {
                  title: 'Drag it onto a truck',
                  body: 'The board knows deadhead miles, equipment, weight, rate per mile and how many hours the driver has left. Drop it somewhere and the app tells you why that was a bad idea first.',
                },
                {
                  title: 'The driver runs it from the phone',
                  body: 'Stops, navigation, arrival, BOL and POD photos with a signature, HOS log, fuel entry. Works in a yard with no signal and syncs when it finds one.',
                },
                {
                  title: 'Get paid, and know it early',
                  body: 'Weekly settlements a driver will actually read. Invoices per broker with an aging report. Quick-pay quotes before the invoice goes out.',
                },
              ].map((item) => (
                <Card key={item.title} className="p-5">
                  <h3 className="font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-dim)]">{item.body}</p>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------- ifta */}
        <section id="ifta" className="mx-auto max-w-6xl px-5 py-16">
          <div className="mb-8 max-w-2xl">
            <Tag tone="good">Free forever, no account</Tag>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
              Work out your IFTA before you buy anything
            </h2>
            <p className="mt-3 text-[var(--color-ink-dim)]">
              Enter the miles you ran in each state. This runs the same apportionment engine as the
              paid app: total taxable miles per jurisdiction, your share of each, less the fuel tax
              you already paid at the pump.
            </p>
          </div>
          <IftaCalculator />
        </section>

        {/* ------------------------------------------------------ pricing */}
        <section id="pricing" className="border-t border-[var(--color-edge)] bg-[var(--color-panel)]/40">
          <div className="mx-auto max-w-6xl px-5 py-16">
            <div className="mb-10 max-w-2xl">
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                Priced per company. Never per seat.
              </h2>
              <p className="mt-3 text-[var(--color-ink-dim)]">
                Your dispatcher and your drivers all need to see the same board. Charging per user
                makes that expensive, so we do not.
              </p>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              {PLAN_ORDER.map((id) => {
                const plan = PLAN_TABLE[id];
                const monthly = plan.priceCents / 100;
                return (
                  <Card
                    key={plan.id}
                    className={`relative p-6 ${plan.highlight ? 'border-[var(--color-accent)]' : ''}`}
                  >
                    {plan.highlight ? (
                      <span className="absolute -top-2.5 left-6 rounded-full bg-[var(--color-accent)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-black">
                        Most fleets
                      </span>
                    ) : null}
                    <div className="flex items-baseline justify-between">
                      <h3 className="text-lg font-semibold">{plan.name}</h3>
                      <div>
                        <span className="money text-2xl font-semibold">
                          {monthly === 0 ? 'Free' : `$${monthly}`}
                        </span>
                        {monthly > 0 ? (
                          <span className="text-sm text-[var(--color-ink-dim)]">/mo</span>
                        ) : null}
                      </div>
                    </div>
                    <p className="mt-1 text-sm text-[var(--color-ink-dim)]">{plan.tagline}</p>

                    <div className="mt-5 flex gap-2">
                      <Tag tone="good">{plan.maxTrucks} trucks</Tag>
                      <Tag tone="good">{plan.maxDrivers} drivers</Tag>
                    </div>

                    <ul className="mt-5 space-y-2 text-sm">
                      {plan.features.map((feature) => (
                        <li key={feature} className="flex gap-2">
                          <span className="mt-0.5 text-[var(--color-accent)]">&check;</span>
                          <span className="text-[var(--color-ink-dim)]">{feature}</span>
                        </li>
                      ))}
                    </ul>

                    <Link
                      href={id === 'free' ? '/register' : '/register?plan=' + id}
                      className={`mt-6 block rounded-md px-4 py-2 text-center text-sm font-semibold ${
                        plan.highlight
                          ? 'bg-[var(--color-accent)] text-black hover:brightness-110'
                          : 'border border-[var(--color-edge)] hover:bg-[var(--color-panel-raised)]'
                      }`}
                    >
                      {plan.cta}
                    </Link>
                  </Card>
                );
              })}
            </div>

            <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Object.values(FEATURES).map((feature) => {
                const required = PLAN_TABLE[feature.required];
                return (
                  <div
                    key={feature.key}
                    className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-board)] p-4"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{feature.label}</span>
                      <Tag>{required.name}</Tag>
                    </div>
                    <p className="mt-1.5 text-xs text-[var(--color-ink-dim)]">{feature.description}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------- faq */}
        <section className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">Questions a real owner asks</h2>
          <div className="mt-6 grid gap-3 lg:grid-cols-2">
            {[
              [
                'Do I need an ELD subscription?',
                'No. Duty status comes from the driver app and GPS from the phone. If you already pay for Samsara or Motive, connect it and the HOS log shows up on the board.',
              ],
              [
                'What happens when the driver has no signal?',
                'Everything keeps working. Stops, photos, signatures, fuel entries and status changes queue on the device and sync when the phone finds a signal.',
              ],
              [
                'Who owns the data?',
                'You do. It lives in your database. There is no per-load fee to export it and no lock-in from the data model.',
              ],
              [
                'Is the IFTA calculator really free?',
                'Yes, and it is the same engine the product uses. Rates are public IFTA figures; confirm with your accountant before filing.',
              ],
              [
                'Can my driver see the rate?',
                'No. The driver app shows their own load, stops and their pay. Rates and broker margins are dispatcher-only.',
              ],
              [
                'What does it cost to run?',
                'For a 10-truck carrier: $49/month, plus a free-tier database and a free-tier LLM for email parsing. Hosting on Cloudflare free tiers is a few dollars a month.',
              ],
            ].map(([question, answer]) => (
              <Card key={question} className="p-5">
                <h3 className="text-sm font-semibold">{question}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-dim)]">{answer}</p>
              </Card>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------------- cta */}
        <section className="border-t border-[var(--color-edge)] bg-[var(--color-panel)]/40">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 px-5 py-14">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">
                Start with two trucks. Decide later.
              </h2>
              <p className="mt-2 text-[var(--color-ink-dim)]">
                The free tier is not a trial. It runs for as long as you want two trucks on it.
              </p>
            </div>
            <Link
              href="/register"
              className="rounded-md bg-[var(--color-accent)] px-6 py-3 text-sm font-semibold text-black hover:brightness-110"
            >
              Create your account
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--color-edge)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-8 text-xs text-[var(--color-ink-faint)]">
          <span>TruckDesk - dispatch for small carriers</span>
          <span>
            Runs on free tiers: Cloudflare, Neon or Supabase, Groq, Expo push. No vendor lock-in.
          </span>
        </div>
      </footer>
    </div>
  );
}

export { PLANS };