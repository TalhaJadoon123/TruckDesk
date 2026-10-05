import { Errors, err, ok, type Result } from '@truckdesk/shared';

import { MotiveProvider, type MotiveOptions } from './motive.js';
import { SamsaraProvider, type SamsaraOptions } from './samsara.js';
import { ManualProvider, SimulatorProvider, type SimulatorOptions } from './simulator.js';
import { computeHos, projectTrip, toDispatchReadiness } from './hos.js';
import type { EldProvider } from './types.js';

/**
 * @truckdesk/eld - HOS math and ELD connectors.
 *
 * Providers are chosen per truck. A carrier can run Samsara on three trucks,
 * Motive on two, and the app on the rest; nothing requires a subscription.
 */

export * from './types.js';
export * from './hos.js';
export * from './samsara.js';
export * from './motive.js';
export * from './simulator.js';

export interface EldConfig {
  samsara?: SamsaraOptions & { token?: string };
  motive?: MotiveOptions & { accessToken?: string };
  simulator?: SimulatorOptions;
}

/**
 * Resolve the provider for a truck. Falls back to the simulator rather than
 * failing, because a missing ELD must never block dispatch.
 */
export function resolveProvider(
  name: string | undefined,
  config: EldConfig,
): EldProvider {
  switch (name) {
    case 'samsara': {
      const provider = new SamsaraProvider(config.samsara ?? {});
      return provider.isConfigured() ? provider : new SimulatorProvider(config.simulator ?? { vehicles: [] });
    }
    case 'motive': {
      const provider = new MotiveProvider(config.motive ?? {});
      return provider.isConfigured() ? provider : new SimulatorProvider(config.simulator ?? { vehicles: [] });
    }
    case 'manual':
      return new ManualProvider();
    case 'simulator':
    default:
      return new SimulatorProvider(config.simulator ?? { vehicles: [] });
  }
}

/** Every provider TruckDesk can talk to, with its configured status. */
export function providerStatus(config: EldConfig): Array<{
  name: string;
  configured: boolean;
  free: boolean;
  note: string;
}> {
  return [
    {
      name: 'simulator',
      configured: true,
      free: true,
      note: 'Built in. Duty status from the driver app, GPS from the phone. No account needed.',
    },
    {
      name: 'manual',
      configured: true,
      free: true,
      note: 'Built in. Drivers mark duty status by hand in the app.',
    },
    {
      name: 'samsara',
      configured: Boolean(config.samsara?.token),
      free: false,
      note: 'Free developer sandbox for integration testing. Production use needs a Samsara subscription.',
    },
    {
      name: 'motive',
      configured: Boolean(config.motive?.accessToken || config.motive?.refreshToken),
      free: false,
      note: 'Free trial available. API access requires a Motive plan.',
    },
  ];
}

export interface HosReadinessResult {
  driverId: string;
  vehicleId: string;
  driveMinutesRemaining: number;
  dutyMinutesRemaining: number;
  breakMinutesRemaining: number;
  cycleMinutesRemaining: number;
  cycle: 60 | 70;
  violations: string[];
  warnings: Array<{ message: string; minutesUntil: number }>;
  canRestartAt: string | null;
}

/**
 * One call from `packages/api` to answer "can this driver take that load?".
 * Never throws: an unreachable ELD returns a permissive result, because a
 * dispatcher must not be locked out of dispatch by a vendor outage.
 */
export async function readinessFor(
  provider: EldProvider,
  vehicleId: string,
  driverId: string,
  now: Date = new Date(),
): Promise<Result<HosReadinessResult>> {
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  try {
    const logs = await provider.hosLogs(vehicleId, now.toISOString());

    // Prefer the provider's own summary; fall back to recomputing from
    // intervals when the vendor returns zeroes.
    const intervals = await provider.dutyIntervals(
      vehicleId,
      new Date(dayStart.getTime() - 8 * 86_400_000).toISOString(),
      now.toISOString(),
    );

    const computation = computeHos({ intervals, now });

    const driveMinutesRemaining =
      logs.cycles[0]?.driveMinutesRemaining && logs.cycles[0].driveMinutesRemaining > 0
        ? logs.cycles[0].driveMinutesRemaining
        : computation.driveMinutesRemaining;

    const dutyMinutesRemaining =
      logs.cycles[0]?.dutyMinutesRemaining && logs.cycles[0].dutyMinutesRemaining > 0
        ? logs.cycles[0].dutyMinutesRemaining
        : computation.dutyMinutesRemaining;

    const violations = [
      ...logs.violations.map((violation) => violation.message),
      ...computation.violations.map((violation) => violation.message),
    ];

    return ok({
      driverId,
      vehicleId,
      driveMinutesRemaining,
      dutyMinutesRemaining,
      breakMinutesRemaining: computation.breakMinutesRemaining,
      cycleMinutesRemaining: computation.onDutyMinutesRemainingInCycle,
      cycle: computation.cycle.cycle,
      violations,
      warnings: computation.warnings,
      canRestartAt: computation.canRestartAt,
    });
  } catch (error) {
    return err(
      Errors.unavailable(
        `ELD provider ${provider.name}`,
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
  }
}

/** Convert an ELD result into the shape `core.dispatch` expects. */
export function toDispatchReadinessMap(
  results: readonly HosReadinessResult[],
): Record<string, {
  driverId: string;
  driveMinutesRemaining: number;
  dutyMinutesRemaining: number;
  breakMinutesRemaining: number;
  cycle: 60 | 70;
  cycleMinutesRemaining: number;
  violations: string[];
}> {
  const map: Record<string, ReturnType<typeof toDispatchReadiness>> = {};
  for (const result of results) {
    map[result.driverId] = toDispatchReadiness(result.driverId, {
      dutyStatus: 'on_duty',
      shift: {
        shiftStartedAt: null,
        drivingMinutesInShift: 0,
        onDutyMinutesInShift: 0,
        sinceBreakMinutes: 0,
        breakSatisfied: true,
      },
      cycle: {
        cycle: result.cycle,
        onDutyMinutesInCycle: 0,
        cycleStartedAt: '',
        minutesRemaining: result.cycleMinutesRemaining,
        daysInCycle: 0,
      },
      driveMinutesRemaining: result.driveMinutesRemaining,
      dutyMinutesRemaining: result.dutyMinutesRemaining,
      breakMinutesRemaining: result.breakMinutesRemaining,
      onDutyMinutesRemainingInCycle: result.cycleMinutesRemaining,
      breakSatisfied: result.breakMinutesRemaining === -1,
      projectedViolationMinutes: 0,
      violations: result.violations.map((message) => ({ type: 'cycle' as const, message, at: '', severity: 'warning' as const })),
      warnings: result.warnings.map((warning) => ({
        type: 'cycle' as const,
        message: warning.message,
        minutesUntil: warning.minutesUntil,
      })),
      canRestartAt: result.canRestartAt,
    });
  }
  return map;
}
export { computeHos, projectTrip, toDispatchReadiness };
