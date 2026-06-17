import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Config, Schedule } from '../config/types.ts';
import { Counters } from '../core/counters.ts';
import type { RailApiGetRoutesResult } from '../rail/types.ts';
import type { RunJobDeps } from './runJob.ts';
import { runJob } from './runJob.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal valid config used by all tests. */
const BASE_CONFIG: Config = {
  signal: {
    bot_number: '+972501234567',
    owner_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    allowlist: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
  },
  routes: [
    {
      key: 'work',
      from_id: 1260,
      to_id: 2100,
      label_en: 'Afula → Haifa',
      label_he: 'עפולה → חיפה',
      aliases: ['work', 'עבודה'],
      count: 3,
    },
  ],
  schedules: [
    {
      id: 'morning',
      cron: '30 6 * * 0-4',
      route_key: 'work',
      count: 3,
    },
  ],
  time_windows: [],
  defaults: { on_demand_count: 2 },
};

const MORNING_SCHEDULE: Schedule = BASE_CONFIG.schedules[0]!;

/**
 * Build a minimal RailApiGetRoutesResult with `n` travel entries.
 * Each travel has one train; depart and arrive times are ISO strings.
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

/** Fixed "now" for DST-guard tests — a specific Jerusalem local time. */
const FIXED_NOW = new Date('2026-06-15T06:30:00+03:00'); // 06:30 JLM

// ---------------------------------------------------------------------------
// Helper: build a fresh set of injected test doubles per test.
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<RunJobDeps>): RunJobDeps & {
  sendCalls: string[];
  counters: Counters;
} {
  const sendCalls: string[] = [];
  const counters = new Counters();

  const base: RunJobDeps = {
    fetchRoutes: async () => makeFakeResult(2),
    send: async (_bot, _recip, message) => {
      sendCalls.push(message);
    },
    counters,
    now: () => FIXED_NOW,
    lockMap: new Map(),
    dstGuard: new Set(),
    ...overrides,
  };

  return Object.assign(base, { sendCalls, counters });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runJob — lock prevents overlap', () => {
  it('fires fetch only once when a second call arrives while first is running', async () => {
    let fetchCallCount = 0;
    let resolveFirst!: () => void;

    // First fetch hangs until we manually resolve it.
    const hangingFetch = (): Promise<RailApiGetRoutesResult> =>
      new Promise((resolve) => {
        fetchCallCount++;
        resolveFirst = () => resolve(makeFakeResult(1));
      });

    const lockMap = new Map<string, boolean>();
    const dstGuard = new Set<string>();

    const deps1 = makeDeps({ fetchRoutes: hangingFetch, lockMap, dstGuard });
    // Second call uses a DIFFERENT now so DST guard doesn't block it (the lock
    // is what we're testing here).
    const deps2 = makeDeps({
      fetchRoutes: hangingFetch,
      lockMap,
      // Different dstGuard so DST guard doesn't interfere with the lock test.
      dstGuard: new Set<string>(),
      now: () => new Date(FIXED_NOW.getTime() + 60_000),
    });

    // Start first job (will hang waiting for hangingFetch to resolve).
    const p1 = runJob(MORNING_SCHEDULE, BASE_CONFIG, deps1);

    // Yield to let p1 acquire the lock before p2 tries.
    await new Promise((r) => setImmediate(r));

    // Start second job — should see lock held and skip immediately.
    const p2 = runJob(MORNING_SCHEDULE, BASE_CONFIG, deps2);

    // Resolve the hanging fetch so p1 can complete.
    resolveFirst();
    await Promise.all([p1, p2]);

    // fetch should have been called exactly once (by p1; p2 was blocked).
    assert.equal(fetchCallCount, 1, 'fetchRoutes must be called only once');
  });
});

describe('runJob — DST run-guard', () => {
  it('suppresses a second fire with the same schedule id + local date + local time', async () => {
    let fetchCallCount = 0;
    const deps = makeDeps({
      fetchRoutes: async () => {
        fetchCallCount++;
        return makeFakeResult(1);
      },
    });

    // Both calls share the same deps.dstGuard and same `now`.
    await runJob(MORNING_SCHEDULE, BASE_CONFIG, deps);
    await runJob(MORNING_SCHEDULE, BASE_CONFIG, deps);

    assert.equal(fetchCallCount, 1, 'second fire must be suppressed by DST guard');
  });

  it('allows a fire at a different minute (different guardKey)', async () => {
    let fetchCallCount = 0;
    const sharedDstGuard = new Set<string>();

    const makeMinuteDeps = (offsetMs: number) =>
      makeDeps({
        fetchRoutes: async () => {
          fetchCallCount++;
          return makeFakeResult(1);
        },
        dstGuard: sharedDstGuard,
        lockMap: new Map(),
        now: () => new Date(FIXED_NOW.getTime() + offsetMs),
      });

    await runJob(MORNING_SCHEDULE, BASE_CONFIG, makeMinuteDeps(0));
    await runJob(MORNING_SCHEDULE, BASE_CONFIG, makeMinuteDeps(60_000)); // +1 min

    assert.equal(fetchCallCount, 2, 'different minute must produce different guard key');
  });
});

describe('runJob — failure path', () => {
  it('does not throw when fetchRoutes throws, records a fail counter, send is NOT called', async () => {
    const deps = makeDeps({
      fetchRoutes: async () => {
        throw new Error('Network failure');
      },
    });

    // Must not throw.
    await assert.doesNotReject(() => runJob(MORNING_SCHEDULE, BASE_CONFIG, deps));

    assert.equal(deps.sendCalls.length, 0, 'send must not be called when fetch fails');
    assert.equal(
      deps.counters.flush(),
      'counters route=work success=0 fail=1 timeout=0',
      'fail counter must be incremented',
    );
  });

  it('does not throw when send throws, records a fail counter', async () => {
    const deps = makeDeps({
      send: async () => {
        throw new Error('Signal unreachable');
      },
    });

    await assert.doesNotReject(() => runJob(MORNING_SCHEDULE, BASE_CONFIG, deps));

    assert.equal(
      deps.counters.flush(),
      'counters route=work success=0 fail=1 timeout=0',
      'fail counter must be incremented when send throws',
    );
  });
});

describe('runJob — happy path', () => {
  it('calls send once with a message containing the route label, records success', async () => {
    const deps = makeDeps({
      fetchRoutes: async () => makeFakeResult(2),
    });

    await runJob(MORNING_SCHEDULE, BASE_CONFIG, deps);

    assert.equal(deps.sendCalls.length, 1, 'send must be called exactly once');
    const msg = deps.sendCalls[0]!;
    // Message must contain the route's English label.
    assert.ok(msg.includes('Afula → Haifa'), `Message should contain route label_en; got: ${msg}`);
    // Check counter.
    assert.equal(
      deps.counters.flush(),
      'counters route=work success=1 fail=0 timeout=0',
      'success counter must be incremented',
    );
  });

  it('sends the no-trains message when the API returns zero travels', async () => {
    const deps = makeDeps({
      fetchRoutes: async () => makeFakeResult(0),
    });

    await runJob(MORNING_SCHEDULE, BASE_CONFIG, deps);

    assert.equal(deps.sendCalls.length, 1, 'send must be called even when no trains');
    const msg = deps.sendCalls[0]!;
    assert.ok(msg.includes('No upcoming departures'), `Expected no-trains message; got: ${msg}`);
    assert.equal(deps.counters.flush(), 'counters route=work success=1 fail=0 timeout=0');
  });

  it('sends correct recipient (owner_uuid) and bot number (bot_number)', async () => {
    let capturedBot = '';
    let capturedRecipient = '';

    const deps = makeDeps({
      send: async (bot, recip, _msg) => {
        capturedBot = bot;
        capturedRecipient = recip;
      },
    });

    await runJob(MORNING_SCHEDULE, BASE_CONFIG, deps);

    assert.equal(capturedBot, BASE_CONFIG.signal.bot_number);
    assert.equal(capturedRecipient, BASE_CONFIG.signal.owner_uuid);
  });
});
