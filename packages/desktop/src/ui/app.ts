/**
 * TruckDesk desktop renderer.
 *
 * Plain TypeScript compiled to ES2022 and run directly in the renderer: no
 * framework, no bundler, no node_modules in the shipped window. The renderer
 * never touches a secret. It calls the local API through the main process for
 * privileged work and renders broker-supplied text as text, never as markup.
 */

import { formatUsd, perMileCents, type Load, type Truck } from '@truckdesk/shared';
import type { TruckDeskBridge } from './types.js';

/* ------------------------------------------------------------------ types */

interface Actor {
  userId: string;
  companyId: string;
  role: 'driver' | 'dispatcher' | 'owner' | 'admin';
  name: string;
  email: string;
  token: string;
}

interface DashboardSummary {
  trucksAvailable: number;
  trucksTotal: number;
  loadsInTransit: number;
  loadsDeliveredThisWeek: number;
  revenueThisWeekCents: number;
  revenueLastWeekCents: number;
  deadheadRatio: number;
  averageRevenuePerMileCents: number;
  onTimeRate: number;
  unpaidReceivablesCents: number;
}

interface DashboardResponse {
  summary: DashboardSummary;
  utilisation: { utilisation: number; loaded: number; empty: number; available: number; maintenance: number };
  health: { unassigned: number; staleUnassigned: number; atRiskOnTime: number; missingPod: number };
  trend: Array<{ label: string; revenueCents: number }>;
  attention: Array<{ load: { id: string; origin: string; destination: string; broker: string }; reasons: string[] }>;
  board: { columns: Array<{ status: Load['status']; loads: Load[] }> };
  mode: string;
}

interface AgingResponse {
  totalOutstandingCents: number;
  totalOverdueCents: number;
  overdueCount: number;
  averageDaysPastDue: number;
  staleShare: number;
  buckets: Record<string, { count: number; balanceCents: number }>;
  topDelinquents: Array<{
    invoiceId: string;
    brokerName: string;
    number: string;
    daysPastDue: number;
    balanceCents: number;
    loadCount: number;
  }>;
}

interface HosResponse {
  hos: Array<{
    driverId: string;
    unit: string;
    driverName?: string;
    driveMinutesRemaining: number;
    dutyMinutesRemaining: number;
    cycleMinutesRemaining: number;
    cycle: number;
    violations: string[];
    warnings: Array<{ message: string }>;
  }>;
  providers: Array<{ name: string; configured: boolean; free: boolean; note: string }>;
}

type Page = 'dashboard' | 'dispatch' | 'loads' | 'money' | 'eld';

/* ------------------------------------------------------------------ state */

const state = {
  apiUrl: 'http://127.0.0.1:4000',
  actor: null as Actor | null,
  page: 'dashboard' as Page,
  dashboard: null as DashboardResponse | null,
  trucks: [] as Truck[],
  search: '',
  banner: null as { tone: 'good' | 'warn' | 'bad'; text: string } | null,
  busy: false,
  version: '',
};

/* ------------------------------------------------------------------- dom */

const app = document.getElementById('app') as HTMLDivElement;

/** Escape before any interpolation. Broker text reaches this file. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NAV: Array<{ page: Page; label: string }> = [
  { page: 'dashboard', label: 'Dashboard' },
  { page: 'dispatch', label: 'Dispatch' },
  { page: 'loads', label: 'Loads' },
  { page: 'money', label: 'Money' },
  { page: 'eld', label: 'ELD & HOS' },
];

/* ------------------------------------------------------------------- api */

async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const response = await fetch(`${state.apiUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const error = (payload as { error?: { message?: string } } | null)?.error;
    throw new Error(error?.message ?? `Request failed (${response.status})`);
  }
  return payload as T;
}

function actor(): Actor {
  if (!state.actor) throw new Error('Not signed in');
  return state.actor;
}

/* ------------------------------------------------------------------ load */

async function refresh(): Promise<void> {
  if (!state.actor) return;
  try {
    const [dashboard, trucks] = await Promise.all([
      api<DashboardResponse>('/dashboard', { token: actor().token }),
      api<{ trucks: Truck[] }>('/trucks', { token: actor().token }),
    ]);
    state.dashboard = dashboard;
    state.trucks = trucks.trucks;
  } catch (error) {
    setBanner('bad', error instanceof Error ? error.message : 'Could not reach the API');
  }
}

/* ----------------------------------------------------------------- paint */

function setBanner(tone: 'good' | 'warn' | 'bad', text: string): void {
  state.banner = { tone, text };
  render();
}

function render(): void {
  const nav = NAV.map(
    (item) =>
      `<button data-page="${item.page}" aria-current="${state.page === item.page}">${esc(item.label)}</button>`,
  ).join('');

  const banner = state.banner
    ? `<div class="banner ${state.banner.tone}"><span>${esc(state.banner.text)}</span><button data-dismiss="1">&times;</button></div>`
    : '';

  const who = state.actor
    ? `<div><div>${esc(state.actor.name)}</div><div>${esc(state.actor.companyId)}</div></div>`
    : '<div>Not signed in</div>';

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">TD</div>
          <div class="brand-text">
            <div class="brand-name">TruckDesk</div>
            <div class="brand-sub">${esc(state.apiUrl.replace(/^https?:\/\//, ''))}</div>
          </div>
        </div>
        <nav class="nav">${nav}</nav>
        <div class="sidebar-foot">
          <div>v${esc(state.version || '1.0.0')}</div>
          <div>${esc(state.dashboard?.mode === 'memory' ? 'in-memory store' : 'postgres')}</div>
        </div>
      </aside>
      <main class="main">
        <div class="page-head">
          <div>
            <h1>${esc(titleFor(state.page))}</h1>
            <p class="subtitle">${esc(subtitleFor(state.page))}</p>
          </div>
          <div>${who}</div>
        </div>
        ${banner}
        ${bodyFor(state.page)}
      </main>
    </div>
  `;

  wire();
}

function titleFor(page: Page): string {
  return { dashboard: 'Dashboard', dispatch: 'Dispatch', loads: 'Loads', money: 'Money', eld: 'ELD & HOS' }[page];
}

function subtitleFor(page: Page): string {
  switch (page) {
    case 'dispatch':
      return 'Drag a load onto a truck. Every drop is checked against equipment, weight, deadhead and remaining hours.';
    case 'dashboard':
      return 'What happened this week, and what needs chasing.';
    case 'loads':
      return 'Everything on the board, filterable.';
    case 'money':
      return 'Invoices out and what has not been paid.';
    case 'eld':
      return 'Duty status and hours remaining, per driver.';
    default:
      return '';
  }
}

function bodyFor(page: Page): string {
  if (!state.actor) return signInPanel();
  if (!state.dashboard) return '<div class="empty">Loading...</div>';

  switch (page) {
    case 'dashboard':
      return dashboardBody();
    case 'dispatch':
      return dispatchBody();
    case 'loads':
      return loadsBody();
    case 'money':
      // Fetched in go(); a placeholder keeps render() synchronous.
      return '<div class="empty">Loading receivables...</div>';
    case 'eld':
      return '<div class="empty">Loading hours of service...</div>';
    default:
      return '';
  }
}

/* ------------------------------------------------------------- dashboard */

function dashboardBody(): string {
  const s = state.dashboard!.summary;
  const h = state.dashboard!.health;
  const u = state.dashboard!.utilisation;

  const revenueUp = s.revenueThisWeekCents >= s.revenueLastWeekCents;
  const trendMax = Math.max(1, ...state.dashboard!.trend.map((point) => point.revenueCents));

  const trend = state.dashboard!
    .trend.map((point) => {
      const height = Math.max(4, Math.round((point.revenueCents / trendMax) * 70));
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px" title="${esc(
        `${point.label}: ${formatUsd(point.revenueCents)}`,
      )}>
        <div style="width:100%;height:${height}px;background:var(--accent);opacity:.7;border-radius:3px 3px 0 0"></div>
        <div style="font-size:9px;color:var(--faint)">${esc(point.label.slice(5))}</div>
      </div>`;
    })
    .join('');

  const attention =
    state.dashboard!.attention.length === 0
      ? '<div class="empty">Nothing on fire. No unassigned loads, no missing PODs.</div>'
      : state.dashboard!
          .attention.slice(0, 8)
          .map((item) => {
            const reasons = item.reasons.map((reason) => `<div class="flag warn">${esc(reason)}</div>`).join('');
            return `<div class="row">
              <div class="row-main">
                <div class="row-title">${esc(item.load.origin)} <span style="color:var(--faint)">&rarr;</span> ${esc(item.load.destination)}</div>
                <div class="row-sub">${esc(item.load.broker)}</div>
                ${reasons}
              </div>
            </div>`;
          })
          .join('');

  return `
    <div class="tiles">
      <div class="tile">
        <div class="tile-label">Revenue this week</div>
        <div class="tile-value good">${esc(formatUsd(s.revenueThisWeekCents))}</div>
        <div class="tile-detail">${esc(
          revenueUp ? 'up' : 'down',
        )} from ${esc(formatUsd(s.revenueLastWeekCents))} last week</div>
      </div>
      <div class="tile">
        <div class="tile-label">Trucks available</div>
        <div class="tile-value">${s.trucksAvailable} / ${s.trucksTotal}</div>
        <div class="tile-detail">${u.loaded} loaded, ${u.empty} empty, ${u.maintenance} in shop</div>
      </div>
      <div class="tile">
        <div class="tile-label">In transit</div>
        <div class="tile-value">${s.loadsInTransit}</div>
        <div class="tile-detail">deadhead ${Math.round(s.deadheadRatio * 100)}% Â· on time ${Math.round(s.onTimeRate * 100)}%</div>
      </div>
      <div class="tile">
        <div class="tile-label">Unpaid receivables</div>
        <div class="tile-value ${s.unpaidReceivablesCents > 0 ? 'warn' : 'good'}">${esc(
          formatUsd(s.unpaidReceivablesCents),
        )}</div>
        <div class="tile-detail">avg ${esc(formatUsd(s.averageRevenuePerMileCents))} per mile</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">Revenue by week</div>
      <div style="display:flex;align-items:flex-end;gap:6px;padding:14px">${trend}</div>
    </div>

    <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:12px">
      <div class="panel" style="margin:0">
        <div class="panel-head">Needs attention (${state.dashboard!.attention.length})</div>
        ${attention}
      </div>
      <div class="panel" style="margin:0">
        <div class="panel-head">Board health</div>
        <div style="padding:14px;display:grid;grid-template-columns:1fr 1fr;gap:10px">
          ${healthTile('Unassigned', h.unassigned, h.unassigned > 0 ? 'warn' : 'good', `${h.staleUnassigned} stale`)}
          ${healthTile('Missing POD', h.missingPod, h.missingPod > 0 ? 'bad' : 'good', 'blocks payment')}
          ${healthTile('At risk on time', h.atRiskOnTime, h.atRiskOnTime > 0 ? 'warn' : 'good', 'due within 24h')}
          ${healthTile('Fleet deployed', Math.round(u.utilisation * 100) + '%', 'good', `${u.available} idle`)}
        </div>
      </div>
    </div>
  `;
}

function healthTile(label: string, value: string | number, tone: string, detail: string): string {
  const color = tone === 'bad' ? 'var(--alert)' : tone === 'warn' ? 'var(--warn)' : tone === 'good' ? 'var(--accent)' : 'var(--ink)';
  return `<div>
    <div class="tile-label">${esc(label)}</div>
    <div style="font-size:20px;font-weight:650;color:${color};font-variant-numeric:tabular-nums">${esc(value)}</div>
    <div style="font-size:10px;color:var(--faint)">${esc(detail)}</div>
  </div>`;
}

/* --------------------------------------------------------------- dispatch */

const STATUS_COLOR: Record<string, string> = {
  booked: 'var(--booked)',
  dispatched: 'var(--rolling)',
  'in-transit': 'var(--rolling)',
  delivered: 'var(--delivered)',
  paid: 'var(--paid)',
};

const TRUCK_COLOR: Record<string, string> = {
  available: 'var(--accent)',
  loaded: '#37c97a',
  empty: 'var(--warn)',
  maintenance: 'var(--alert)',
};

function dispatchBody(): string {
  const columns = [
    { status: 'booked' as const, title: 'Waiting for a truck' },
    { status: 'dispatched' as const, title: 'Rolling' },
    { status: 'in-transit' as const, title: 'Delivered' },
  ];

  const free = state.trucks.filter((truck) => !truck.currentLoadId && truck.status !== 'maintenance');

  const board = columns
    .map((column) => {
      const loads = state.dashboard!.board.columns
        .find((entry) => entry.status === column.status)?.loads ?? [];

      const cards = loads.map((load) => loadCard(load, column.status === 'booked')).join('');

      return `<div class="column" data-drop="${column.status}">
        <div class="column-head">
          <div class="column-title">
            <span class="dot" style="background:${STATUS_COLOR[column.status]}"></span>
            ${esc(column.title)}
          </div>
          <span class="count" style="background:color-mix(in oklch, ${STATUS_COLOR[column.status]} 22%, transparent);color:${STATUS_COLOR[column.status]}">${loads.length}</span>
        </div>
        <div class="column-body">${cards || '<div class="empty">Nothing here</div>'}</div>
      </div>`;
    })
    .join('');

  const available =
    free.length === 0
      ? '<div class="empty">Every truck is carrying something or in the shop.</div>'
      : free
          .map(
            (truck) => `<div class="row">
              <div class="row-main">
                <div class="row-title">
                  <span class="dot" style="display:inline-block;background:${TRUCK_COLOR[truck.status]};margin-right:7px"></span>
                  ${esc(truck.unit)}
                  ${truck.driverId ? `<span style="color:var(--faint);font-weight:400"> Â· ${esc(truck.driverId)}</span>` : ''}
                </div>
                <div class="row-sub">${esc(truck.trailerType ?? 'dry van')}${truck.homeTerminal ? ` Â· ${esc(truck.homeTerminal)}` : ''}</div>
              </div>
              <div class="row-right">
                <button data-assign="${esc(truck.id)}" ${state.busy ? 'disabled' : ''}>Take next load</button>
              </div>
            </div>`,
          )
          .join('');

  return `
    <div class="board">${board}</div>
    <div class="panel" style="margin-top:12px">
      <div class="panel-head">Available trucks (${free.length})</div>
      ${available}
    </div>
  `;
}

function loadCard(load: Load, draggable: boolean): string {
  const rpm = load.miles > 0 ? load.rate / load.miles : 0;
  const flag = rpm < 150 ? '<div class="flag">Below $1.50/mi all-in</div>' : '';
  const pod = load.proofOfDeliveryMissing ? '<div class="flag">No POD on file</div>' : '';

  return `<div class="card" ${draggable ? `draggable="true" data-load="${esc(load.id)}"` : ''}>
    <div class="card-top">
      <div>
        <div class="lane">${esc(load.origin)}<span class="arrow">&rarr;</span><span class="to">${esc(load.destination)}</span></div>
        <div class="broker">${esc(load.broker)}${load.reference ? ` Â· ${esc(load.reference)}` : ''}</div>
      </div>
      <span class="badge" style="background:color-mix(in oklch, ${STATUS_COLOR[load.status]} 22%, transparent);color:${STATUS_COLOR[load.status]}">${esc(
        load.status === 'in-transit' ? 'in transit' : load.status,
      )}</span>
    </div>
    <div class="card-money">
      <strong>${esc(formatUsd(load.rate))}</strong>
      <span>${load.miles} mi Â· $${(rpm / 100).toFixed(2)}/mi</span>
    </div>
    ${flag}${pod}
  </div>`;
}

/* ------------------------------------------------------------------ loads */

function loadsBody(): string {
  const needle = state.search.trim().toLowerCase();
  const all = state.dashboard!.board.columns.flatMap((column) => column.loads);

  const filtered = needle
    ? all.filter((load) =>
        `${load.broker} ${load.origin} ${load.destination} ${load.reference ?? ''} ${load.commodity ?? ''}`
          .toLowerCase()
          .includes(needle),
      )
    : all;

  const rows =
    filtered.length === 0
      ? '<div class="empty">No loads match that search.</div>'
      : filtered
          .slice(0, 200)
          .map((load) => {
            const rpm = load.miles > 0 ? perMileCents(load.rate, load.miles) : 0;
            return `<div class="row">
              <div class="row-main">
                <div class="row-title">${esc(load.origin)} <span style="color:var(--faint)">&rarr;</span> ${esc(load.destination)}</div>
                <div class="row-sub">${esc(load.broker)}${load.commodity ? ` Â· ${esc(load.commodity)}` : ''}${
                  load.proofOfDeliveryMissing ? ' Â· <span style="color:var(--alert)">no POD</span>' : ''
                }</div>
              </div>
              <div class="row-right">
                <div>${esc(formatUsd(load.rate))}</div>
                <div style="color:var(--faint);font-size:11px">${load.miles} mi Â· $${(rpm / 100).toFixed(2)}/mi</div>
              </div>
              <span class="badge" style="background:color-mix(in oklch, ${STATUS_COLOR[load.status]} 22%, transparent);color:${STATUS_COLOR[load.status]}">${esc(load.status)}</span>
            </div>`;
          })
          .join('');

  return `
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search broker, lane, reference, commodity" value="${esc(state.search)}" />
      <div class="spacer"></div>
      <span style="color:var(--faint);font-size:12px">${filtered.length} of ${all.length} loads</span>
    </div>
    <div class="panel">
      <div class="panel-head">All loads</div>
      ${rows}
    </div>
  `;
}

/* ------------------------------------------------------------------ money */

async function moneyBody(): Promise<string> {
  try {
    const aging = await api<AgingResponse>('/invoice/aging', { token: actor().token });

    const order = ['current', 'days_1_30', 'days_31_60', 'days_61_90', 'days_90_plus'];
    const labels: Record<string, string> = {
      current: 'Current',
      days_1_30: '1-30 days',
      days_31_60: '31-60 days',
      days_61_90: '61-90 days',
      days_90_plus: '90+ days',
    };

    const buckets = order
      .map((key) => {
        const bucket = aging.buckets?.[key];
        return `<div>
          <div class="tile-label">${esc(labels[key])}</div>
          <div style="font-size:17px;font-weight:650;font-variant-numeric:tabular-nums">${esc(
            formatUsd(bucket?.balanceCents ?? 0),
          )}</div>
          <div style="font-size:10px;color:var(--faint)">${bucket?.count ?? 0} invoices</div>
        </div>`;
      })
      .join('');

    const delinq = (aging.topDelinquents ?? [])
      .map(
        (row) => `<div class="row">
          <div class="row-main">
            <div class="row-title">${esc(row.brokerName)}</div>
            <div class="row-sub">${esc(row.number)} Â· ${row.loadCount} loads</div>
          </div>
          <div class="row-right">
            <span class="badge" style="background:rgba(232,97,90,.15);color:var(--alert)">${row.daysPastDue}d past due</span>
            <div>${esc(formatUsd(row.balanceCents))}</div>
          </div>
        </div>`,
      )
      .join('');

    return `
      <div class="tiles">
        <div class="tile">
          <div class="tile-label">Outstanding</div>
          <div class="tile-value">${esc(formatUsd(aging.totalOutstandingCents))}</div>
        </div>
        <div class="tile">
          <div class="tile-label">Overdue</div>
          <div class="tile-value ${aging.totalOverdueCents > 0 ? 'warn' : 'good'}">${esc(formatUsd(aging.totalOverdueCents))}</div>
          <div class="tile-detail">${aging.overdueCount} invoices</div>
        </div>
        <div class="tile">
          <div class="tile-label">Avg days past due</div>
          <div class="tile-value">${aging.averageDaysPastDue}</div>
        </div>
        <div class="tile">
          <div class="tile-label">Over 60 days</div>
          <div class="tile-value ${aging.staleShare > 0.15 ? 'bad' : 'good'}">${Math.round(aging.staleShare * 100)}%</div>
          <div class="tile-detail">of the book</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head">Aging</div>
        <div style="padding:14px;display:grid;grid-template-columns:repeat(5,1fr);gap:10px">${buckets}</div>
      </div>
      <div class="panel">
        <div class="panel-head">Chase these first</div>
        ${delinq || '<div class="empty">Nothing overdue.</div>'}
      </div>
    `;
  } catch (error) {
    return `<div class="banner bad">${esc(error instanceof Error ? error.message : 'Could not load receivables')}</div>`;
  }
}

/* -------------------------------------------------------------------- ELD */

async function eldBody(): Promise<string> {
  try {
    const payload = await api<HosResponse>('/hos', { token: actor().token });

    const drivers =
      payload.hos.length === 0
        ? '<div class="empty">No ELD reporting. The built-in simulator reads duty status from the driver app, so a connected phone is enough.</div>'
        : payload.hos
            .map((entry) => {
              const used = 660 - entry.driveMinutesRemaining;
              const pct = Math.max(0, Math.min(100, (used / 660) * 100));
              const color = entry.driveMinutesRemaining < 120 ? 'var(--alert)' : entry.driveMinutesRemaining < 300 ? 'var(--warn)' : 'var(--accent)';
              const warnings = entry.warnings
                .map((warning) => `<div class="flag warn">${esc(warning.message)}</div>`)
                .join('');
              const violations = entry.violations
                .map((violation) => `<div class="flag">${esc(violation)}</div>`)
                .join('');

              return `<div class="row">
                <div class="row-main">
                  <div class="row-title">${esc(entry.driverName ?? entry.driverId)} <span style="color:var(--faint);font-weight:400">Â· ${esc(entry.unit)}</span></div>
                  <div class="row-sub">${fmtMinutes(entry.driveMinutesRemaining)} of drive time left Â· ${entry.cycle}-hour cycle</div>
                  <div class="meter" style="margin-top:5px;width:180px"><div style="width:${pct}%;background:${color}"></div></div>
                  ${warnings}${violations}
                </div>
              </div>`;
            })
            .join('');

    const providers = payload.providers
      .map(
        (provider) => `<div class="row">
          <div class="row-main">
            <div class="row-title">${esc(provider.name)} ${provider.free ? '<span class="badge" style="background:rgba(62,207,142,.15);color:var(--accent)">free</span>' : ''}</div>
            <div class="row-sub">${esc(provider.note)}</div>
          </div>
          <div class="row-right">
            <span class="badge" style="background:${provider.configured ? 'rgba(62,207,142,.15);color:var(--accent)' : 'var(--panel-raised)'};color:${provider.configured ? 'var(--accent)' : 'var(--faint)'}">${provider.configured ? 'connected' : 'not configured'}</span>
          </div>
        </div>`,
      )
      .join('');

    return `
      <div class="panel">
        <div class="panel-head">Hours of service</div>
        ${drivers}
      </div>
      <div class="panel">
        <div class="panel-head">Providers</div>
        ${providers}
      </div>
    `;
  } catch (error) {
    return `<div class="banner bad">${esc(error instanceof Error ? error.message : 'Could not load HOS')}</div>`;
  }
}

function fmtMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0m';
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/* ---------------------------------------------------------------- sign in */

function signInPanel(): string {
  return `
    <div class="panel" style="max-width:520px">
      <div class="panel-head">Sign in</div>
      <div style="padding:16px">
        <p style="color:var(--dim);font-size:12.5px;margin-top:0">
          This window talks to the TruckDesk API on the same machine. Start it with
          <code>pnpm seed</code> and <code>pnpm dev</code>, then sign in with the demo account.
        </p>
        <div style="background:var(--board);border:1px solid var(--edge);border-radius:7px;padding:10px 12px;font-size:12px;margin:12px 0">
          <div style="font-weight:600;margin-bottom:4px">Demo account</div>
          <div style="font-family:ui-monospace,monospace;color:var(--dim)">
            dispatcher@ridgewayfreight.com<br />truckdesk-demo
          </div>
        </div>
        <button class="primary" id="demo-login" ${state.busy ? 'disabled' : ''}>Use the demo account</button>
      </div>
    </div>
  `;
}

async function demoLogin(): Promise<void> {
  state.busy = true;
  render();
  try {
    const result = await api<{
      token: string;
      userId: string;
      companyId: string;
      role: Actor['role'];
      name: string;
    }>('/public/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'dispatcher@ridgewayfreight.com',
        password: 'truckdesk-demo',
      }),
    });

    state.actor = {
      userId: result.userId,
      companyId: result.companyId,
      role: result.role,
      name: result.name,
      email: 'dispatcher@ridgewayfreight.com',
      token: result.token,
    };

    state.banner = null;
    await refresh();
  } catch (error) {
    setBanner(
      'bad',
      `${error instanceof Error ? error.message : 'Sign in failed'}. If there is no database configured, the API is in memory mode and sign-in is unavailable.`,
    );
  } finally {
    state.busy = false;
    render();
  }
}

/* ------------------------------------------------------------------- wire */

function wire(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-page]')) {
    button.addEventListener('click', () => {
      state.page = button.dataset['page'] as Page;
      lastAsyncPage = null;
      state.banner = null;
      void go();
    });
  }

  const dismiss = document.querySelector<HTMLButtonElement>('[data-dismiss]');
  dismiss?.addEventListener('click', () => {
    state.banner = null;
    render();
  });

  document.getElementById('demo-login')?.addEventListener('click', () => void demoLogin());

  const search = document.getElementById('search');
  search?.addEventListener('input', (event) => {
    state.search = (event.target as HTMLInputElement).value;
    render();
    const next = document.getElementById('search') as HTMLInputElement | null;
    next?.focus();
    next?.setSelectionRange(next.value.length, next.value.length);
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-assign]')) {
    button.addEventListener('click', () => void takeNextLoad(button.dataset['assign']!));
  }

  // Drag and drop between board columns.
  for (const card of document.querySelectorAll<HTMLElement>('[data-load]')) {
    card.addEventListener('dragstart', (event) => {
      card.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', card.dataset['load'] ?? '');
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  }

  for (const column of document.querySelectorAll<HTMLElement>('[data-drop]')) {
    column.addEventListener('dragover', (event) => {
      event.preventDefault();
      column.classList.add('dragover');
    });
    column.addEventListener('dragleave', () => column.classList.remove('dragover'));
    column.addEventListener('drop', (event) => {
      event.preventDefault();
      column.classList.remove('dragover');
      const loadId = event.dataTransfer?.getData('text/plain');
      const target = column.dataset['drop'];
      if (loadId && target === 'dispatched') void assign(loadId);
    });
  }
}

/**
 * Render, then swap in the asynchronously-loaded page body.
 *
 * `render()` is synchronous so the shell paints immediately; the pages that
 * need a second fetch (receivables, HOS) show a placeholder first and are
 * replaced once the call resolves.
 */
async function go(): Promise<void> {
  const requested = state.page;
  lastAsyncPage = requested === 'money' || requested === 'eld' ? requested : null;
  render();

  const target =
    requested === 'money'
      ? await moneyBody()
      : requested === 'eld'
        ? await eldBody()
        : null;

  if (target === null) return;
  // A slow response must never overwrite a page the dispatcher has left.
  if (lastAsyncPage === null || state.page !== lastAsyncPage) return;

  const main = document.querySelector('.main');
  if (!main || state.page !== lastAsyncPage) return;

  // Replace only the page content, preserving the sidebar and banner.
  const keep = new Set(['.sidebar', '.page-head', '.banner']);
  let index = 0;
  for (const child of Array.from(main.children)) {
    const tag = child.tagName.toLowerCase();
    const isShell = child.classList.contains('sidebar') || child.classList.contains('page-head') || child.classList.contains('banner');
    if (!isShell && !keep.has(tag)) {
      child.remove();
      index += 1;
    }
  }

  const holder = document.createElement('div');
  holder.innerHTML = target;
  for (const node of Array.from(holder.children)) {
    main.append(node);
  }

  wire();
  void index;
}

/** The page the placeholder was rendered for, so a slow response cannot
 *  overwrite the page the dispatcher has since navigated to. */
let lastAsyncPage: Page | null = null;

async function assign(loadId: string): Promise<void> {
  const load = state.dashboard!.board.columns.flatMap((c) => c.loads).find((l) => l.id === loadId);
  const free = state.trucks.filter((truck) => !truck.currentLoadId && truck.status !== 'maintenance');
  const truckId = free[0]?.id;
  if (!truckId || !load) return;

  state.busy = true;
  try {
    const result = await api<{ warnings: string[]; deadheadMiles: number; marginFormatted: string }>(
      '/dispatch',
      { method: 'POST', token: actor().token, body: JSON.stringify({ loadId, truckId }) },
    );
    setBanner(
      result.warnings.length > 0 ? 'warn' : 'good',
      result.warnings.length > 0
        ? result.warnings.join(' Â· ')
        : `Assigned to ${free[0]!.unit}: ${result.deadheadMiles} mi deadhead, ${result.marginFormatted} margin`,
    );
  } catch (error) {
    setBanner('bad', error instanceof Error ? error.message : 'Assignment refused');
  } finally {
    state.busy = false;
    await refresh();
    render();
  }
}

async function takeNextLoad(truckId: string): Promise<void> {
  const booked = state.dashboard!.board.columns.find((c) => c.status === 'booked')?.loads ?? [];
  const next = booked[0];
  if (!next) {
    setBanner('warn', 'No load is waiting for a truck.');
    return;
  }
  await assign(next.id);
  void truckId;
}

/* ------------------------------------------------------------------- boot */

async function boot(): Promise<void> {
  const bridge = (window as unknown as { truckdesk?: TruckDeskBridge }).truckdesk;

  try {
    const version = await bridge?.version();
    if (version) {
      state.apiUrl = version.apiUrl;
      state.version = version.app;
    }
  } catch {
    // Running outside Electron (a plain browser), fall back to the default.
  }

  // Restore a session saved for this window only.
  try {
    const stored = localStorage.getItem('truckdesk.actor');
    if (stored) state.actor = JSON.parse(stored) as Actor;
  } catch {
    localStorage.removeItem('truckdesk.actor');
  }

  if (state.actor) {
    try {
      await refresh();
      if (!state.dashboard) state.actor = null;
      else localStorage.setItem('truckdesk.actor', JSON.stringify(state.actor));
    } catch {
      state.actor = null;
    }
  }

  render();
  window.setInterval(() => {
    if (state.actor && !state.busy) void refresh().then(render);
  }, 20_000);
}

void boot();

export {};
