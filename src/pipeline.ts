/**
 * On-demand message pipeline (plan §16.1 / Task 8).
 *
 * Exports:
 *   toBotRoutes(config)        — convert config routes to BotRoute[]
 *   trainLinesFor(route, count, deps) — fetch + format train lines
 *   handleMessage(msg, config, deps)  — full on-demand pipeline
 */

import type { ConversationStore } from './bot/conversation.ts';
import { resolveDate, resolveTime } from './bot/datetime.ts';
import { normalize } from './bot/normalize.ts';
import { parseInput, resolveEager } from './bot/parse.ts';
import {
  customNoTrains,
  eagerGreeting,
  menu,
  noTrains,
  outage,
  routeReport,
  wizardNoRoute,
  wizardReport,
  wizardRollover,
} from './bot/templates.ts';
import type { BotRoute, BotWindow } from './bot/types.ts';
import type { Config, Route } from './config/types.ts';
import { hashSender, isAllowed, logUnknownSender } from './core/allowlist.ts';
import type { Counters } from './core/counters.ts';
import type { DedupCache } from './core/dedup.ts';
import { dedupKey } from './core/dedup.ts';
import type { RateLimiter } from './core/ratelimit.ts';
import { extractTrains, formatTrainLine } from './rail/format.ts';
import type { RailApiGetRoutesResult } from './rail/types.ts';
import {
  beginRoute,
  continueRoute,
  enterCustomMode,
  hasRouteSeparator,
  type RouteOutcome,
} from './route.ts';
import type { IncomingMessage } from './signal/types.ts';

/** Custom on-demand routes always return 5 upcoming trains (spec §1). */
const CUSTOM_ROUTE_COUNT = 5;

/** Keywords that enter custom-route mode when no flow is pending (spec §7: "0"). */
const CUSTOM_ENTRY = new Set(['0', 'other']);

/** Counter key for custom (non-config) routes. */
const CUSTOM_KEY = 'custom';

/** Max inbound body length fed to the matcher (defense-in-depth against DoS). */
const MAX_BODY_LEN = 200;

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
  /**
   * Optional conversation store enabling the custom-route flow. When omitted,
   * only the core home/work numbered menu is served (custom routes disabled).
   */
  conversation?: ConversationStore;
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
): Promise<{ lines: string[]; firstDayNote: string }> {
  const now = deps.now ? deps.now() : new Date();
  const result = await deps.fetchRoutes(route.from_id, route.to_id, now, signal);
  const trains = extractTrains(result, count, now.getTime());
  return { lines: trains.map(formatTrainLine), firstDayNote: trains[0]?.dayNote ?? '' };
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

  // --- c0. Custom-route flow (only when a conversation store is wired) ----
  // Resolves a route to (fromId, toId), then fetches CUSTOM_ROUTE_COUNT trains.
  // Cap the body before matching: station queries are a few dozen chars at most,
  // and the matcher runs Levenshtein × all stations synchronously on the event
  // loop, so an oversized message must not be allowed to stall the Pi.
  let coreBody = (msg.body ?? '').slice(0, MAX_BODY_LEN);
  if (deps.conversation) {
    const store = deps.conversation;
    const sender = msg.sourceUuid ?? '';

    const dispatchCustom = async (outcome: RouteOutcome): Promise<void> => {
      if (outcome.kind === 'reply') {
        // Same deadline/abort discipline as the resolved/core paths so a hung
        // Signal bridge cannot wedge the handler on a plain reply.
        await withDeadline(
          (signal) => deps.send(botNumber, ownerUuid, outcome.text, signal),
          25_000,
        );
        return;
      }
      // 'breakout' is handled by the caller and never dispatched here.
      if (outcome.kind !== 'results') return;
      // outcome.kind === 'results' — fetch at the wizard's resolved datetime,
      // echo the absolute datetime header, and roll over if the requested day
      // has no remaining service (§8.2/§8.4).
      try {
        await withDeadline(async (signal) => {
          const result = await deps.fetchRoutes(outcome.fromId, outcome.toId, outcome.when, signal);
          // Filter relative to the requested instant so "no trains left today"
          // surfaces as a next-day (dayNote) rollover.
          const trains = extractTrains(result, CUSTOM_ROUTE_COUNT, outcome.when.getTime());
          const lines = trains.map(formatTrainLine);
          let message: string;
          if (lines.length === 0) {
            message = customNoTrains(outcome.label);
          } else if (trains[0].dayNote !== '' && Number.isFinite(trains[0].departEpoch)) {
            // Nothing left on the requested day → show the next service day.
            message = wizardRollover(
              outcome.label,
              lines,
              new Date(trains[0].departEpoch),
              now,
              outcome.when,
            );
          } else {
            message = wizardReport(outcome.label, lines, outcome.when, now, !outcome.isNow);
          }
          await deps.send(botNumber, ownerUuid, message, signal);
          deps.counters.record(CUSTOM_KEY, 'success');
        }, 25_000);
      } catch (err: unknown) {
        deps.counters.record(CUSTOM_KEY, 'fail');
        logger.warn('handleMessage: custom-route error, sending outage', {
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          await deps.send(botNumber, ownerUuid, outage());
        } catch {
          logger.warn('handleMessage: outage send also failed — dropping');
        }
      }
    };

    const flow = store.get(sender);
    if (flow) {
      const outcome = continueRoute(coreBody, sender, flow, store, now);
      if (outcome.kind === 'breakout') {
        // Reserved/control word during a flow → fall through to the core path.
        coreBody = outcome.text;
      } else {
        await dispatchCustom(outcome);
        return;
      }
    } else if (CUSTOM_ENTRY.has(normalize(coreBody).trim())) {
      await dispatchCustom(enterCustomMode(sender, store));
      return;
    } else if (hasRouteSeparator(coreBody)) {
      await dispatchCustom(beginRoute(coreBody, sender, store));
      return;
    }
  }

  // --- c + d. Parse + fetch + send (with deadline) ----------------------
  const parsed = parseInput(coreBody, botRoutes);

  // No active wizard, but a bare date/time arrived (e.g. the wizard's TTL
  // lapsed): the user is answering a question we no longer remember. Nudge them
  // to send a route instead of dumping the menu — but only when it didn't match
  // a configured route/alias (those are handled by parseInput above) (§7.2).
  if (
    deps.conversation &&
    parsed.kind === 'menu' &&
    (resolveDate(coreBody, now) !== null || resolveTime(coreBody) !== null)
  ) {
    await withDeadline(
      (signal) => deps.send(botNumber, ownerUuid, wizardNoRoute(), signal),
      25_000,
    );
    return;
  }

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
        const { lines, firstDayNote } = await trainLinesFor(configRoute, count, deps, signal);
        message =
          lines.length > 0
            ? routeReport(parsed.route, lines, now, firstDayNote)
            : noTrains(parsed.route);
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
          const { lines, firstDayNote } = await trainLinesFor(
            eagerConfigRoute,
            count,
            deps,
            signal,
          );
          const otherRoutes = botRoutes.filter((r) => r.key !== eagerKey);
          const greeting = greetingFor(now);
          message = eagerGreeting(eagerBotRoute, lines, otherRoutes, greeting, now, firstDayNote);
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
