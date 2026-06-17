import type { IdentityEntry, IncomingMessage, RawReceiveItem } from './types.js';

const logger = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'info', msg, ...meta })),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: 'warn', msg, ...meta })),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: 'error', msg, ...meta })),
};

/** Milliseconds to wait between retries (base; actual = base * attempt + jitter). */
const RETRY_BASE_MS = 500;
const RETRY_JITTER_MS = 300;

function retryDelay(attempt: number): number {
  return RETRY_BASE_MS * attempt + Math.floor(Math.random() * RETRY_JITTER_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the base URL from the environment, stripping any trailing slash.
 * Throws if SIGNAL_API_URL is not set.
 */
function baseUrl(): string {
  const url = process.env.SIGNAL_API_URL;
  if (!url) {
    throw new Error('SIGNAL_API_URL environment variable is not set');
  }
  return url.replace(/\/+$/, '');
}

/**
 * Encode a bot number for use as a URL path segment.
 * Phone numbers like +972501234567 must be percent-encoded so the + becomes %2B.
 */
function encodeBotNumber(botNumber: string): string {
  return encodeURIComponent(botNumber);
}

/**
 * Map a raw receive item to an IncomingMessage.
 * Returns null if the envelope has no usable text body (receipts, typing, etc.).
 */
function mapEnvelope(item: RawReceiveItem): IncomingMessage | null {
  const env = item?.envelope;
  if (!env || typeof env !== 'object') {
    return null;
  }

  const body = env.dataMessage?.message;
  // Skip envelopes that carry no text message (receipts, typing indicators, reactions).
  if (typeof body !== 'string' || body.length === 0) {
    return null;
  }

  const msg: IncomingMessage = { body };

  if (typeof env.sourceUuid === 'string') msg.sourceUuid = env.sourceUuid;
  if (typeof env.sourceDevice === 'number') msg.sourceDevice = env.sourceDevice;
  if (typeof env.timestamp === 'number') msg.timestamp = env.timestamp;
  if (typeof env.serverGuid === 'string') msg.serverGuid = env.serverGuid;

  return msg;
}

/**
 * Long-poll the Signal receive endpoint and return decoded messages.
 * Envelopes without a text body are silently skipped.
 *
 * @param botNumber  E.164 number registered with signal-cli-rest-api (e.g. "+972501234567")
 * @param timeoutSec HTTP long-poll timeout forwarded to the signal-cli server (default 10 s)
 */
export async function receive(botNumber: string, timeoutSec = 10): Promise<IncomingMessage[]> {
  const url = `${baseUrl()}/v1/receive/${encodeBotNumber(botNumber)}?timeout=${timeoutSec}`;

  // Add a bit of headroom on top of the server-side long-poll timeout.
  const fetchTimeoutMs = (timeoutSec + 5) * 1000;
  const signal = AbortSignal.timeout(fetchTimeoutMs);

  const res = await fetch(url, { signal });

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Signal receive failed: HTTP ${res.status}`);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new Error('Signal receive: response is not valid JSON');
  }

  if (!Array.isArray(raw)) {
    throw new Error('Signal receive: expected JSON array in response');
  }

  const messages: IncomingMessage[] = [];
  for (const item of raw as RawReceiveItem[]) {
    const msg = mapEnvelope(item);
    if (msg !== null) {
      messages.push(msg);
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// WebSocket receive (json-rpc mode)
//
// In MODE=json-rpc, /v1/receive/{number} is a WebSocket endpoint, not an HTTP
// GET. We hold one long-lived connection and stream messages as they arrive;
// signal-cli only delivers messages while a client is connected, so a
// reconnect-poll model would drop messages between cycles. We auto-reconnect
// with capped backoff instead.
// ---------------------------------------------------------------------------

/** Minimal structural type for the global WebSocket (avoids needing the DOM lib). */
interface WSLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}
type WSCtor = new (url: string) => WSLike;

const RECONNECT_MAX_MS = 30_000;
/** If the socket doesn't open within this long, treat it as failed and retry. */
const CONNECT_TIMEOUT_MS = 20_000;

export interface ReceiveStream {
  /** True only while the underlying WebSocket is open. */
  readonly connected: boolean;
  close(): void;
}

/**
 * Open a persistent WebSocket to the Signal receive endpoint and invoke
 * `onMessage` for each incoming text message. Auto-reconnects with capped
 * backoff. Returns a handle whose `close()` stops the stream permanently.
 *
 * @param botNumber  E.164 number registered with signal-cli-rest-api
 * @param onMessage  called for each decoded IncomingMessage (text bodies only)
 */
export function receiveStream(
  botNumber: string,
  onMessage: (msg: IncomingMessage) => void,
): ReceiveStream {
  const WS = (globalThis as { WebSocket?: WSCtor }).WebSocket;
  if (!WS) {
    throw new Error('Global WebSocket is unavailable (requires Node 22+)');
  }

  // http -> ws, https -> wss
  const wsUrl = `${baseUrl().replace(/^http/, 'ws')}/v1/receive/${encodeBotNumber(botNumber)}`;

  let closed = false;
  let connected = false;
  let ws: WSLike | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect(): void {
    if (closed) return;
    ws = new WS!(wsUrl);

    // Re-arm the connection exactly once. Triggered by error OR close (some
    // failure modes fire only one of them) and by the connect watchdog.
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout>;
    const scheduleReconnect = (): void => {
      if (closed || settled) return;
      settled = true;
      connected = false;
      clearTimeout(watchdog);
      attempt += 1;
      const delay = Math.min(retryDelay(attempt), RECONNECT_MAX_MS);
      logger.warn('signal receive stream closed — reconnecting', {
        attempt,
        delayMs: delay,
      });
      reconnectTimer = setTimeout(connect, delay);
    };
    // Guard against a socket that hangs in CONNECTING (signal-cli down/booting).
    watchdog = setTimeout(scheduleReconnect, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      attempt = 0;
      connected = true;
      clearTimeout(watchdog);
      logger.info('signal receive stream connected');
    };

    ws.onmessage = (ev) => {
      let parsed: unknown;
      try {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
        parsed = JSON.parse(data);
      } catch {
        return; // ignore non-JSON frames
      }
      const msg = mapEnvelope(parsed as RawReceiveItem);
      if (msg !== null) {
        try {
          onMessage(msg);
        } catch (err) {
          logger.error('signal receive onMessage handler threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    // Either event may fire (or both) on failure; scheduleReconnect dedupes.
    ws.onerror = () => scheduleReconnect();
    ws.onclose = () => scheduleReconnect();
  }

  connect();

  return {
    get connected() {
      return connected;
    },
    close() {
      closed = true;
      connected = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Send a text message via Signal.
 * Retries up to 2 times with exponential backoff + jitter.
 * Throws on final failure.
 *
 * @param botNumber   E.164 sender number (the registered bot)
 * @param recipient   Recipient ACI UUID or E.164 number
 * @param message     Plaintext message body
 */
export async function send(
  botNumber: string,
  recipient: string,
  message: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const url = `${baseUrl()}/v2/send`;
  const body = JSON.stringify({
    message,
    number: botNumber,
    recipients: [recipient],
  });

  const MAX_ATTEMPTS = 3; // initial + 2 retries

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const timeoutSignal = AbortSignal.timeout(15_000);
    // Combine the per-attempt timeout with any caller deadline signal.
    const signal = abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal,
      });
    } catch (err) {
      const isLast = attempt === MAX_ATTEMPTS;
      logger.warn('Signal send fetch error', {
        attempt,
        error: err instanceof Error ? err.message : String(err),
        willRetry: !isLast,
      });
      if (isLast) {
        throw new Error(
          `Signal send failed after ${MAX_ATTEMPTS} attempts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await sleep(retryDelay(attempt));
      continue;
    }

    // Treat any 2xx as success (spec says 201, but be tolerant).
    if (res.ok) {
      return;
    }

    await res.body?.cancel().catch(() => {});
    const isLast = attempt === MAX_ATTEMPTS;

    logger.warn('Signal send HTTP error', {
      attempt,
      status: res.status,
      willRetry: !isLast,
    });

    if (isLast) {
      throw new Error(`Signal send failed after ${MAX_ATTEMPTS} attempts: HTTP ${res.status}`);
    }

    await sleep(retryDelay(attempt));
  }
}

/**
 * Check whether the signal-cli-rest-api service is reachable and healthy.
 * The health endpoint returns 204 (no body); any 2xx is treated as healthy.
 *
 * @param botNumber  Bot number (not actually used in the URL but kept for API symmetry)
 */
export async function health(_botNumber: string): Promise<boolean> {
  try {
    const url = `${baseUrl()}/v1/health`;
    const signal = AbortSignal.timeout(5_000);
    const res = await fetch(url, { signal });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch the list of known identities for the given bot number.
 * Useful for the one-time lookup of the owner's UUID after first registration.
 *
 * @param botNumber  E.164 number registered with signal-cli-rest-api
 */
export async function identities(botNumber: string): Promise<Array<IdentityEntry>> {
  const url = `${baseUrl()}/v1/identities/${encodeBotNumber(botNumber)}`;
  const signal = AbortSignal.timeout(10_000);

  const res = await fetch(url, { signal });

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Signal identities failed: HTTP ${res.status}`);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new Error('Signal identities: response is not valid JSON');
  }

  if (!Array.isArray(raw)) {
    throw new Error('Signal identities: expected JSON array in response');
  }

  return (raw as IdentityEntry[]).map((entry) => ({
    number: typeof entry.number === 'string' ? entry.number : '',
    uuid: typeof entry.uuid === 'string' ? entry.uuid : undefined,
  }));
}
