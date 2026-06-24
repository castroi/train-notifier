/**
 * End-to-end wizard tests against the REAL Israel Railways API.
 *
 * Opt-in only — skipped unless `RAIL_E2E=1` is set, so the default `npm test`
 * suite stays hermetic (no network, no credentials). Run with:
 *
 *   npm run test:e2e
 *
 * which sets RAIL_E2E=1 and loads RAIL_URL / RAIL_API_KEY from `.env`.
 *
 * Live timetable data is non-deterministic, so these assert *structural*
 * invariants (a valid report/no-trains/rollover reply for the resolved route,
 * never the outage message) rather than exact train times.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConversationStore } from './bot/conversation.ts';
import { outage } from './bot/templates.ts';
import type { Config } from './config/types.ts';
import { Counters } from './core/counters.ts';
import { DedupCache } from './core/dedup.ts';
import type { PipelineDeps } from './pipeline.ts';
import { handleMessage } from './pipeline.ts';
import { fetchRoutes } from './rail/client.ts';
import { extractTrains, formatTrainLine } from './rail/format.ts';
import type { IncomingMessage } from './signal/types.ts';

const LIVE = process.env.RAIL_E2E === '1';

const OWNER_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SALT = 'e2e-salt-0123456789';

// Binyamina → Nahariya: a frequent coastal-line pair that resolves one-shot.
const ROUTE_BODY = 'בנימינה אל נהריה';
const ROUTE_LABEL = /Binyamina → Nahariya/;

const CONFIG: Config = {
  signal: { bot_number: '+972500000000', owner_uuid: OWNER_UUID, allowlist: [OWNER_UUID] },
  routes: [],
  schedules: [],
  time_windows: [],
  defaults: { on_demand_count: 3 },
};

function makeMsg(timestamp: number, body: string): IncomingMessage {
  return { sourceUuid: OWNER_UUID, sourceDevice: 1, timestamp, body };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real deps: live rail fetch, real conversation store, captured sends.
 *
 * `fetchRoutes` is wrapped in a spy that records the `when` of every call and
 * still hits the real API — so a test can prove each refresh issues a fresh
 * network request (there is no response cache anywhere in the pipeline).
 * An injectable `nowFn` lets a test advance the clock to exercise `now`-slot
 * re-resolution without waiting real minutes.
 */
function makeLiveDeps(nowFn: () => Date = () => new Date()) {
  const sendCalls: string[] = [];
  const fetchWhens: Date[] = [];
  const deps: PipelineDeps = {
    fetchRoutes: async (fromId, toId, when, signal) => {
      fetchWhens.push(when);
      return fetchRoutes(fromId, toId, when, signal);
    },
    send: async (_bot, _to, message) => {
      sendCalls.push(message);
    },
    dedup: new DedupCache(),
    counters: new Counters(),
    conversation: createConversationStore(),
    now: nowFn,
  };
  return Object.assign(deps, { sendCalls, fetchWhens });
}

/** A genuine outcome (report / no-trains / rollover) always names the route and
 *  is never the outage string. */
function assertValidReply(reply: string): void {
  assert.notEqual(reply, outage(), `rail API returned an outage:\n${reply}`);
  assert.match(reply, ROUTE_LABEL, `expected a route reply, got:\n${reply}`);
}

describe('pipeline E2E — real rail API', { skip: !LIVE }, () => {
  it('rail layer: fetchRoutes returns travels and extractTrains formats lines', async () => {
    const res = await fetchRoutes(2800, 1600, new Date());
    assert.ok(Array.isArray(res.result.travels));
    for (const s of extractTrains(res, 3, Date.now())) {
      assert.match(formatTrainLine(s), /^\d{2}:\d{2} → \d{2}:\d{2} · /);
    }
  });

  it('wizard "now": route → When? → a live report (not an outage)', async () => {
    const deps = makeLiveDeps();
    await handleMessage(makeMsg(1, ROUTE_BODY), CONFIG, deps, SALT);
    await handleMessage(makeMsg(2, 'now'), CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 2);
    assert.match(deps.sendCalls[0]!, /^When\?/);
    assertValidReply(deps.sendCalls[1]!);
  });

  it('wizard date+time: route → tomorrow → 8 → a live report (not an outage)', async () => {
    const deps = makeLiveDeps();
    await handleMessage(makeMsg(1, ROUTE_BODY), CONFIG, deps, SALT);
    await handleMessage(makeMsg(2, 'tomorrow'), CONFIG, deps, SALT);
    await handleMessage(makeMsg(3, '8'), CONFIG, deps, SALT);

    assert.equal(deps.sendCalls.length, 3);
    assert.match(deps.sendCalls[0]!, /^When\?/);
    assert.match(deps.sendCalls[1]!, /^When tomorrow\?/);
    assertValidReply(deps.sendCalls[2]!);
  });

  // -------------------------------------------------------------------------
  // Refresh against the live API (issue #15) — proves no response cache.
  // -------------------------------------------------------------------------

  it('ask → delay → refresh: each refresh hits the real API again (no cache)', async () => {
    const deps = makeLiveDeps();
    await handleMessage(makeMsg(1, ROUTE_BODY), CONFIG, deps, SALT); // When?
    await handleMessage(makeMsg(2, 'now'), CONFIG, deps, SALT); // live report — fetch #1
    assert.equal(deps.fetchWhens.length, 1, 'the initial "now" must perform exactly one fetch');
    assertValidReply(deps.sendCalls[1]!);

    await sleep(2000); // a real delay between the request and the refresh

    await handleMessage(makeMsg(3, 'refresh'), CONFIG, deps, SALT); // fetch #2
    assert.equal(
      deps.fetchWhens.length,
      2,
      'refresh must issue a brand-new request, not replay a cached result',
    );
    assertValidReply(deps.sendCalls[2]!);

    await handleMessage(makeMsg(4, 'שוב'), CONFIG, deps, SALT); // Hebrew trigger — fetch #3
    assert.equal(deps.fetchWhens.length, 3, 'every refresh re-queries the API');
    assertValidReply(deps.sendCalls[3]!);
  });

  it('refresh re-resolves "now": the new live request carries a later instant', async () => {
    let nowMs = Date.now();
    const deps = makeLiveDeps(() => new Date(nowMs));
    await handleMessage(makeMsg(1, ROUTE_BODY), CONFIG, deps, SALT);
    await handleMessage(makeMsg(2, 'now'), CONFIG, deps, SALT); // fetch #1 at t0

    nowMs += 7 * 60_000; // seven minutes "pass"
    await handleMessage(makeMsg(3, 'refresh'), CONFIG, deps, SALT); // fetch #2 at t0+7m

    assert.equal(deps.fetchWhens.length, 2);
    // The refreshed request is a fresh call resolved to the current moment.
    assert.equal(
      deps.fetchWhens[1]!.getTime() - deps.fetchWhens[0]!.getTime(),
      7 * 60_000,
      'a "now" refresh must re-resolve to the new current time, not reuse the stored one',
    );
    assertValidReply(deps.sendCalls[2]!);
  });

  it('clock-query refresh: identical params still trigger a fresh API request', async () => {
    const deps = makeLiveDeps();
    await handleMessage(makeMsg(1, ROUTE_BODY), CONFIG, deps, SALT);
    await handleMessage(makeMsg(2, 'tomorrow'), CONFIG, deps, SALT);
    await handleMessage(makeMsg(3, '8'), CONFIG, deps, SALT); // fetch #1 at tomorrow 08:00
    await handleMessage(makeMsg(4, 'refresh'), CONFIG, deps, SALT); // fetch #2 at the SAME instant

    assert.equal(deps.fetchWhens.length, 2);
    // Strongest no-cache proof: same query parameters, yet a second request fires.
    assert.equal(
      deps.fetchWhens[1]!.getTime(),
      deps.fetchWhens[0]!.getTime(),
      'a clock query must replay the exact same instant',
    );
    assertValidReply(deps.sendCalls[3]!);
  });
});
