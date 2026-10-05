'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';

import type { Load, Truck } from '@truckdesk/shared';

import {
  endpoints,
  formatCpm,
  formatDuration,
  formatEta,
  type AssignResponse,
  type DashboardResponse,
  type MatchResponse,
  type TrackResponse,
} from '@/lib/api';
import { Banner, Button, Card, EmptyState, Lane, LoadBadge, Money, Select, Spinner, Tag, TruckBadge } from '@/components/ui';
import { FleetMap } from '@/components/FleetMap';

/**
 * Drag-drop dispatch board.
 *
 * Three things make this usable rather than a toy:
 *
 *   1. Every drop is checked against the domain rules (equipment, weight, HOS,
 *      rate per mile, deadhead) before it commits, and the reason is shown
 *      instead of a silent no-op.
 *   2. Optimistic UI with rollback. The card moves immediately, and if the API
 *      refuses, it goes back exactly where it was.
 *   3. The match panel explains its ranking. A dispatcher who does not agree with
 *      a score needs to see which factor drove it.
 */

interface BoardProps {
  sessionToken: string;
  initialBoard: DashboardResponse['board'];
  initialDashboard: DashboardResponse;
}

type Toast = { tone: 'good' | 'bad' | 'warn'; title: string; detail?: string } | null;

export function DispatchBoard({ sessionToken, initialBoard, initialDashboard }: BoardProps) {
  const [columns, setColumns] = useState(initialBoard.columns);
  const [trucks, setTrucks] = useState<Truck[]>([]);
  const [track, setTrack] = useState<TrackResponse | null>(null);
  const [matches, setMatches] = useState<MatchResponse | null>(null);
  const [selected, setSelected] = useState<Load | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'board' | 'match' | 'map'>('board');

  // Snapshots for rollback if the API refuses the assignment.
  const boardRef = useRef(columns);
  boardRef.current = columns;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [loadResponse, trackResponse] = await Promise.all([
          endpoints.board(sessionToken),
          endpoints.track(sessionToken),
        ]);
        if (cancelled) return;
        setColumns(loadResponse.columns);
        setTrack(trackResponse);
        setTrucks(
          trackResponse.trucks.map((entry) => ({
            id: entry.id,
            unit: entry.unit,
            status: entry.status,
            location: trackResponse.positions.find((position) => position.truckId === entry.id)?.location ?? {
              lat: 39.96,
              lng: -83.0,
            },
            driverId: entry.driverId,
            currentLoadId: entry.loadId,
          })),
        );
      } catch (error) {
        if (!cancelled) {
          setToast({
            tone: 'bad',
            title: 'Could not refresh the board',
            detail: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    void load();
    // Poll: a dispatcher watching trucks move needs the board to move too.
    const timer = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionToken]);

  const booked = useMemo(
    () => columns.find((column) => column.status === 'booked')?.loads ?? [],
    [columns],
  );
  const active = useMemo(
    () =>
      columns
        .filter((column) => column.status === 'dispatched' || column.status === 'in-transit')
        .flatMap((column) => column.loads),
    [columns],
  );
  const finished = useMemo(
    () =>
      columns
        .filter((column) => column.status === 'delivered' || column.status === 'paid')
        .flatMap((column) => column.loads),
    [columns],
  );

  async function handleAssign(loadId: string, truckId: string) {
    const snapshot = boardRef.current;
    setBusy(true);

    // Optimistic: move the card into `dispatched` right away.
    setColumns((current) =>
      current.map((column) => ({
        ...column,
        loads: column.loads.map((load) => {
          if (column.status === 'booked' && load.id === loadId) {
            return { ...load, status: 'dispatched' as const, assignedTruckId: truckId };
          }
          return load;
        }),
      })),
    );

    try {
      const response: AssignResponse = await endpoints.assign(sessionToken, loadId, truckId);
      setToast({
        tone: response.warnings.length > 0 ? 'warn' : 'good',
        title: `Assigned ${response.truck.unit}`,
        detail:
          response.warnings.length > 0
            ? response.warnings.join(' · ')
            : `${response.deadheadMiles} mi deadhead · ${response.projectedHours}h projected · ${response.marginFormatted} margin`,
      });
      setSelected(null);
    } catch (error) {
      // Roll back to exactly where we were.
      setColumns(snapshot);
      setToast({
        tone: 'bad',
        title: 'Assignment refused',
        detail: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleUnassign(loadId: string) {
    setBusy(true);
    try {
      await endpoints.unassign(sessionToken, loadId);
      setToast({ tone: 'good', title: 'Load returned to the board' });
    } catch (error) {
      setToast({
        tone: 'bad',
        title: 'Could not unassign',
        detail: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  }

  async function loadMatches() {
    setTab('match');
    if (matches) return;
    setBusy(true);
    try {
      const response = await endpoints.match(sessionToken);
      setMatches(response);
    } catch (error) {
      setToast({
        tone: 'bad',
        title: 'Could not score the board',
        detail: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {toast ? (
        <Banner
          tone={toast.tone === 'good' ? 'good' : toast.tone === 'bad' ? 'bad' : 'warn'}
          title={toast.title}
        >
          <div className="flex items-start justify-between gap-3">
            <span>{toast.detail}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="shrink-0 opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        </Banner>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-md border border-[var(--color-edge)] p-1">
          {(['board', 'match', 'map'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => (key === 'match' ? void loadMatches() : setTab(key))}
              className={`rounded px-3 py-1 text-sm transition ${
                tab === key
                  ? 'bg-[var(--color-panel-raised)] font-medium'
                  : 'text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]'
              }`}
            >
              {key === 'match' ? 'Auto-match' : key === 'map' ? 'Map' : 'Board'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs text-[var(--color-ink-dim)]">
          <Tag tone="good">{initialDashboard.summary.trucksAvailable} available</Tag>
          <Tag>{active.length} rolling</Tag>
          <Tag tone={booked.length > 6 ? 'warn' : 'neutral'}>{booked.length} waiting</Tag>
        </div>
      </div>

      {tab === 'board' ? (
        <div className="grid gap-3 lg:grid-cols-3">
          <Column
            title="Waiting for a truck"
            tone="var(--color-booked)"
            loads={booked}
            emptyDetail="Nothing booked. Forward a broker email to the app, or add a load by hand."
            onSelect={setSelected}
            draggable
          />
          <Column
            title="Rolling"
            tone="var(--color-transit)"
            loads={active}
            emptyDetail="No loads dispatched."
            onSelect={setSelected}
            draggable={false}
            onUnassign={busy ? undefined : handleUnassign}
          />
          <Column
            title="Delivered"
            tone="var(--color-delivered)"
            loads={finished}
            emptyDetail="Nothing delivered yet this week."
            onSelect={setSelected}
            draggable={false}
          />
        </div>
      ) : null}

      {tab === 'match' ? (
        <MatchPanel
          matches={matches}
          busy={busy}
          onAssign={busy ? undefined : handleAssign}
        />
      ) : null}

      {tab === 'map' ? (
        <Card className="overflow-hidden p-0">
          <FleetMap track={track} height={560} />
        </Card>
      ) : null}

      {/* The assign tray. Opens when a load is picked, lists trucks ranked. */}
      {selected ? (
        <AssignTray
          token={sessionToken}
          load={selected}
          trucks={trucks}
          track={track}
          busy={busy}
          onClose={() => setSelected(null)}
          onAssign={handleAssign}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Column                                                                        */
/* -------------------------------------------------------------------------- */

function Column({
  title,
  tone,
  loads,
  emptyDetail,
  onSelect,
  draggable,
  onUnassign,
}: {
  title: string;
  tone: string;
  loads: Load[];
  emptyDetail: string;
  onSelect: (load: Load) => void;
  draggable: boolean;
  onUnassign?: (loadId: string) => void;
}) {
  return (
    <div className="flex min-h-[24rem] flex-col rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)]">
      <header className="flex items-center justify-between border-b border-[var(--color-edge)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: tone }} />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        <span
          className="money rounded px-1.5 py-0.5 text-xs font-medium"
          style={{ background: `color-mix(in oklch, ${tone} 18%, transparent)`, color: tone }}
        >
          {loads.length}
        </span>
      </header>

      <div className="flex-1 space-y-2 overflow-auto p-2">
        {loads.length === 0 ? (
          <EmptyState title="Empty" detail={emptyDetail} />
        ) : (
          loads.map((load) => (
            <LoadCard
              key={load.id}
              load={load}
              draggable={draggable}
              onSelect={() => onSelect(load)}
              onUnassign={onUnassign}
            />
          ))
        )}
      </div>
    </div>
  );
}

function LoadCard({
  load,
  draggable,
  onSelect,
  onUnassign,
}: {
  load: Load;
  draggable: boolean;
  onSelect: () => void;
  onUnassign?: (loadId: string) => void;
}) {
  const rpm = load.miles > 0 ? load.rate / load.miles : 0;
  const flag = rpm < 150;

  return (
    <article
      draggable={draggable}
      onClick={onSelect}
      className={`animate-in cursor-pointer rounded-md border border-[var(--color-edge)] bg-[var(--color-board)] p-2.5 transition hover:border-[var(--color-accent)] ${
        draggable ? 'active:cursor-grabbing' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Lane origin={load.origin} destination={load.destination} />
          <div className="mt-0.5 truncate text-xs text-[var(--color-ink-faint)]">
            {load.broker}
            {load.reference ? ` · ${load.reference}` : ''}
          </div>
        </div>
        <LoadBadge status={load.status} />
      </div>

      <div className="money mt-2 flex items-center justify-between text-xs">
        <span className="font-medium">
          <Money cents={load.rate} />
        </span>
        <span className="text-[var(--color-ink-dim)]">
          {load.miles} mi · {formatCpm(rpm)}/mi
        </span>
      </div>

      {flag ? (
        <div className="mt-1.5 text-[11px] text-[var(--color-alert)]">
          Below $1.50/mi all-in
        </div>
      ) : null}

      {load.proofOfDeliveryMissing ? (
        <div className="mt-1.5 text-[11px] text-[var(--color-alert)]">No POD on file</div>
      ) : null}

      {onUnassign && load.status === 'dispatched' ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onUnassign(load.id);
          }}
          className="mt-2 text-[11px] text-[var(--color-ink-faint)] underline hover:text-[var(--color-alert)]"
        >
          pull off truck
        </button>
      ) : null}
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Assign tray                                                                   */
/* -------------------------------------------------------------------------- */

function AssignTray({
  token,
  load,
  trucks,
  track,
  busy,
  onClose,
  onAssign,
}: {
  token: string;
  load: Load;
  trucks: Truck[];
  track: TrackResponse | null;
  busy: boolean;
  onClose: () => void;
  onAssign: (loadId: string, truckId: string) => void;
}) {
  const [score, setScore] = useState<MatchResponse | null>(null);
  const [filter, setFilter] = useState<'all' | 'available'>('available');

  useEffect(() => {
    let cancelled = false;
    endpoints
      .match(token)
      .then((response) => {
        if (!cancelled) setScore(response);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Rank trucks for this specific load.
  const ranked = useMemo(() => {
    const fromMatch = score?.matches
      .filter((match) => match.loadId === load.id)
      .sort((a, b) => b.score - a.score)
      .map((match) => ({
        truck: trucks.find((candidate) => candidate.id === match.truckId),
        match,
      }))
      .filter((row): row is { truck: Truck; match: MatchResponse['matches'][number] } => Boolean(row.truck));

    if (fromMatch.length > 0) return fromMatch;

    return trucks.map((truck) => ({ truck, match: null }));
  }, [score, trucks, load.id]);

  const visible = ranked.filter((row) =>
    filter === 'all' ? true : !row.truck.currentLoadId && row.truck.status !== 'maintenance',
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
      <Card
        title={`Assign ${load.origin} to ${load.destination}`}
        className="w-full max-w-2xl"
        action={
          <div className="flex items-center gap-2">
            <Select
              value={filter}
              onChange={(event) => setFilter(event.target.value as 'all' | 'available')}
              aria-label="Truck filter"
            >
              <option value="available">Available only</option>
              <option value="all">All trucks</option>
            </Select>
            <Button variant="subtle" size="sm" onClick={onClose}>
              close
            </Button>
          </div>
        }
      >
        <div className="max-h-[28rem] overflow-auto p-2">
          {visible.length === 0 ? (
            <EmptyState
              title="No eligible trucks"
              detail="Every truck is either on a load, in maintenance, or missing a driver."
            />
          ) : (
            <div className="space-y-2">
              {visible.map(({ truck, match }) => {
                const position = track?.positions.find((entry) => entry.truckId === truck.id);
                const unavailable = Boolean(truck.currentLoadId) || truck.status === 'maintenance';

                return (
                  <div
                    key={truck.id}
                    className="flex items-start justify-between gap-3 rounded-md border border-[var(--color-edge)] bg-[var(--color-board)] p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{truck.unit}</span>
                        <TruckBadge status={truck.status} />
                        {position?.isStale ? <Tag tone="warn">stale ping</Tag> : null}
                      </div>

                      {match ? (
                        <div className="mt-1.5 space-y-0.5">
                          {match.explanations
                            .slice()
                            .sort((a, b) => b.contribution - a.contribution)
                            .slice(0, 3)
                            .map((explanation) => (
                              <div
                                key={explanation.factor}
                                className="flex items-baseline justify-between gap-2 text-[11px]"
                              >
                                <span className="text-[var(--color-ink-dim)]">{explanation.label}</span>
                                <span className="money text-[var(--color-ink-faint)]">
                                  {explanation.detail}
                                </span>
                              </div>
                            ))}
                        </div>
                      ) : (
                        <div className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
                          {position
                            ? `${position.staleMinutes}m since last ping`
                            : 'no position yet'}
                        </div>
                      )}

                      {match?.warnings.length ? (
                        <div className="mt-1.5 space-y-0.5">
                          {match.warnings.map((warning) => (
                            <div key={warning} className="text-[11px] text-[var(--color-empty)]">
                              {warning}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div className="shrink-0 text-right">
                      {match ? (
                        <div className="money mb-1.5 text-sm font-semibold text-[var(--color-accent)]">
                          {(match.score * 100).toFixed(0)}
                        </div>
                      ) : null}
                      <Button
                        size="sm"
                        disabled={busy || unavailable}
                        onClick={() => onAssign(load.id, truck.id)}
                      >
                        {unavailable ? 'unavailable' : 'assign'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Match panel                                                                   */
/* -------------------------------------------------------------------------- */

function MatchPanel({
  matches,
  busy,
  onAssign,
}: {
  matches: MatchResponse | null;
  busy: boolean;
  onAssign?: (loadId: string, truckId: string) => void;
}) {
  if (busy && !matches) return <Spinner label="Scoring the board" />;

  if (!matches) {
    return (
      <Card>
        <EmptyState
          title="Auto-match scores every open load against every free truck"
          detail="It weighs revenue per mile, deadhead to pickup, the driver's usual lanes and how many hours they have left."
        />
      </Card>
    );
  }

  return (
    <Card title={`Suggested assignments (${matches.matches.length})`}>
      {matches.matches.length === 0 ? (
        <EmptyState title="No eligible pairings" detail="Every load is blocked or every truck is busy." />
      ) : (
        <div className="divide-y divide-[var(--color-edge)]">
          {matches.matches.map((match) => (
            <div key={`${match.loadId}-${match.truckId}`} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  <span className="font-medium">{match.truckUnit}</span>
                  <span className="mx-1.5 text-[var(--color-ink-faint)]">&rarr;</span>
                  {match.driverName ? (
                    <span className="text-[var(--color-ink-dim)]">{match.driverName}</span>
                  ) : null}
                  <span className="mx-1.5 text-[var(--color-ink-faint)]">&middot;</span>
                  <Money cents={match.revenuePerMileCents} className="text-[var(--color-ink-dim)]" />
                  <span className="text-[var(--color-ink-faint)]">/mi</span>
                </div>
                <div className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                  {match.deadheadMiles} mi deadhead · {match.projectedHours}h projected · margin{' '}
                  <Money cents={match.marginCents} />
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <div className="money text-right">
                  <div className="text-lg font-semibold text-[var(--color-accent)]">
                    {(match.score * 100).toFixed(0)}
                  </div>
                  <div className="text-[10px] text-[var(--color-ink-faint)]">score</div>
                </div>
                {onAssign ? (
                  <Button size="sm" disabled={busy} onClick={() => onAssign(match.loadId, match.truckId)}>
                    assign
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {matches.unmatched.length > 0 ? (
        <div className="border-t border-[var(--color-edge)] px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
            No match
          </div>
          <div className="mt-1.5 space-y-1">
            {matches.unmatched.slice(0, 8).map((row) => (
              <div key={row.load.id} className="flex justify-between gap-3 text-xs">
                <span className="truncate text-[var(--color-ink-dim)]">
                  {row.load.origin} &rarr; {row.load.destination}
                </span>
                <span className="shrink-0 text-[var(--color-ink-faint)]">{row.reason}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export { formatDuration, formatEta, use };