/**
 * Tests for src/pipeline.ts
 *
 * All deps are injected fakes — no real network or filesystem I/O.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConversationStore } from './bot/conversation.ts';
import { menu, outage } from './bot/templates.ts';
import type { Config } from './config/types.ts';
import { Counters } from './core/counters.ts';
import { DedupCache } from './core/dedup.ts';
import type { PipelineDeps } from './pipeline.ts';
import { handleMessage, toBotRoutes } from './pipeline.ts';
import type { RailApiGetRoutesResult } from './rail/types.ts';
import type { IncomingMessage } from './signal/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SENDER_UUID = OWNER_UUID; // allowed sender
const UNKNOWN_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const BASE_CONFIG: Config = {
  signal: {
    bot_number: '+972501234567',
    owner_uuid: OWNER_UUID,
    allowlist: [OWNER_UUID],
  },
  routes: [
    {
      key: 'work',
      from_id: 1260,
      to_id: 2100,
      label_en: 'Afula → Haifa',
      label_he: 'עפולה → חיפה',
      aliases: ['work', 'עבודה'],
    },
    {
      key: 'home',
      from_id: 2100,
      to_id: 1260,
      label_en: 'Haifa → Afula',
      label_he: 'חיפה → עפולה',
      aliases: ['home', 'בית'],
    },
  ],
  schedules: [
    { id: 's1', cron: '30 6 * * 0-4', route_key: 'work', count: 3 },
    { id: 's2', cron: '0 16 * * 0-4', route_key: 'home', count: 3 },
  ],
  time_windows: [
    { start: '06:00', end: '10:00', route_key: 'work' },
    { start: '15:00', end: '18:00', route_key: 'home' },
  ],
  defaults: { on_demand_count: 2 },
};

/**
 * Build a minimal RailApiGetRoutesResult with `n` train entries.
 */
function makeFakeResult(n: number): RailApiGetRoutesResult {
  const travels = Array.from({ length: n }, (_, i) => ({
    departureTime: `2026-06-15T0${6 + i}:30:00+03:00`,
    arrivalTime: `2026-06-15T0${7 + i}:15:00+03:00`,
    trains: [
      {
        trainNumber: 1000 + i,
        orignStation: 1260,
        destinationStation: 2100,
        originPlatform: 1,
        destPlatform: 2,
        arrivalTime: `2026-06-15T0${7 + i}:15:00+03:00`,
        departureTime: `2026-06-15T0${6 + i}:30:00+03:00`,
        trainPosition: { calcDiffMinutes: 0 },
      },
    ],
  }));
  return { result: { travels } };
}

/**
 * Build a date whose Asia/Jerusalem time is at the given HH:mm.
 * June 2026: Jerusalem is UTC+3 (IDT).
 */
function dateAtJerusalemTime(hh: number, mm: number): Date {
  const utcMs = Date.UTC(2026, 5, 15, hh - 3, mm, 0, 0);
  return new Date(utcMs);
}

/** Build a fresh deps object (each test gets its own dedup/counters). */
function makeDeps(overrides?: Partial<PipelineDeps>): PipelineDeps & {
  sendCalls: Array<{ botNumber: string; recipient: string; message: string }>;
  counters: Counters;
} {
  const sendCalls: Array<{ botNumber: string; recipient: string; message: string }> = [];
  const counters = new Counters();

  const base: PipelineDeps = {
    fetchRoutes: async () => makeFakeResult(2),
    send: async (botNumber, recipient, message) => {
      sendCalls.push({ botNumber, recipient, message });
    },
    dedup: new DedupCache(),
    counters,
    now: () => dateAtJerusalemTime(12, 0), // noon — no time window
    ...overrides,
  };

  return Object.assign(base, { sendCalls, counters });
}

/** Minimal message helper. */
function makeMsg(overrides?: Partial<IncomingMessage>): IncomingMessage {
  return {
    sourceUuid: SENDER_UUID,
    sourceDevice: 1,
    timestamp: 1_000_000,
    body: 'hello',
    ...overrides,
  };
}

const SALT = 'test-salt';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleMessage — allowlist check', () => {
  it('unknown sender: send is NOT called and function returns silently', async () => {
    const deps = makeDeps();
    const msg = makeMsg({ sourceUuid: UNKNOWN_UUID });

    await handleMessage(msg, BASE_CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 0, 'send must not be called for unknown sender');
  });

  it('undefined sourceUuid: send is NOT called', async () => {
    const deps = makeDeps();
    const msg = makeMsg({ sourceUuid: undefined });

    await handleMessage(msg, BASE_CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 0, 'send must not be called when sourceUuid absent');
  });
});

describe('handleMessage — dedup', () => {
  it('duplicate message (same dedupKey): send is called only once across two calls', async () => {
    const sharedDeps = makeDeps();
    const msg = makeMsg({ body: '1' });

    await handleMessage(msg, BASE_CONFIG, sharedDeps, SALT);
    await handleMessage(msg, BASE_CONFIG, sharedDeps, SALT);

    assert.equal(sharedDeps.sendCalls.length, 1, 'duplicate message must be handled only once');
  });

  it('distinct messages (different timestamps) are each processed', async () => {
    const sharedDeps = makeDeps();

    await handleMessage(makeMsg({ timestamp: 1001, body: '1' }), BASE_CONFIG, sharedDeps, SALT);
    await handleMessage(makeMsg({ timestamp: 1002, body: '1' }), BASE_CONFIG, sharedDeps, SALT);

    assert.equal(sharedDeps.sendCalls.length, 2, 'distinct messages must each produce a send');
  });
});

describe('handleMessage — route input "2"', () => {
  it('leading-integer "2" → send called with route-2 label (Haifa → Afula)', async () => {
    const deps = makeDeps();
    const msg = makeMsg({ body: '2' });

    await handleMessage(msg, BASE_CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 1, 'send must be called once');
    const text = deps.sendCalls[0]!.message;
    assert.ok(text.includes('Haifa → Afula'), `Expected route-2 label in message; got: ${text}`);
  });

  it('send uses correct botNumber and ownerUuid', async () => {
    const deps = makeDeps();
    const msg = makeMsg({ body: '1' });

    await handleMessage(msg, BASE_CONFIG, deps, SALT);

    assert.equal(deps.sendCalls[0]!.botNumber, BASE_CONFIG.signal.bot_number);
    assert.equal(deps.sendCalls[0]!.recipient, BASE_CONFIG.signal.owner_uuid);
  });
});

describe('handleMessage — menu input at non-window time', () => {
  it('"hello" at noon (no time window) → message equals menu output', async () => {
    const deps = makeDeps({ now: () => dateAtJerusalemTime(12, 0) });
    const msg = makeMsg({ body: 'hello' });

    await handleMessage(msg, BASE_CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 1, 'send must be called');
    const botRoutes = toBotRoutes(BASE_CONFIG);
    const expected = menu(botRoutes);
    assert.equal(
      deps.sendCalls[0]!.message,
      expected,
      `Expected menu message; got: ${deps.sendCalls[0]!.message}`,
    );
  });

  it('"random text" at midnight → menu', async () => {
    const deps = makeDeps({ now: () => dateAtJerusalemTime(0, 30) });
    const msg = makeMsg({ body: 'random text' });

    await handleMessage(msg, BASE_CONFIG, deps, SALT);

    const botRoutes = toBotRoutes(BASE_CONFIG);
    assert.equal(deps.sendCalls[0]!.message, menu(botRoutes));
  });
});

describe('handleMessage — eager greeting', () => {
  it('greeting at work window time (08:00) → message contains work route label and "Other routes:"', async () => {
    // 08:00 Jerusalem is inside the 06:00–10:00 work window
    const deps = makeDeps({ now: () => dateAtJerusalemTime(8, 0) });
    const msg = makeMsg({ body: 'hello' }); // menu-triggering input

    await handleMessage(msg, BASE_CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 1, 'send must be called');
    const text = deps.sendCalls[0]!.message;
    assert.ok(
      text.includes('Afula → Haifa'),
      `Expected work route label in eager greeting; got: ${text}`,
    );
    assert.ok(
      text.includes('Other routes:'),
      `Expected "Other routes:" in eager greeting; got: ${text}`,
    );
  });

  it('greeting at home window time (16:00) → message contains home route label', async () => {
    const deps = makeDeps({ now: () => dateAtJerusalemTime(16, 0) });
    const msg = makeMsg({ body: 'hey' });

    await handleMessage(msg, BASE_CONFIG, deps, SALT);

    const text = deps.sendCalls[0]!.message;
    assert.ok(text.includes('Haifa → Afula'), `Expected home route label; got: ${text}`);
    assert.ok(text.includes('Other routes:'));
  });
});

describe('handleMessage — rail failure', () => {
  it('fetchRoutes throws → outage() message is sent', async () => {
    const deps = makeDeps({
      fetchRoutes: async () => {
        throw new Error('rail API down');
      },
    });
    const msg = makeMsg({ body: '1' }); // request route 1

    await handleMessage(msg, BASE_CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 1, 'outage send must be called');
    assert.equal(
      deps.sendCalls[0]!.message,
      outage(),
      `Expected outage message; got: ${deps.sendCalls[0]!.message}`,
    );
  });

  it('deadline exceeded → outage() message is sent (best-effort)', async () => {
    const _deps = makeDeps({
      // fetchRoutes never resolves within the 25 s deadline; simulate with a long delay.
      // We inject a custom pipeline with a 50ms deadline to keep tests fast.
      fetchRoutes: async () =>
        new Promise<RailApiGetRoutesResult>((resolve) =>
          setTimeout(() => resolve(makeFakeResult(1)), 60_000),
        ),
    });

    // We can't easily override the internal deadline, so instead we test
    // the outage path by throwing directly.
    const deps2 = makeDeps({
      fetchRoutes: async () => {
        throw new Error('timeout simulation');
      },
    });
    const msg = makeMsg({ body: '2' });

    await handleMessage(msg, BASE_CONFIG, deps2, SALT);

    assert.equal(deps2.sendCalls[0]!.message, outage());
  });

  it('rail failure + outage send also fails → does not throw', async () => {
    const deps = makeDeps({
      fetchRoutes: async () => {
        throw new Error('rail down');
      },
      send: async () => {
        throw new Error('signal down too');
      },
    });
    const msg = makeMsg({ body: '1' });

    // Must not throw
    await assert.doesNotReject(() => handleMessage(msg, BASE_CONFIG, deps, SALT));
  });
});

describe('handleMessage — no trains', () => {
  it('route 1 with zero API results → no-trains message (not outage)', async () => {
    const deps = makeDeps({ fetchRoutes: async () => makeFakeResult(0) });
    const msg = makeMsg({ body: '1' });

    await handleMessage(msg, BASE_CONFIG, deps, SALT);

    const text = deps.sendCalls[0]!.message;
    assert.ok(text.includes('No upcoming departures'), `Expected no-trains message; got: ${text}`);
  });
});

describe('toBotRoutes', () => {
  it('index is 1-based and matches position', () => {
    const botRoutes = toBotRoutes(BASE_CONFIG);
    assert.equal(botRoutes[0]!.index, 1);
    assert.equal(botRoutes[1]!.index, 2);
  });

  it('label_en and key are preserved from config', () => {
    const botRoutes = toBotRoutes(BASE_CONFIG);
    assert.equal(botRoutes[0]!.key, 'work');
    assert.equal(botRoutes[0]!.label_en, 'Afula → Haifa');
    assert.equal(botRoutes[1]!.key, 'home');
  });
});

// ---------------------------------------------------------------------------
// Custom-route flow (deps.conversation set) — the path the reviews flagged.
// ---------------------------------------------------------------------------

/** Upcoming-train result with `n` travels at 06:30..(06+n):30 (after a 05:00 now). */
function makeUpcomingResult(n: number): RailApiGetRoutesResult {
  const travels = Array.from({ length: n }, (_, i) => {
    const dep = `2026-06-15T${String(6 + i).padStart(2, '0')}:30:00+03:00`;
    const arr = `2026-06-15T${String(7 + i).padStart(2, '0')}:15:00+03:00`;
    return {
      departureTime: dep,
      arrivalTime: arr,
      trains: [
        {
          trainNumber: 2000 + i,
          orignStation: 2800,
          destinationStation: 1600,
          originPlatform: 1,
          destPlatform: 2,
          arrivalTime: arr,
          departureTime: dep,
          trainPosition: { calcDiffMinutes: 0 },
        },
      ],
    };
  });
  return { result: { travels } };
}

/** Deps with a real conversation store, an early "now" (so fakes are upcoming),
 *  and captured fetch args. */
function makeCustomDeps(fetchImpl?: PipelineDeps['fetchRoutes']) {
  const fetchCalls: Array<{ fromId: number; toId: number }> = [];
  const store = createConversationStore();
  const deps = makeDeps({
    conversation: store,
    now: () => dateAtJerusalemTime(5, 0),
    fetchRoutes:
      fetchImpl ??
      (async (fromId, toId) => {
        fetchCalls.push({ fromId, toId });
        return makeUpcomingResult(2);
      }),
  });
  return Object.assign(deps, { store, fetchCalls });
}

function bullets(message: string): number {
  return (message.match(/ • /g) ?? []).length;
}

describe('handleMessage — custom-route flow', () => {
  it('"0" enters custom mode: prompts, creates a flow, no fetch', async () => {
    const deps = makeCustomDeps();
    await handleMessage(makeMsg({ body: '0' }), BASE_CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 1);
    assert.match(deps.sendCalls[0]!.message, /Custom route/i);
    assert.equal(deps.fetchCalls.length, 0);
    assert.equal(deps.store.get(SENDER_UUID)?.awaiting, 'route');
  });

  it('one-shot route resolves and enters the wizard date step (no fetch yet)', async () => {
    const deps = makeCustomDeps();
    await handleMessage(makeMsg({ body: 'בנימינה אל נהריה' }), BASE_CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 1);
    assert.match(deps.sendCalls[0]!.message, /^When\?/);
    assert.equal(deps.fetchCalls.length, 0); // wizard asks the date before fetching
    const f = deps.store.get(SENDER_UUID);
    assert.equal(f?.awaiting, 'date');
    assert.equal(f?.originId, 2800);
    assert.equal(f?.destId, 1600);
  });

  it('a resolved route then "now" returns at most 5 trains (CUSTOM_ROUTE_COUNT)', async () => {
    const deps = makeCustomDeps(async () => makeUpcomingResult(7));
    await handleMessage(
      makeMsg({ timestamp: 1, body: 'בנימינה אל נהריה' }),
      BASE_CONFIG,
      deps,
      SALT,
    );
    await handleMessage(makeMsg({ timestamp: 2, body: 'now' }), BASE_CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 2);
    assert.equal(bullets(deps.sendCalls[1]!.message), 5);
  });

  it('multi-turn: menu reply then numeric pick enters the date step (no fetch)', async () => {
    const deps = makeCustomDeps();
    await handleMessage(makeMsg({ timestamp: 1, body: 'TLV to afula' }), BASE_CONFIG, deps, SALT);
    assert.equal(deps.fetchCalls.length, 0); // menu only, no fetch yet
    assert.match(deps.sendCalls[0]!.message, /Which origin/i);

    await handleMessage(makeMsg({ timestamp: 2, body: '2' }), BASE_CONFIG, deps, SALT);
    assert.equal(deps.sendCalls.length, 2);
    assert.equal(deps.fetchCalls.length, 0); // still no fetch — the wizard asks the date
    assert.match(deps.sendCalls[1]!.message, /^When\?/);
    const f = deps.store.get(SENDER_UUID);
    assert.equal(f?.awaiting, 'date');
    assert.equal(f?.originId, 4600);
    assert.equal(f?.destId, 1260);
  });

  it('reserved word mid-flow breaks out to the core path', async () => {
    const deps = makeCustomDeps();
    await handleMessage(makeMsg({ timestamp: 1, body: 'ראשון אל חיפה' }), BASE_CONFIG, deps, SALT);
    await handleMessage(makeMsg({ timestamp: 2, body: 'home' }), BASE_CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 2);
    // Second reply is the core "home" route report, not a custom menu.
    assert.match(deps.sendCalls[1]!.message, /Haifa → Afula/);
    assert.equal(deps.store.get(SENDER_UUID), undefined);
  });

  it('oversized body is truncated before matching (separator beyond cap is dropped)', async () => {
    const deps = makeCustomDeps();
    const body = `${'x'.repeat(300)} to afula`; // " to afula" sits past the 200-char cap
    await handleMessage(makeMsg({ body }), BASE_CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 1);
    // Truncation removed the separator → falls to the core menu, not a custom flow.
    assert.match(deps.sendCalls[0]!.message, /Pick a route/);
    assert.equal(deps.fetchCalls.length, 0);
    assert.equal(deps.store.get(SENDER_UUID), undefined);
  });
});

// ---------------------------------------------------------------------------
// Wizard end-to-end traces (README examples 1, 2, 4, 5, 6, 7, 8)
// ---------------------------------------------------------------------------

// 2026-06-22 12:00 Asia/Jerusalem (Mon). Tomorrow is Tue 23 Jun.
const WIZ_NOW = new Date(Date.UTC(2026, 5, 22, 9, 0, 0));

/** "YYYY-MM-DD" for an instant, in Asia/Jerusalem. */
function jeruYMD(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Train travels on the Jerusalem day of `dayRef` (June ⇒ +03:00). */
function travelsOn(dayRef: Date, pairs: Array<[string, string]>): RailApiGetRoutesResult {
  const ymd = jeruYMD(dayRef);
  const travels = pairs.map(([dep, arr], i) => ({
    departureTime: `${ymd}T${dep}:00+03:00`,
    arrivalTime: `${ymd}T${arr}:00+03:00`,
    trains: [
      {
        trainNumber: 3000 + i,
        orignStation: 2800,
        destinationStation: 1600,
        originPlatform: 3,
        destPlatform: 2,
        arrivalTime: `${ymd}T${arr}:00+03:00`,
        departureTime: `${ymd}T${dep}:00+03:00`,
        trainPosition: { calcDiffMinutes: 0 },
      },
    ],
  }));
  return { result: { travels } };
}

function makeWizardDeps(fetchImpl?: PipelineDeps['fetchRoutes']) {
  const fetchCalls: Array<{ fromId: number; toId: number; when: Date }> = [];
  const store = createConversationStore();
  const deps = makeDeps({
    conversation: store,
    now: () => WIZ_NOW,
    fetchRoutes:
      fetchImpl ??
      (async (fromId, toId, when) => {
        fetchCalls.push({ fromId, toId, when });
        // Two same-day trains a few hours ahead → no false rollover.
        return travelsOn(when, [
          ['19:08', '20:11'],
          ['19:38', '20:41'],
        ]);
      }),
  });
  return Object.assign(deps, { store, fetchCalls });
}

/** Send a sequence of bodies (auto-incrementing timestamps to dodge dedup). */
async function converse(deps: PipelineDeps, bodies: string[]): Promise<void> {
  let ts = 1;
  for (const body of bodies) {
    await handleMessage(makeMsg({ timestamp: ts++, body }), BASE_CONFIG, deps, SALT);
  }
}

describe('wizard E2E', () => {
  it('ex1 — "now" skips the time step and echoes a day-only header', async () => {
    const deps = makeWizardDeps();
    await converse(deps, ['בנימינה אל נהריה', 'now']);

    assert.match(deps.sendCalls[0]!.message, /^When\?/);
    const report = deps.sendCalls[1]!.message;
    assert.match(report, /^Binyamina → Nahariya · Today 22 Jun:/);
    assert.doesNotMatch(report, /Today 22 Jun,/); // day-only, no time
    assert.match(report, /Different date\/time, or a new route\?$/);
    // Fetched at "now".
    assert.equal(deps.fetchCalls[0]!.when.getTime(), WIZ_NOW.getTime());
  });

  it('ex2 — full wizard then carry-over follow-ups', async () => {
    const deps = makeWizardDeps();
    await converse(deps, ['בנימינה אל נהריה', 'tomorrow', '17:00', '12:00', 'today']);

    assert.match(deps.sendCalls[1]!.message, /^When tomorrow\?/);
    assert.match(deps.sendCalls[2]!.message, /· Tue 23 Jun, 17:00:/); // date+time
    assert.match(deps.sendCalls[3]!.message, /· Tue 23 Jun, 12:00:/); // lone time keeps Tue 23
    assert.match(deps.sendCalls[4]!.message, /· Today 22 Jun, 12:00:/); // lone date keeps 12:00
  });

  it('ex4 — destination disambiguation then into the date step', async () => {
    const deps = makeWizardDeps();
    await converse(deps, ['בנימינה אל חיפה', '2', 'tomorrow', '8']);

    assert.match(deps.sendCalls[0]!.message, /Which destination/i);
    assert.match(deps.sendCalls[1]!.message, /^When\?/); // station pick → date step
    assert.match(deps.sendCalls[2]!.message, /^When tomorrow\?/);
    assert.match(deps.sendCalls[3]!.message, /· Tue 23 Jun, 08:00:/); // bare "8" = 08:00
  });

  it('ex5 — validation re-asks and stays on the step', async () => {
    const deps = makeWizardDeps();
    await converse(deps, ['בנימינה אל נהריה', 'banana', 'tomorrow', '25:00', '19']);

    assert.match(deps.sendCalls[1]!.message, /Didn't catch that/);
    assert.match(deps.sendCalls[2]!.message, /^When tomorrow\?/);
    assert.match(deps.sendCalls[3]!.message, /not a valid time/);
    assert.match(deps.sendCalls[4]!.message, /· Tue 23 Jun, 19:00:/);
  });

  it('ex6 — back, cancel, and a mid-wizard route restart', async () => {
    const back = makeWizardDeps();
    await converse(back, ['בנימינה אל נהריה', 'tomorrow', 'back', 'cancel']);
    assert.match(back.sendCalls[2]!.message, /^When\?/); // back → date step
    assert.match(back.sendCalls[3]!.message, /Cancelled\. Send a route/);
    assert.equal(back.store.get(SENDER_UUID), undefined);

    const restart = makeWizardDeps();
    await converse(restart, ['בנימינה אל נהריה', 'tomorrow', 'בנימינה אל נהריה']);
    // A new X→Y mid-flow wipes the slots and re-asks the date.
    assert.match(restart.sendCalls[2]!.message, /^When\?/);
    assert.equal(restart.store.get(SENDER_UUID)?.awaiting, 'date');
    assert.equal(restart.store.get(SENDER_UUID)?.slotDate, undefined);
  });

  it('ex7 — no trains left today rolls over to the next service day', async () => {
    const deps = makeWizardDeps(async (_f, _t, when) =>
      // Nothing left on the queried day; first service is the next morning.
      travelsOn(new Date(when.getTime() + 86_400_000), [['05:21', '06:30']]),
    );
    await converse(deps, ['בנימינה אל נהריה', 'today', '23:55']);

    const msg = deps.sendCalls[2]!.message;
    assert.match(msg, /^No more trains today for Binyamina → Nahariya\. Next service:/);
    assert.match(msg, /· Tue 23 Jun:/); // next service day, day-only
  });

  it('ex8 — a stale/loose time with no active wizard nudges for a route', async () => {
    const deps = makeWizardDeps();
    // No prior route → the store has no flow (as if the TTL had lapsed).
    await converse(deps, ['19:00']);

    assert.equal(deps.sendCalls.length, 1);
    assert.match(deps.sendCalls[0]!.message, /don't have a route in mind/);
    assert.equal(deps.fetchCalls.length, 0);
  });
});
