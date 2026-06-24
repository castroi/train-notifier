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

/** Real deps: live rail fetch, real conversation store, captured sends. */
function makeLiveDeps() {
  const sendCalls: string[] = [];
  const deps: PipelineDeps = {
    fetchRoutes,
    send: async (_bot, _to, message) => {
      sendCalls.push(message);
    },
    dedup: new DedupCache(),
    counters: new Counters(),
    conversation: createConversationStore(),
    now: () => new Date(),
  };
  return Object.assign(deps, { sendCalls });
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
});
