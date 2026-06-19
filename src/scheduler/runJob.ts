import { noTrains, routeReport } from '../bot/templates.ts';
import type { BotRoute } from '../bot/types.ts';
import type { Config, Route, Schedule } from '../config/types.ts';
import type { Counters } from '../core/counters.ts';
import { extractTrains, formatTrainLine } from '../rail/format.ts';
import type { RailApiGetRoutesResult } from '../rail/types.ts';

/** Injected dependencies for testability. */
export interface RunJobDeps {
  fetchRoutes: (
    fromId: number,
    toId: number,
    when: Date,
    signal?: AbortSignal,
  ) => Promise<RailApiGetRoutesResult>;
  send: (
    botNumber: string,
    recipient: string,
    message: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  counters: Counters;
  /** Override "now" for testing. Defaults to `new Date()`. */
  now?: () => Date;
  /**
   * Optional: inject a specific lock map (for isolated unit tests).
   * Defaults to the module-level lockMap.
   */
  lockMap?: Map<string, boolean>;
  /**
   * Optional: inject a specific DST guard set (for isolated unit tests).
   * Defaults to the module-level dstGuard.
   */
  dstGuard?: Set<string>;
}

const logger = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'info', msg, ...meta })),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: 'warn', msg, ...meta })),
};

/**
 * Module-level lock map: scheduleId → whether a job is currently running.
 * Prevents overlapping executions of the same scheduled job.
 */
const moduleLockMap = new Map<string, boolean>();

/**
 * Module-level DST run-guard: tracks "id:localDate:localTime" keys.
 * Prevents double-firing that can occur when DST clocks back and a cron
 * expression matches twice in the same wall-clock minute.
 */
const moduleDstGuard = new Set<string>();

/** Format a Date as "YYYY-MM-DD" in Asia/Jerusalem local time. */
function localDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Format a Date as "HH:mm" in Asia/Jerusalem local time. */
function localTime(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** Convert a config Route to the BotRoute shape required by templates. */
function toBotRoute(route: Route, index: number): BotRoute {
  return {
    key: route.key,
    index,
    label_en: route.label_en,
    label_he: route.label_he,
    aliases: route.aliases,
  };
}

/**
 * Deadline wrapper: runs `fn` with an AbortSignal that fires when the deadline
 * is exceeded, so the in-flight rail/Signal request is cancelled instead of
 * lingering and holding the lock (or doubling load on the next tick).
 */
function withDeadline<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort(new Error(`runJob: deadline exceeded (${ms} ms)`));
      reject(new Error(`runJob: deadline exceeded (${ms} ms)`));
    }, ms);
    fn(controller.signal).then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Execute one scheduled push for the given schedule entry.
 *
 * @param schedule  The schedule configuration entry to execute.
 * @param config    Full application configuration.
 * @param deps      Injected runtime dependencies (fetchRoutes, send, counters, now?).
 */
export async function runJob(schedule: Schedule, config: Config, deps: RunJobDeps): Promise<void> {
  const lockMap = deps.lockMap ?? moduleLockMap;
  const dstGuard = deps.dstGuard ?? moduleDstGuard;
  const now = deps.now ? deps.now() : new Date();

  // --- DST run-guard ---------------------------------------------------
  const guardKey = `${schedule.id}:${localDate(now)}:${localTime(now)}`;
  if (dstGuard.has(guardKey)) {
    logger.info('runJob: DST guard skipped duplicate fire', {
      scheduleId: schedule.id,
      guardKey,
    });
    return;
  }
  dstGuard.add(guardKey);
  // Trim the guard set to avoid unbounded growth (keep last 1000 entries).
  if (dstGuard.size > 1000) {
    const first = dstGuard.values().next().value as string;
    dstGuard.delete(first);
  }

  // --- Per-job boolean lock --------------------------------------------
  if (lockMap.get(schedule.id) === true) {
    logger.info('runJob: job already running, skipping', {
      scheduleId: schedule.id,
    });
    return;
  }
  lockMap.set(schedule.id, true);

  try {
    await withDeadline((signal) => doRun(schedule, config, deps, now, signal), 60_000);
  } catch (err: unknown) {
    // Deadline exceeded (the only way control reaches here — doRun never
    // throws). The deadline aborts the in-flight request, so doRun's own
    // catch records the failure counter; we only log here to avoid
    // double-counting.
    logger.warn('runJob: job ended with error', {
      scheduleId: schedule.id,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    lockMap.set(schedule.id, false);
  }
}

/**
 * Inner execution body, separated so the lock's `finally` cleanly wraps it.
 * Catches its own errors and records counters — never throws.
 */
async function doRun(
  schedule: Schedule,
  config: Config,
  deps: RunJobDeps,
  now: Date,
  signal?: AbortSignal,
): Promise<void> {
  const route = config.routes.find((r) => r.key === schedule.route_key);
  if (!route) {
    logger.warn('runJob: unknown route_key', { routeKey: schedule.route_key });
    return;
  }

  // 1-based index = position in config.routes array + 1.
  const routeIndex = config.routes.indexOf(route) + 1;
  const botRoute = toBotRoute(route, routeIndex);
  const count = schedule.count;

  let message: string;
  try {
    const result = await deps.fetchRoutes(route.from_id, route.to_id, now, signal);
    const trains = extractTrains(result, count, now.getTime());

    if (trains.length === 0) {
      message = noTrains(botRoute);
    } else {
      const lines = trains.map(formatTrainLine);
      message = routeReport(botRoute, lines, now, trains[0].dayNote);
    }
  } catch (err: unknown) {
    logger.warn('runJob: fetchRoutes failed', {
      scheduleId: schedule.id,
      routeKey: route.key,
      error: err instanceof Error ? err.message : String(err),
    });
    deps.counters.record(route.key, 'fail');
    return;
  }

  try {
    await deps.send(config.signal.bot_number, config.signal.owner_uuid, message, signal);
    deps.counters.record(route.key, 'success');
  } catch (err: unknown) {
    logger.warn('runJob: send failed', {
      scheduleId: schedule.id,
      routeKey: route.key,
      error: err instanceof Error ? err.message : String(err),
    });
    deps.counters.record(route.key, 'fail');
  }
}
