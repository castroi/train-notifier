import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PendingFlow } from './conversation.ts';
import { createConversationStore } from './conversation.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a minimal valid Omit<PendingFlow, 'expiresAt'> for a given sender. */
function makeFlow(
  sender: string,
  extra?: Partial<Omit<PendingFlow, 'expiresAt' | 'sender'>>,
): Omit<PendingFlow, 'expiresAt'> {
  return {
    sender,
    awaiting: 'origin',
    candidates: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// set → get round-trip
// ---------------------------------------------------------------------------

describe('ConversationStore — set and get', () => {
  it('set then get returns the stored flow with a stamped expiresAt', () => {
    const fakeNow = 1_000_000;
    const store = createConversationStore({ ttlMs: 120_000, now: () => fakeNow });

    const returned = store.set(
      makeFlow('alice', { awaiting: 'destination', candidates: ['s1', 's2'] }),
    );

    assert.equal(returned.sender, 'alice');
    assert.equal(returned.awaiting, 'destination');
    assert.deepEqual(returned.candidates, ['s1', 's2']);
    assert.equal(returned.expiresAt, fakeNow + 120_000);

    const fetched = store.get('alice');
    assert.ok(fetched !== undefined);
    assert.deepEqual(fetched, returned);
  });

  it('get for unknown sender returns undefined', () => {
    const store = createConversationStore();
    assert.equal(store.get('nobody'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

describe('ConversationStore — expiry', () => {
  it('flow is available before TTL elapses', () => {
    let fakeNow = 0;
    const store = createConversationStore({ ttlMs: 5_000, now: () => fakeNow });

    store.set(makeFlow('bob'));

    fakeNow = 4_999;
    assert.ok(store.get('bob') !== undefined);
  });

  it('flow is evicted and get returns undefined once now >= expiresAt', () => {
    let fakeNow = 0;
    const store = createConversationStore({ ttlMs: 5_000, now: () => fakeNow });

    store.set(makeFlow('carol'));

    // Advance past TTL
    fakeNow = 5_001;
    assert.equal(store.get('carol'), undefined);

    // Entry must be evicted — a second get should also return undefined
    assert.equal(store.get('carol'), undefined);
  });

  it('exactly at boundary (now === expiresAt) is treated as expired', () => {
    let fakeNow = 1_000;
    const store = createConversationStore({ ttlMs: 5_000, now: () => fakeNow });

    store.set(makeFlow('dave'));
    // expiresAt = 1_000 + 5_000 = 6_000
    fakeNow = 6_000;

    // now < expiresAt is the live condition; equality means expired
    assert.equal(store.get('dave'), undefined);
  });

  it('eviction on expiry shrinks the internal store (re-set proves it)', () => {
    let fakeNow = 0;
    const store = createConversationStore({ ttlMs: 1_000, now: () => fakeNow });

    store.set(makeFlow('eve'));

    // Expire it
    fakeNow = 2_000;
    store.get('eve'); // triggers eviction

    // Re-set with a fresh TTL — must succeed
    fakeNow = 2_000;
    store.set(makeFlow('eve', { awaiting: 'confirm', confirmTarget: 's42' }));

    // Now alive again
    fakeNow = 2_500;
    const flow = store.get('eve');
    assert.ok(flow !== undefined);
    assert.equal(flow.awaiting, 'confirm');
    assert.equal(flow.confirmTarget, 's42');
    assert.equal(flow.expiresAt, 2_000 + 1_000);
  });
});

// ---------------------------------------------------------------------------
// Per-sender isolation
// ---------------------------------------------------------------------------

describe('ConversationStore — per-sender isolation', () => {
  it('two senders have independent flows', () => {
    const store = createConversationStore({ ttlMs: 60_000 });

    store.set(makeFlow('sender-a', { awaiting: 'origin' }));
    store.set(makeFlow('sender-b', { awaiting: 'destination', origin: 's10' }));

    const a = store.get('sender-a');
    const b = store.get('sender-b');

    assert.ok(a !== undefined);
    assert.ok(b !== undefined);
    assert.equal(a.awaiting, 'origin');
    assert.equal(b.awaiting, 'destination');
    assert.equal(b.origin, 's10');
  });

  it('clearing one sender leaves the other intact', () => {
    const store = createConversationStore({ ttlMs: 60_000 });

    store.set(makeFlow('sender-x'));
    store.set(makeFlow('sender-y'));

    store.clear('sender-x');

    assert.equal(store.get('sender-x'), undefined);
    assert.ok(store.get('sender-y') !== undefined);
  });

  it('clearing an unknown sender does not throw', () => {
    const store = createConversationStore();
    assert.doesNotThrow(() => store.clear('ghost'));
  });
});

// ---------------------------------------------------------------------------
// Overwrite / refresh
// ---------------------------------------------------------------------------

describe('ConversationStore — overwrite', () => {
  it('second set for same sender replaces all fields', () => {
    let fakeNow = 0;
    const store = createConversationStore({ ttlMs: 10_000, now: () => fakeNow });

    store.set(makeFlow('frank', { awaiting: 'origin', candidates: ['s1'] }));

    fakeNow = 5_000;
    store.set(
      makeFlow('frank', { awaiting: 'confirm', candidates: ['s2', 's3'], confirmTarget: 's2' }),
    );

    const flow = store.get('frank');
    assert.ok(flow !== undefined);
    assert.equal(flow.awaiting, 'confirm');
    assert.deepEqual(flow.candidates, ['s2', 's3']);
    assert.equal(flow.confirmTarget, 's2');
    // expiresAt is refreshed from the second set's timestamp
    assert.equal(flow.expiresAt, 5_000 + 10_000);
  });

  it('overwrite refreshes TTL so the flow survives past the original expiry', () => {
    let fakeNow = 0;
    const store = createConversationStore({ ttlMs: 5_000, now: () => fakeNow });

    store.set(makeFlow('grace')); // expiresAt = 5_000

    // Just before original expiry, overwrite
    fakeNow = 4_900;
    store.set(makeFlow('grace', { awaiting: 'destination' })); // expiresAt = 9_900

    // Advance past original expiry — should still be alive
    fakeNow = 5_500;
    assert.ok(store.get('grace') !== undefined);

    // Advance past refreshed expiry — should be gone
    fakeNow = 10_000;
    assert.equal(store.get('grace'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Custom TTL
// ---------------------------------------------------------------------------

describe('ConversationStore — custom ttlMs', () => {
  it('honours a custom ttlMs of 500 ms', () => {
    let fakeNow = 0;
    const store = createConversationStore({ ttlMs: 500, now: () => fakeNow });

    const flow = store.set(makeFlow('hank'));
    assert.equal(flow.expiresAt, 500);

    fakeNow = 499;
    assert.ok(store.get('hank') !== undefined);

    fakeNow = 500;
    assert.equal(store.get('hank'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Optional fields round-trip
// ---------------------------------------------------------------------------

describe('ConversationStore — optional fields', () => {
  it('stores and retrieves origin, destination, and confirmTarget', () => {
    const store = createConversationStore({ ttlMs: 60_000 });

    store.set({
      sender: 'irene',
      awaiting: 'confirm',
      origin: 'station-1',
      destination: 'station-2',
      candidates: ['station-2'],
      confirmTarget: 'station-2',
    });

    const flow = store.get('irene');
    assert.ok(flow !== undefined);
    assert.equal(flow.origin, 'station-1');
    assert.equal(flow.destination, 'station-2');
    assert.equal(flow.confirmTarget, 'station-2');
  });

  it('flow without optional fields leaves them undefined', () => {
    const store = createConversationStore({ ttlMs: 60_000 });

    store.set(makeFlow('jake'));
    const flow = store.get('jake');
    assert.ok(flow !== undefined);
    assert.equal(flow.origin, undefined);
    assert.equal(flow.destination, undefined);
    assert.equal(flow.confirmTarget, undefined);
  });
});
