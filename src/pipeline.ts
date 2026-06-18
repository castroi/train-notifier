/**
 * On-demand message pipeline (plan §16.1 / Task 8).
 *
 * Exports:
 *   toBotRoutes(config)        — convert config routes to BotRoute[]
 *   trainLinesFor(route, count, deps) — fetch + format train lines
 *   handleMessage(msg, config, deps)  — full on-demand pipeline
 */

import { parseInput, resolveEager } from './bot/parse.ts';
import { eagerGreeting, menu, noTrains, outage, routeReport } from './bot/templates.ts';
import type { BotRoute, BotWindow } from './bot/types.ts';
import type { Config, Route } from './config/types.ts';
import { hashSender, isAllowed, logUnknownSender } from './core/allowlist.ts';
import type { Counters } from './core/counters.ts';
import type { DedupCache } from './core/dedup.ts';
import { dedupKey } from './core/dedup.ts';
import type { RateLimiter } from './core/ratelimit.ts';
import { extractTrains, formatTrainLine } from './rail/format.ts';
import type { RailApiGetRoutesResult } from './rail/types.ts';
import type { IncomingMessage } from './signal/types.ts';

// ---------------------------------------------------------------------------
// Public dependency interface for handleMessage
// ---------------------------------------------------------------------------

export interface PipelineDeps {
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
  dedup: DedupCache;
  counters: Counters;
  /** Optional per-sender rate limiter (A04). When omitted, no throttling. */
  rateLimiter?: RateLimiter;
  /** Override "now" for testing. Defaults to `new Date()`. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = {
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: 'warn', msg, ...meta })),
};

/**
 * Derive greeting string from the Jerusalem local hour.
 * 06:00–11:59 → "Good morning"
 * 12:00–16:59 → "Good afternoon"
 * 17:00–20:59 → "Good evening"
 * else         → "Hello"
 */
function greetingFor(now: Date): string {
  const hourStr = now.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    hour12: false,
  });
  const hour = parseInt(hourStr, 10);
  if (hour >= 6 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 21) return 'Good evening';
  return 'Hello';
}

/**
 * Deadline wrapper: runs `fn` with an AbortSignal that fires when the deadline
 * is exceeded, so in-flight rail/Signal requests are actually cancelled (not
 * left running to double up on the next call).
 */
function withDeadline<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort(new Error(`pipeline: deadline exceeded (${ms} ms)`));
      reject(new Error(`pipeline: deadline exceeded (${ms} ms)`));
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

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Convert config routes to the BotRoute shape used by the bot module.
 * index = 1-based position in config.routes.
 */
export function toBotRoutes(config: Config): BotRoute[] {
  return config.routes.map((r: Route, i: number) => ({
    key: r.key,
    index: i + 1,
    label_en: r.label_en,
    label_he: r.label_he,
    aliases: r.aliases,
  }));
}

/**
 * Fetch and format train lines for a config route.
 * Returns [] when the API returns zero trains.
 * Throws on fetch/format failure (let caller decide how to handle).
 */
export async function trainLinesFor(
  route: Route,
  count: number,
  deps: Pick<PipelineDeps, 'fetchRoutes' | 'now'>,
  signal?: AbortSignal,
): Promise<string[]> {
  const now = deps.now ? deps.now() : new Date();
  const result = await deps.fetchRoutes(route.from_id, route.to_id, now, signal);
  const trains = extractTrains(result, count, now.getTime());
  return trains.map(formatTrainLine);
}

/**
 * Full on-demand pipeline (plan §16.1).
 *
 * Steps:
 *   a. Allowlist check — unknown sender → log hashed id, silent return.
 *   b. Dedup check — already-seen message → silent return.
 *   c. Parse input → route or menu.
 *   d. Fetch+format within a ~25 s deadline; send reply.
 *      Rail failure or deadline → send outage() best-effort.
 */
export async function handleMessage(
  msg: IncomingMessage,
  config: Config,
  deps: PipelineDeps,
  salt: string,
): Promise<void> {
  // --- a. Allowlist check -----------------------------------------------
  if (!isAllowed(msg.sourceUuid, config.signal.allowlist)) {
    const hashed = hashSender(msg.sourceUuid ?? '', salt);
    logUnknownSender(hashed);
    return;
  }

  // --- b. Dedup check ---------------------------------------------------
  if (deps.dedup.seen(dedupKey(msg))) {
    return;
  }

  // --- b2. Rate limit (A04) — cap outbound work per allowlisted sender ---
  if (deps.rateLimiter && !deps.rateLimiter.allow(msg.sourceUuid ?? '')) {
    logger.warn('handleMessage: sender rate-limited, dropping');
    return;
  }

  const botNumber = config.signal.bot_number;
  const ownerUuid = config.signal.owner_uuid;
  const botRoutes = toBotRoutes(config);
  const now = deps.now ? deps.now() : new Date();

  // --- c + d. Parse + fetch + send (with deadline) ----------------------
  const parsed = parseInput(msg.body ?? '', botRoutes);

  // The route a rail fetch is attributed to (null for a plain menu, which
  // performs no fetch). Recorded exactly once: success after send, fail on
  // any error — never both.
  let servedRouteKey: string | null = null;

  async function fetchAndSend(signal: AbortSignal): Promise<void> {
    let message: string;

    if (parsed.kind === 'route') {
      const configRoute = config.routes.find((r) => r.key === parsed.route.key);
      if (!configRoute) {
        // Should never happen if botRoutes and config.routes are in sync.
        message = outage();
      } else {
        servedRouteKey = configRoute.key;
        const count = configRoute.count ?? config.defaults.on_demand_count;
        const lines = await trainLinesFor(configRoute, count, deps, signal);
        message = lines.length > 0 ? routeReport(parsed.route, lines, now) : noTrains(parsed.route);
      }
    } else {
      // kind === 'menu'
      const windows: BotWindow[] = config.time_windows.map((w) => ({
        start: w.start,
        end: w.end,
        route_key: w.route_key,
      }));
      const eagerKey = resolveEager(now, windows);

      if (eagerKey !== null) {
        const eagerBotRoute = botRoutes.find((r) => r.key === eagerKey);
        const eagerConfigRoute = config.routes.find((r) => r.key === eagerKey);

        if (eagerBotRoute !== undefined && eagerConfigRoute !== undefined) {
          servedRouteKey = eagerConfigRoute.key;
          const count = eagerConfigRoute.count ?? config.defaults.on_demand_count;
          const lines = await trainLinesFor(eagerConfigRoute, count, deps, signal);
          const otherRoutes = botRoutes.filter((r) => r.key !== eagerKey);
          const greeting = greetingFor(now);
          message = eagerGreeting(eagerBotRoute, lines, otherRoutes, greeting, now);
        } else {
          message = menu(botRoutes);
        }
      } else {
        message = menu(botRoutes);
      }
    }

    await deps.send(botNumber, ownerUuid, message, signal);
    // Success is recorded only after the send actually completes.
    if (servedRouteKey !== null) {
      deps.counters.record(servedRouteKey, 'success');
    }
  }

  try {
    await withDeadline((signal) => fetchAndSend(signal), 25_000);
  } catch (err: unknown) {
    // Rail failure, deadline exceeded, or other error → send outage best-effort.
    logger.warn('handleMessage: pipeline error, sending outage', {
      error: err instanceof Error ? err.message : String(err),
    });

    // Record the failure once, for whichever route the fetch was serving.
    if (servedRouteKey !== null) {
      deps.counters.record(servedRouteKey, 'fail');
    }

    try {
      await deps.send(botNumber, ownerUuid, outage());
    } catch {
      // Best-effort: swallow and log silently.
      logger.warn('handleMessage: outage send also failed — dropping');
    }
  }
}
