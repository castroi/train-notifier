import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ConversationStore, createConversationStore } from './bot/conversation.ts';
import {
  beginRoute,
  continueRoute,
  enterCustomMode,
  hasRouteSeparator,
  isRefreshWord,
} from './route.ts';

const U = 'sender-1';

function getFlow(store: ConversationStore, sender: string = U) {
  const f = store.get(sender);
  if (!f) throw new Error('expected a pending flow');
  return f;
}

function reply(o: ReturnType<typeof beginRoute>): string {
  assert.equal(o.kind, 'reply');
  if (o.kind !== 'reply') throw new Error('not a reply');
  return o.text;
}

// A resolved route now hands off to the wizard's date step: the outcome is the
// "When?" prompt and the slots are stored on the pending flow.
function expectDateStep(
  o: ReturnType<typeof beginRoute>,
  store: ConversationStore,
  expected: { fromId: number; toId: number; label: string },
  sender: string = U,
): void {
  assert.equal(o.kind, 'reply');
  if (o.kind !== 'reply') throw new Error('not a reply');
  assert.match(o.text, /^When\?/);
  const f = getFlow(store, sender);
  assert.equal(f.awaiting, 'date');
  assert.equal(f.originId, expected.fromId);
  assert.equal(f.destId, expected.toId);
  assert.equal(f.routeLabel, expected.label);
}

// Fixed reference instant for wizard tests: 2026-06-22 12:00 Asia/Jerusalem.
const NOW = new Date(Date.UTC(2026, 5, 22, 9, 0, 0));

// ---------------------------------------------------------------------------
// hasRouteSeparator
// ---------------------------------------------------------------------------

describe('hasRouteSeparator', () => {
  it('detects HE/EN separators and directional forms', () => {
    assert.equal(hasRouteSeparator('בנימינה אל נהריה'), true);
    assert.equal(hasRouteSeparator('tlv to afula'), true);
    assert.equal(hasRouteSeparator('from haifa to afula'), true);
    assert.equal(hasRouteSeparator('to afula'), true);
    assert.equal(hasRouteSeparator('אל עפולה'), true);
    assert.equal(hasRouteSeparator('בנימינה'), false);
    assert.equal(hasRouteSeparator('haifa'), false);
  });
});

// ---------------------------------------------------------------------------
// One-shot resolution (accept + accept)
// ---------------------------------------------------------------------------

describe('beginRoute — one-shot accept/accept', () => {
  it('בנימינה אל נהריה → resolved 2800 → 1600, enters the date step', () => {
    const store = createConversationStore();
    const out = beginRoute('בנימינה אל נהריה', U, store);
    expectDateStep(out, store, { fromId: 2800, toId: 1600, label: 'Binyamina → Nahariya' });
  });
});

// ---------------------------------------------------------------------------
// Menu on one half (alias origin), accept destination
// ---------------------------------------------------------------------------

describe('beginRoute — TLV to afula', () => {
  it('origin alias → menu(4); pick resolves with accepted destination', () => {
    const store = createConversationStore();
    const out = beginRoute('TLV to afula', U, store);
    reply(out);
    const flow = getFlow(store);
    assert.equal(flow.awaiting, 'origin');
    assert.deepEqual(flow.candidates, ['3700', '4600', '3600', '4900']);
    assert.equal(flow.destText, 'afula');

    const done = continueRoute('2', U, getFlow(store), store);
    expectDateStep(done, store, {
      fromId: 4600,
      toId: 1260,
      label: 'Tel Aviv - HaShalom → Afula R.Eitan',
    });
  });
});

// ---------------------------------------------------------------------------
// Both halves need a menu (ראשון אל חיפה)
// ---------------------------------------------------------------------------

describe('beginRoute — double menu', () => {
  it('ראשון אל חיפה → origin menu(2) then destination menu(3) → resolved', () => {
    const store = createConversationStore();
    reply(beginRoute('ראשון אל חיפה', U, store));
    assert.deepEqual(getFlow(store).candidates, ['9100', '9800']);

    // pick origin Rishon-HaRishonim
    reply(continueRoute('1', U, getFlow(store), store));
    const destFlow = getFlow(store);
    assert.equal(destFlow.awaiting, 'destination');
    assert.equal(destFlow.origin, '9100');
    assert.deepEqual(destFlow.candidates, ['2100', '2200', '2300']);

    // pick destination Hof HaKarmel (candidates are id-ascending: 2100, 2200, 2300)
    const done = continueRoute('3', U, getFlow(store), store);
    expectDateStep(done, store, { fromId: 9100, toId: 2300, label: getFlow(store).routeLabel! });
  });
});

// ---------------------------------------------------------------------------
// Confirm step (non-exact unique)
// ---------------------------------------------------------------------------

describe('confirm flow', () => {
  it('נמל תעופה אל חיפה → confirm origin; yes → destination menu → resolved', () => {
    const store = createConversationStore();
    reply(beginRoute('נמל תעופה אל חיפה', U, store));
    const f = getFlow(store);
    assert.equal(f.awaiting, 'confirm');
    assert.equal(f.confirmTarget, '8600');
    assert.equal(f.confirmRole, 'origin');
    assert.equal(f.destText, 'חיפה');

    reply(continueRoute('yes', U, getFlow(store), store));
    const destFlow = getFlow(store);
    assert.equal(destFlow.origin, '8600');
    assert.deepEqual(destFlow.candidates, ['2100', '2200', '2300']);

    const done = continueRoute('1', U, getFlow(store), store);
    expectDateStep(done, store, { fromId: 8600, toId: 2100, label: getFlow(store).routeLabel! });
  });

  it('"1" confirms (numbered yes)', () => {
    const store = createConversationStore();
    reply(beginRoute('נמל תעופה אל חיפה', U, store));
    assert.equal(getFlow(store).awaiting, 'confirm');
    reply(continueRoute('1', U, getFlow(store), store));
    assert.equal(getFlow(store).origin, '8600');
  });

  it('"2" rejects (numbered no) and re-asks the half', () => {
    const store = createConversationStore();
    reply(beginRoute('נמל תעופה אל חיפה', U, store));
    const out = continueRoute('2', U, getFlow(store), store);
    assert.match(reply(out), /send the origin again/i);
    assert.equal(getFlow(store).awaiting, 'origin');
  });

  it('"0" cancels while in a confirm flow', () => {
    const store = createConversationStore();
    reply(beginRoute('נמל תעופה אל חיפה', U, store));
    assert.equal(getFlow(store).awaiting, 'confirm');
    const out = continueRoute('0', U, getFlow(store), store);
    assert.match(reply(out), /cancel/i);
    assert.equal(store.get(U), undefined);
  });

  it('Hebrew כן confirms (equivalent to yes)', () => {
    const store = createConversationStore();
    reply(beginRoute('נמל תעופה אל חיפה', U, store));
    assert.equal(getFlow(store).awaiting, 'confirm');
    reply(continueRoute('כן', U, getFlow(store), store));
    assert.equal(getFlow(store).origin, '8600');
  });

  it('"no" re-asks the same half as free text', () => {
    const store = createConversationStore();
    reply(beginRoute('נמל תעופה אל חיפה', U, store));
    const out = continueRoute('no', U, getFlow(store), store);
    assert.match(reply(out), /send the origin again/i);
    const f = getFlow(store);
    assert.equal(f.awaiting, 'origin');
    assert.deepEqual(f.candidates, []);
    assert.equal(f.destText, 'חיפה'); // destination still stashed
  });

  it('typo route narahria→carmely chains confirm → confirm → resolved', () => {
    const store = createConversationStore();
    reply(beginRoute('Narahria to carmely', U, store));
    assert.equal(getFlow(store).confirmTarget, '1600'); // Nahariya
    reply(continueRoute('yes', U, getFlow(store), store));
    assert.equal(getFlow(store).confirmTarget, '1840'); // Karmiel
    const done = continueRoute('yes', U, getFlow(store), store);
    expectDateStep(done, store, { fromId: 1600, toId: 1840, label: 'Nahariya → Karmiel' });
  });
});

// ---------------------------------------------------------------------------
// Reserved route-word used as a half (§8)
// ---------------------------------------------------------------------------

describe('reserved word as route half', () => {
  it('עבודה אל חיפה → clarify, no station resolution, flow cleared', () => {
    const store = createConversationStore();
    const out = beginRoute('עבודה אל חיפה', U, store);
    assert.match(reply(out), /saved route, not a station/i);
    assert.equal(store.get(U), undefined);
  });
});

// ---------------------------------------------------------------------------
// Source == destination (G4)
// ---------------------------------------------------------------------------

describe('source equals destination', () => {
  it('חיפה אל חיפה with the same pick both times → same-station reply', () => {
    const store = createConversationStore();
    reply(beginRoute('חיפה אל חיפה', U, store));
    reply(continueRoute('1', U, getFlow(store), store)); // origin 2100
    const out = continueRoute('1', U, getFlow(store), store); // destination 2100
    assert.match(reply(out), /same station/i);
    assert.equal(store.get(U), undefined);
  });
});

// ---------------------------------------------------------------------------
// Directional + entry-mode + bare-origin guided path
// ---------------------------------------------------------------------------

describe('directional and guided entry', () => {
  it('"to afula" prompts for origin, then resolves', () => {
    const store = createConversationStore();
    const out = beginRoute('to afula', U, store);
    assert.match(reply(out), /where from/i);
    assert.equal(getFlow(store).destText, 'afula');

    const done = continueRoute('בנימינה', U, getFlow(store), store);
    expectDateStep(done, store, { fromId: 2800, toId: 1260, label: 'Binyamina → Afula R.Eitan' });
  });

  it('enterCustomMode then bare origin → asks destination → resolved', () => {
    const store = createConversationStore();
    reply(enterCustomMode(U, store));
    assert.equal(getFlow(store).awaiting, 'route');

    reply(continueRoute('ראשון', U, getFlow(store), store)); // origin menu(2)
    reply(continueRoute('1', U, getFlow(store), store)); // origin 9100, ask dest
    assert.equal(getFlow(store).awaiting, 'destination');

    reply(continueRoute('חיפה', U, getFlow(store), store)); // dest menu(3)
    const done = continueRoute('1', U, getFlow(store), store);
    expectDateStep(done, store, { fromId: 9100, toId: 2100, label: getFlow(store).routeLabel! });
  });
});

// ---------------------------------------------------------------------------
// Cancel / breakout / invalid numeric
// ---------------------------------------------------------------------------

describe('cancel, breakout, invalid input', () => {
  it('"0" cancels a pending flow', () => {
    const store = createConversationStore();
    reply(beginRoute('ראשון אל חיפה', U, store));
    const out = continueRoute('0', U, getFlow(store), store);
    assert.match(reply(out), /cancelled/i);
    assert.equal(store.get(U), undefined);
  });

  it('"ביטול" cancels', () => {
    const store = createConversationStore();
    reply(beginRoute('ראשון אל חיפה', U, store));
    reply(continueRoute('ביטול', U, getFlow(store), store));
    assert.equal(store.get(U), undefined);
  });

  it('reserved word during a flow breaks out for the core path', () => {
    const store = createConversationStore();
    reply(beginRoute('ראשון אל חיפה', U, store));
    const out = continueRoute('home', U, getFlow(store), store);
    assert.deepEqual(out, { kind: 'breakout', text: 'home' });
    assert.equal(store.get(U), undefined);
  });

  it('out-of-range number re-prompts without losing state', () => {
    const store = createConversationStore();
    reply(beginRoute('ראשון אל חיפה', U, store));
    const before = getFlow(store);
    const out = continueRoute('9', U, before, store);
    assert.match(reply(out), /number 1–2/);
    // flow still present and unchanged in shape
    assert.deepEqual(getFlow(store).candidates, ['9100', '9800']);
  });
});

// ---------------------------------------------------------------------------
// Per-sender isolation
// ---------------------------------------------------------------------------

describe('per-sender isolation', () => {
  it('two senders run independent flows', () => {
    const store = createConversationStore();
    reply(beginRoute('ראשון אל חיפה', 'a', store));
    reply(beginRoute('TLV to afula', 'b', store));
    assert.deepEqual(getFlow(store, 'a').candidates, ['9100', '9800']);
    assert.deepEqual(getFlow(store, 'b').candidates, ['3700', '4600', '3600', '4900']);
  });
});

// ---------------------------------------------------------------------------
// Wizard: date → time → results (plan §4.3–§4.6, §8.3)
// ---------------------------------------------------------------------------

/** Resolve "Binyamina → Nahariya" and land on the date step. */
function atDateStep(store: ConversationStore): void {
  expectDateStep(beginRoute('בנימינה אל נהריה', U, store), store, {
    fromId: 2800,
    toId: 1600,
    label: 'Binyamina → Nahariya',
  });
}

describe('wizard date step', () => {
  it('"now" skips the time step and emits a now result', () => {
    const store = createConversationStore();
    atDateStep(store);
    const out = continueRoute('now', U, getFlow(store), store, NOW);
    assert.deepEqual(out, {
      kind: 'results',
      fromId: 2800,
      toId: 1600,
      label: 'Binyamina → Nahariya',
      when: NOW,
      isNow: true,
    });
    assert.equal(getFlow(store).awaiting, 'results');
  });

  it('a day-only date advances to the time step and personalises the prompt', () => {
    const store = createConversationStore();
    atDateStep(store);
    const out = continueRoute('tomorrow', U, getFlow(store), store, NOW);
    assert.match(reply(out), /^When tomorrow\?/);
    const f = getFlow(store);
    assert.equal(f.awaiting, 'time');
    assert.deepEqual(f.slotDate, { kind: 'date', y: 2026, m: 6, d: 23 });
  });

  it('invalid date re-asks and stays on the date step', () => {
    const store = createConversationStore();
    atDateStep(store);
    const out = continueRoute('banana', U, getFlow(store), store, NOW);
    assert.match(reply(out), /Didn't catch that/);
    assert.equal(getFlow(store).awaiting, 'date');
  });
});

describe('wizard time step', () => {
  it('valid time resolves to an absolute departure and enters results', () => {
    const store = createConversationStore();
    atDateStep(store);
    reply(continueRoute('tomorrow', U, getFlow(store), store, NOW));
    const out = continueRoute('17:00', U, getFlow(store), store, NOW);
    assert.equal(out.kind, 'results');
    if (out.kind !== 'results') return;
    assert.equal(out.isNow, false);
    // 2026-06-23 17:00 Asia/Jerusalem (IDT) = 14:00Z.
    assert.equal(out.when.getTime(), Date.UTC(2026, 5, 23, 14, 0, 0));
  });

  it('invalid time re-asks and stays on the time step', () => {
    const store = createConversationStore();
    atDateStep(store);
    reply(continueRoute('tomorrow', U, getFlow(store), store, NOW));
    const out = continueRoute('25:00', U, getFlow(store), store, NOW);
    assert.match(reply(out), /not a valid time/);
    assert.equal(getFlow(store).awaiting, 'time');
  });

  it('"back" returns to the date step', () => {
    const store = createConversationStore();
    atDateStep(store);
    reply(continueRoute('tomorrow', U, getFlow(store), store, NOW));
    const out = continueRoute('back', U, getFlow(store), store, NOW);
    assert.match(reply(out), /^When\?/);
    assert.equal(getFlow(store).awaiting, 'date');
  });
});

describe('wizard results follow-ups (carry-over §8.3)', () => {
  /** Drive to a results state at tomorrow 17:00. */
  function atResults(store: ConversationStore): void {
    atDateStep(store);
    reply(continueRoute('tomorrow', U, getFlow(store), store, NOW));
    const out = continueRoute('17:00', U, getFlow(store), store, NOW);
    assert.equal(out.kind, 'results');
  }

  it('a lone time keeps the last date', () => {
    const store = createConversationStore();
    atResults(store);
    const out = continueRoute('12:00', U, getFlow(store), store, NOW);
    assert.equal(out.kind, 'results');
    if (out.kind !== 'results') return;
    // Still 23 Jun, now at 12:00 (09:00Z).
    assert.equal(out.when.getTime(), Date.UTC(2026, 5, 23, 9, 0, 0));
  });

  it('a lone date keeps the last time', () => {
    const store = createConversationStore();
    atResults(store);
    const out = continueRoute('today', U, getFlow(store), store, NOW);
    assert.equal(out.kind, 'results');
    if (out.kind !== 'results') return;
    // Today (22 Jun) carrying 17:00 (14:00Z).
    assert.equal(out.when.getTime(), Date.UTC(2026, 5, 22, 14, 0, 0));
  });

  it('a new route resets all slots and re-asks the date', () => {
    const store = createConversationStore();
    atResults(store);
    const out = continueRoute('TLV to afula', U, getFlow(store), store, NOW);
    // New route needs origin disambiguation (TLV → menu), so it replies first.
    assert.equal(out.kind, 'reply');
    const f = getFlow(store);
    assert.equal(f.awaiting, 'origin');
    assert.equal(f.slotDate, undefined);
    assert.equal(f.slotTime, undefined);
  });
});

describe('wizard cancel / restart', () => {
  it('"cancel" drops the flow with a friendly message', () => {
    const store = createConversationStore();
    atDateStep(store);
    const out = continueRoute('cancel', U, getFlow(store), store, NOW);
    assert.match(reply(out), /Cancelled\. Send a route/);
    assert.equal(store.get(U), undefined);
  });

  it('a new "X to Y" mid-wizard resets cleanly', () => {
    const store = createConversationStore();
    atDateStep(store);
    reply(continueRoute('tomorrow', U, getFlow(store), store, NOW)); // now on the time step
    const out = continueRoute('בנימינה אל נהריה', U, getFlow(store), store, NOW);
    // Resolves one-shot back to a fresh date step.
    expectDateStep(out, store, { fromId: 2800, toId: 1600, label: 'Binyamina → Nahariya' });
  });
});

// ---------------------------------------------------------------------------
// Refresh — re-run the last resolved route (issue #15)
// ---------------------------------------------------------------------------

describe('wizard refresh', () => {
  const TRIGGERS = ['refresh', 'again', 'רענן', 'שוב', 'עוד פעם'];

  /** Drive to a results state at tomorrow (23 Jun) 17:00 — a clock query. */
  function atClockResults(store: ConversationStore): void {
    atDateStep(store);
    reply(continueRoute('tomorrow', U, getFlow(store), store, NOW));
    assert.equal(continueRoute('17:00', U, getFlow(store), store, NOW).kind, 'results');
  }

  it('replays the exact clock datetime on refresh', () => {
    const store = createConversationStore();
    atClockResults(store);
    const out = continueRoute('refresh', U, getFlow(store), store, NOW);
    assert.equal(out.kind, 'results');
    if (out.kind !== 'results') return;
    assert.equal(out.isNow, false);
    assert.equal(out.when.getTime(), Date.UTC(2026, 5, 23, 14, 0, 0)); // 23 Jun 17:00 IDT
    assert.equal(out.label, 'Binyamina → Nahariya');
    assert.equal(getFlow(store).awaiting, 'results');
  });

  it('recognises every trigger word (EN/HE + mixed case) in results state', () => {
    for (const word of [...TRIGGERS, 'ReFrEsh']) {
      const store = createConversationStore();
      atClockResults(store);
      assert.equal(continueRoute(word, U, getFlow(store), store, NOW).kind, 'results', word);
    }
  });

  it('re-resolves a "now" query to the current moment on refresh', () => {
    const store = createConversationStore();
    atDateStep(store);
    const first = continueRoute('now', U, getFlow(store), store, NOW);
    assert.equal(first.kind, 'results');
    if (first.kind !== 'results') return;
    assert.equal(first.when.getTime(), NOW.getTime());
    // 6 minutes pass; refresh must return the trains from the new "now".
    const later = new Date(NOW.getTime() + 6 * 60_000);
    const out = continueRoute('עוד פעם', U, getFlow(store), store, later);
    assert.equal(out.kind, 'results');
    if (out.kind !== 'results') return;
    assert.equal(out.isNow, true);
    assert.equal(out.when.getTime(), later.getTime());
  });

  it('re-stamps the 10-min TTL on refresh', () => {
    let clock = 0;
    const store = createConversationStore({ now: () => clock });
    atClockResults(store); // stamped expiresAt = 600_000
    clock = 599_000; // still alive
    assert.equal(continueRoute('refresh', U, getFlow(store), store, NOW).kind, 'results');
    clock = 605_000; // past the ORIGINAL expiry, within the refreshed window
    assert.notEqual(store.get(U), undefined); // survived → TTL was reset
  });

  it('refresh while picking a station says to finish the route first', () => {
    const store = createConversationStore();
    reply(beginRoute('TLV to afula', U, store)); // origin disambiguation menu
    assert.equal(getFlow(store).awaiting, 'origin');
    const out = continueRoute('רענן', U, getFlow(store), store, NOW);
    assert.match(reply(out), /finish choosing/i);
    // The flow is preserved so the user can still pick.
    const f = getFlow(store);
    assert.equal(f.awaiting, 'origin');
    assert.deepEqual(f.candidates, ['3700', '4600', '3600', '4900']);
  });

  it('refresh at the date step is also not-ready (two-bucket model)', () => {
    const store = createConversationStore();
    atDateStep(store);
    const out = continueRoute('refresh', U, getFlow(store), store, NOW);
    assert.match(reply(out), /finish choosing/i);
    assert.equal(getFlow(store).awaiting, 'date');
  });
});

describe('isRefreshWord', () => {
  it('recognises every trigger (EN/HE/mixed case/padded) and nothing else', () => {
    for (const w of ['refresh', 'again', 'רענן', 'שוב', 'עוד פעם', 'ReFrEsh', '  refresh  ']) {
      assert.equal(isRefreshWord(w), true, w);
    }
    for (const w of ['refreshed', 'haifa', '', 'to afula']) {
      assert.equal(isRefreshWord(w), false, w);
    }
  });
});
