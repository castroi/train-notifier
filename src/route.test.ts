import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ConversationStore, createConversationStore } from './bot/conversation.ts';
import { beginRoute, continueRoute, enterCustomMode, hasRouteSeparator } from './route.ts';

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
  it('בנימינה אל נהריה → resolved 2800 → 1600', () => {
    const store = createConversationStore();
    const out = beginRoute('בנימינה אל נהריה', U, store);
    assert.deepEqual(out, {
      kind: 'resolved',
      fromId: 2800,
      toId: 1600,
      label: 'Binyamina → Nahariya',
    });
    assert.equal(store.get(U), undefined); // flow cleared on resolve
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
    assert.deepEqual(done, {
      kind: 'resolved',
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
    assert.equal(done.kind, 'resolved');
    if (done.kind !== 'resolved') return;
    assert.equal(done.fromId, 9100);
    assert.equal(done.toId, 2300);
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
    assert.equal(done.kind, 'resolved');
    if (done.kind !== 'resolved') return;
    assert.equal(done.fromId, 8600);
    assert.equal(done.toId, 2100);
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
    assert.deepEqual(done, {
      kind: 'resolved',
      fromId: 1600,
      toId: 1840,
      label: 'Nahariya → Karmiel',
    });
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
    assert.deepEqual(done, {
      kind: 'resolved',
      fromId: 2800,
      toId: 1260,
      label: 'Binyamina → Afula R.Eitan',
    });
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
    assert.equal(done.kind, 'resolved');
    if (done.kind !== 'resolved') return;
    assert.equal(done.fromId, 9100);
    assert.equal(done.toId, 2100);
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
