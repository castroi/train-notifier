/**
 * app.ts — train-notifier entry point (plan Task 8 / §5.1, 5.2, 5.5, 5.6, 6A.6, 16.1).
 *
 * Responsibilities:
 *   1. Load and validate config.
 *   2. Build real runtime deps (fetchRoutes, send, DedupCache, Counters).
 *   3. Start the cron scheduler.
 *   4. Run the Signal receive loop (long-poll, on-demand pipeline per message).
 *   5. Touch heartbeat each loop cycle.
 *   6. Flush counters hourly.
 *   7. Graceful shutdown on SIGTERM / SIGINT.
 */

import { createConversationStore } from './bot/conversation.ts';
import { loadConfig } from './config/load.ts';
import { Counters } from './core/counters.ts';
import { DedupCache } from './core/dedup.ts';
import { RateLimiter } from './core/ratelimit.ts';
import { touch } from './health/heartbeat.ts';
import { handleMessage } from './pipeline.ts';
import { fetchRoutes } from './rail/client.ts';
import { startScheduler } from './scheduler/index.ts';
import { receiveStream, send } from './signal/client.ts';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const logger = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'info', msg, ...meta })),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: 'warn', msg, ...meta })),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: 'error', msg, ...meta })),
};

const config = loadConfig();
const SALT = process.env.LOG_SALT ?? '';

// Fail fast: an empty/short salt makes the sender HMAC effectively reversible,
// defeating the privacy guarantee that senders are stored only as a salted hash.
if (SALT.length < 16) {
  logger.error('LOG_SALT must be set to a random string of at least 16 characters');
  process.exit(1);
}

// Fail fast on bad endpoint URLs (A10 / defense-in-depth). RAIL_URL must be
// https; SIGNAL_API_URL may be http (private bridge) or https.
function fail(message: string): never {
  logger.error(message);
  process.exit(1);
}

function requireUrl(name: string, value: string | undefined, requireHttps: boolean): void {
  if (!value) fail(`${name} environment variable is not set`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} is not a valid URL`);
  }
  if (requireHttps && parsed.protocol !== 'https:') {
    fail(`${name} must use https://`);
  }
  if (!requireHttps && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(`${name} must use http:// or https://`);
  }
}

requireUrl('RAIL_URL', process.env.RAIL_URL, true);
requireUrl('SIGNAL_API_URL', process.env.SIGNAL_API_URL, false);

const dedup = new DedupCache();
const counters = new Counters();
const rateLimiter = new RateLimiter();
const conversation = createConversationStore();

const deps = {
  fetchRoutes,
  send,
  dedup,
  counters,
  rateLimiter,
  conversation,
};

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const schedulerTasks = startScheduler(config, {
  fetchRoutes,
  send,
  counters,
});

// ---------------------------------------------------------------------------
// Hourly counter flush
// ---------------------------------------------------------------------------

const flushInterval = setInterval(
  () => {
    const line = counters.flush();
    if (line) {
      logger.info(line);
    }
  },
  60 * 60 * 1_000,
);

// ---------------------------------------------------------------------------
// Startup log (no secrets — only bot_number is the bot identity, not secret)
// ---------------------------------------------------------------------------

logger.info('train-notifier starting', {
  botNumber: config.signal.bot_number,
  routes: config.routes.map((r) => r.key),
  schedules: config.schedules.map((s) => s.id),
});

// ---------------------------------------------------------------------------
// Receive stream (json-rpc WebSocket): on-demand pipeline per message
// ---------------------------------------------------------------------------

const stream = receiveStream(config.signal.bot_number, (msg) => {
  touch();
  // Fire-and-forget: handleMessage has its own dedup + ~25s deadline and never
  // throws out for normal failures, but guard the promise just in case.
  void handleMessage(msg, config, deps, SALT).catch((err: unknown) => {
    logger.warn('handleMessage error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
});

// ---------------------------------------------------------------------------
// Heartbeat (liveness for the Docker HEALTHCHECK)
//
// Only touch while the receive stream is actually connected. If the WebSocket
// dies permanently the heartbeat goes stale and the container is restarted,
// instead of reporting healthy while functionally deaf.
// ---------------------------------------------------------------------------

const heartbeatInterval = setInterval(() => {
  if (stream.connected) {
    touch();
  }
}, 30 * 1_000);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(): void {
  logger.info('train-notifier shutting down');
  stream.close();
  for (const task of schedulerTasks) {
    task.stop();
  }
  clearInterval(flushInterval);
  clearInterval(heartbeatInterval);
  // Give in-flight operations a moment to drain, then exit.
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
