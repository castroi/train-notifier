import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

// ---------------------------------------------------------------------------
// Fetch stub infrastructure
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;
let originalFetch: FetchFn;

/**
 * Build a minimal Response-compatible object that satisfies the parts of the
 * fetch API that client.ts actually uses.
 */
function makeFakeResponse(
  status: number,
  body: unknown,
  contentType = 'application/json',
): Response {
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    json: async () => JSON.parse(bodyText),
    text: async () => bodyText,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------

const BOT_NUMBER = '+972501234567';
const ENCODED_BOT = encodeURIComponent(BOT_NUMBER); // %2B972501234567
const API_BASE = 'http://signal-api:8080';

before(() => {
  process.env.SIGNAL_API_URL = API_BASE;
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SIGNAL_API_URL;
});

// Restore after each test so stubs don't leak.
beforeEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Import the module AFTER env is set so baseUrl() picks up the variable.
// Node's module cache means a dynamic import gives us the same module object
// across tests — that is intentional here.
// ---------------------------------------------------------------------------

const clientModule = await import('./client.ts');
const { receive, send, health, identities, receiveStream } = clientModule;

// ---------------------------------------------------------------------------
// receive() tests
// ---------------------------------------------------------------------------

describe('receive()', () => {
  it('parses a sample envelope array and extracts body + sourceUuid', async () => {
    const samplePayload = [
      {
        envelope: {
          sourceUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          sourceNumber: '+972501111111',
          sourceDevice: 1,
          timestamp: 1718000000000,
          serverGuid: 'server-guid-xyz',
          dataMessage: {
            message: 'Hello bot',
          },
        },
        account: BOT_NUMBER,
      },
    ];

    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input.toString();
      assert.ok(url.includes(`/v1/receive/${ENCODED_BOT}`), `Expected receive URL, got: ${url}`);
      assert.ok(url.includes('timeout=10'), 'Expected default timeout=10');
      return makeFakeResponse(200, samplePayload);
    };

    const messages = await receive(BOT_NUMBER);

    assert.equal(messages.length, 1);
    const msg = messages[0]!;
    assert.equal(msg.body, 'Hello bot');
    assert.equal(msg.sourceUuid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(msg.sourceDevice, 1);
    assert.equal(msg.timestamp, 1718000000000);
    assert.equal(msg.serverGuid, 'server-guid-xyz');
  });

  it('skips an envelope with no dataMessage', async () => {
    const payloadWithReceiptOnly = [
      {
        // Receipt envelope — no dataMessage at all
        envelope: {
          sourceUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          timestamp: 1718000001000,
          receiptMessage: { isDelivery: true, timestamps: [1718000000000] },
        },
        account: BOT_NUMBER,
      },
    ];

    globalThis.fetch = async () => makeFakeResponse(200, payloadWithReceiptOnly);

    const messages = await receive(BOT_NUMBER);
    assert.equal(messages.length, 0, 'Receipt envelope must be skipped');
  });

  it('skips an envelope where dataMessage exists but message is absent', async () => {
    const payloadReaction = [
      {
        envelope: {
          sourceUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          timestamp: 1718000002000,
          dataMessage: {
            // no "message" key — e.g. a reaction
            reaction: { emoji: '👍', targetAuthorUuid: 'xyz', targetSentTimestamp: 1 },
          },
        },
        account: BOT_NUMBER,
      },
    ];

    globalThis.fetch = async () => makeFakeResponse(200, payloadReaction);

    const messages = await receive(BOT_NUMBER);
    assert.equal(messages.length, 0, 'Reaction envelope must be skipped');
  });

  it('handles empty array (idle poll)', async () => {
    globalThis.fetch = async () => makeFakeResponse(200, []);
    const messages = await receive(BOT_NUMBER);
    assert.equal(messages.length, 0);
  });

  it('returns multiple messages from one poll', async () => {
    const payload = [
      {
        envelope: {
          sourceUuid: 'uuid-1',
          timestamp: 1718000010000,
          dataMessage: { message: 'First' },
        },
      },
      {
        // receipt — must be skipped
        envelope: {
          sourceUuid: 'uuid-2',
          timestamp: 1718000011000,
          receiptMessage: {},
        },
      },
      {
        envelope: {
          sourceUuid: 'uuid-3',
          timestamp: 1718000012000,
          dataMessage: { message: 'Second' },
        },
      },
    ];

    globalThis.fetch = async () => makeFakeResponse(200, payload);

    const messages = await receive(BOT_NUMBER);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.body, 'First');
    assert.equal(messages[1]!.body, 'Second');
  });

  it('tolerates missing optional fields (no sourceUuid, no serverGuid)', async () => {
    const payload = [
      {
        envelope: {
          // sourceUuid intentionally absent
          timestamp: 1718000020000,
          dataMessage: { message: 'Anonymous message' },
        },
      },
    ];

    globalThis.fetch = async () => makeFakeResponse(200, payload);

    const messages = await receive(BOT_NUMBER);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.body, 'Anonymous message');
    assert.equal(messages[0]!.sourceUuid, undefined);
    assert.equal(messages[0]!.serverGuid, undefined);
  });

  it('uses a custom timeout parameter in the query string', async () => {
    let capturedUrl = '';
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return makeFakeResponse(200, []);
    };

    await receive(BOT_NUMBER, 30);
    assert.ok(capturedUrl.includes('timeout=30'), `URL was: ${capturedUrl}`);
  });

  it('throws on non-2xx HTTP status', async () => {
    globalThis.fetch = async () => makeFakeResponse(500, 'Internal Server Error', 'text/plain');
    await assert.rejects(() => receive(BOT_NUMBER), /HTTP 500/);
  });
});

// ---------------------------------------------------------------------------
// send() tests
// ---------------------------------------------------------------------------

describe('send()', () => {
  const RECIPIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  beforeEach(() => {
    delete process.env.SIGNAL_TOKEN; // isolate token state; don't depend on test order
  });

  it('succeeds on 201 and calls /v2/send with correct payload', async () => {
    let capturedUrl = '';
    let capturedBody: unknown;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedBody = JSON.parse(init?.body as string);
      return makeFakeResponse(201, { timestamp: '1718000000000' });
    };

    await send(BOT_NUMBER, RECIPIENT, 'Test message');

    assert.equal(capturedUrl, `${API_BASE}/v2/send`);
    assert.deepEqual(capturedBody, {
      message: 'Test message',
      number: BOT_NUMBER,
      recipients: [RECIPIENT],
    });
  });

  it('attaches the wrapper bearer token when SIGNAL_TOKEN is set', async () => {
    process.env.SIGNAL_TOKEN = 'wrapper-token-abc';
    let authHeader: string | undefined;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      authHeader = (init?.headers as Record<string, string>).Authorization;
      return makeFakeResponse(201, { timestamp: '1' });
    };
    try {
      await send(BOT_NUMBER, RECIPIENT, 'with auth');
      assert.equal(authHeader, 'Bearer wrapper-token-abc');
    } finally {
      delete process.env.SIGNAL_TOKEN;
    }
  });

  it('omits Authorization when SIGNAL_TOKEN is unset', async () => {
    let hasAuth = true;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      hasAuth = 'Authorization' in (init?.headers as Record<string, string>);
      return makeFakeResponse(201, { timestamp: '1' });
    };
    await send(BOT_NUMBER, RECIPIENT, 'no auth');
    assert.equal(hasAuth, false);
  });

  it('treats any 2xx (e.g. 200) as success', async () => {
    globalThis.fetch = async () => makeFakeResponse(200, { timestamp: '1' });
    await assert.doesNotReject(() => send(BOT_NUMBER, RECIPIENT, 'hi'));
  });

  it('throws after repeated 500 responses (exhausts all retries)', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return makeFakeResponse(500, 'Service Unavailable');
    };

    await assert.rejects(
      () => send(BOT_NUMBER, RECIPIENT, 'Will fail'),
      /Signal send failed after 3 attempts/,
    );

    // Should have tried exactly 3 times (initial + 2 retries).
    assert.equal(callCount, 3, `Expected 3 fetch calls, got ${callCount}`);
  });

  it('retries on network error and then throws', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      throw new Error('ECONNREFUSED');
    };

    await assert.rejects(
      () => send(BOT_NUMBER, RECIPIENT, 'Network gone'),
      /Signal send failed after 3 attempts/,
    );

    assert.equal(callCount, 3);
  });

  it('succeeds on second attempt after one 500', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) return makeFakeResponse(500, 'temporary error');
      return makeFakeResponse(201, { timestamp: '1' });
    };

    await assert.doesNotReject(() => send(BOT_NUMBER, RECIPIENT, 'retry me'));
    assert.equal(callCount, 2);
  });
});

// ---------------------------------------------------------------------------
// health() tests
// ---------------------------------------------------------------------------

describe('health()', () => {
  it('returns true for 204', async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      assert.ok(input.toString().endsWith('/v1/health'));
      return makeFakeResponse(204, '');
    };
    const result = await health(BOT_NUMBER);
    assert.equal(result, true);
  });

  it('returns true for any 2xx (e.g. 200)', async () => {
    globalThis.fetch = async () => makeFakeResponse(200, 'OK');
    assert.equal(await health(BOT_NUMBER), true);
  });

  it('returns false for 5xx', async () => {
    globalThis.fetch = async () => makeFakeResponse(503, 'Service Unavailable');
    assert.equal(await health(BOT_NUMBER), false);
  });

  it('returns false when fetch throws (network error)', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    assert.equal(await health(BOT_NUMBER), false);
  });
});

// ---------------------------------------------------------------------------
// identities() tests
// ---------------------------------------------------------------------------

describe('identities()', () => {
  it('returns parsed identity entries', async () => {
    const payload = [
      { number: '+972501111111', uuid: 'uuid-owner-1', trustLevel: 'TRUSTED_VERIFIED' },
      { number: '', uuid: 'uuid-owner-2' },
    ];

    globalThis.fetch = async (input: RequestInfo | URL) => {
      assert.ok(
        input.toString().includes(`/v1/identities/${ENCODED_BOT}`),
        `URL missing encoded bot number: ${input}`,
      );
      return makeFakeResponse(200, payload);
    };

    const result = await identities(BOT_NUMBER);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.number, '+972501111111');
    assert.equal(result[0]!.uuid, 'uuid-owner-1');
    assert.equal(result[1]!.number, '');
    assert.equal(result[1]!.uuid, 'uuid-owner-2');
  });

  it('throws on non-2xx response', async () => {
    globalThis.fetch = async () => makeFakeResponse(404, 'Not found');
    await assert.rejects(() => identities(BOT_NUMBER), /HTTP 404/);
  });
});

// ---------------------------------------------------------------------------
// receiveStream() tests — stub the global WebSocket
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  static count = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  url: string;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
    FakeWebSocket.count += 1;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  close() {
    this.closed = true;
  }
}

describe('receiveStream()', () => {
  let originalWS: unknown;
  before(() => {
    originalWS = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    delete process.env.SIGNAL_TOKEN; // deterministic URL unless a test sets it
  });
  after(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWS;
    delete process.env.SIGNAL_TOKEN;
  });

  it('passes the wrapper token as a ?token= query when SIGNAL_TOKEN is set', () => {
    process.env.SIGNAL_TOKEN = 'wrapper-token-xyz';
    try {
      const stream = receiveStream(BOT_NUMBER, () => {});
      assert.equal(
        FakeWebSocket.last!.url,
        `ws://signal-api:8080/v1/receive/${ENCODED_BOT}?token=wrapper-token-xyz`,
      );
      stream.close();
    } finally {
      delete process.env.SIGNAL_TOKEN;
    }
  });

  it('connects to the ws:// receive URL and decodes text messages', () => {
    const received: Array<{ body?: string; sourceUuid?: string }> = [];
    const stream = receiveStream(BOT_NUMBER, (m) => received.push(m));

    const ws = FakeWebSocket.last!;
    assert.equal(ws.url, `ws://signal-api:8080/v1/receive/${ENCODED_BOT}`);

    ws.emit({
      envelope: {
        sourceUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        sourceDevice: 1,
        timestamp: 123,
        dataMessage: { message: 'work' },
      },
    });

    assert.equal(received.length, 1);
    assert.equal(received[0]!.body, 'work');
    assert.equal(received[0]!.sourceUuid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    stream.close();
  });

  it('skips frames with no text body (receipts/typing)', () => {
    const received: unknown[] = [];
    const stream = receiveStream(BOT_NUMBER, (m) => received.push(m));
    const ws = FakeWebSocket.last!;
    ws.emit({ envelope: { sourceUuid: 'x', receiptMessage: { type: 'READ' } } });
    ws.emit('not json');
    assert.equal(received.length, 0);
    stream.close();
  });

  it('close() marks the socket closed', () => {
    const stream = receiveStream(BOT_NUMBER, () => {});
    const ws = FakeWebSocket.last!;
    stream.close();
    assert.equal(ws.closed, true);
  });

  it('tracks connected state across open/close', () => {
    const stream = receiveStream(BOT_NUMBER, () => {});
    const ws = FakeWebSocket.last!;
    assert.equal(stream.connected, false); // not open yet
    ws.onopen?.();
    assert.equal(stream.connected, true);
    ws.onclose?.();
    assert.equal(stream.connected, false);
    stream.close();
  });

  it('reconnects after a drop (creates a new socket)', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      FakeWebSocket.count = 0;
      const stream = receiveStream(BOT_NUMBER, () => {});
      const ws1 = FakeWebSocket.last!;
      assert.equal(FakeWebSocket.count, 1);
      ws1.onclose?.(); // socket dropped
      mock.timers.tick(1000); // past the backoff
      assert.equal(FakeWebSocket.count, 2, 'a new socket was created');
      assert.notEqual(FakeWebSocket.last, ws1);
      stream.close();
    } finally {
      mock.timers.reset();
    }
  });

  it('reconnects only once when both error and close fire', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      FakeWebSocket.count = 0;
      const stream = receiveStream(BOT_NUMBER, () => {});
      const ws1 = FakeWebSocket.last!;
      ws1.onerror?.({}); // failure fires error...
      ws1.onclose?.(); // ...and close
      mock.timers.tick(1000);
      assert.equal(FakeWebSocket.count, 2, 'exactly one reconnect, not two');
      stream.close();
    } finally {
      mock.timers.reset();
    }
  });
});
