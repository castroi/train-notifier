/**
 * Custom-route orchestrator (custom-route-spec.md §7–§10).
 *
 * Lives at src root (like pipeline.ts) because it bridges the bot module
 * (conversation state, templates) and the rail module (matcher, stations).
 *
 * Responsibilities:
 *   - Split a route on separators (HE `אל`, EN `to` / `from … to …`).
 *   - Resolve each half via matchStation, driving a multi-turn dialog through
 *     the conversation store (accept / confirm / menu / not-found).
 *   - Clarify reserved route-words used as a route half (§8).
 *   - Reject source == destination (§10 / G4).
 *
 * It does NOT fetch trains: a fully resolved route is returned as
 * { kind: 'resolved', fromId, toId, label } for the pipeline to fetch (count 5)
 * and format.
 */

import type { ConversationStore, PendingFlow } from './bot/conversation.ts';
import { combine, type DateSlot, describeDay, resolveDate, resolveTime } from './bot/datetime.ts';
import { normalize } from './bot/normalize.ts';
import {
  askDate,
  askTime,
  badDate,
  badTime,
  customAskRoute,
  customCancelled,
  customClarifyReserved,
  customConfirm,
  customMenu,
  customNotFound,
  customSameStation,
  customTooBroad,
  resultsNudge,
} from './bot/templates.ts';
import { matchStation } from './rail/match.ts';
import { stationName } from './rail/stations.ts';

export type RouteOutcome =
  | { kind: 'reply'; text: string }
  // A fully-resolved route + departure datetime; the pipeline fetches & formats.
  // `isNow` selects the day-only header (the "now" fast path skips the time).
  | { kind: 'results'; fromId: number; toId: number; label: string; when: Date; isNow: boolean }
  | { kind: 'breakout'; text: string }; // reserved/control word during a flow → run core path

type Role = 'origin' | 'destination';

// ---------------------------------------------------------------------------
// Word sets (reserved route-words mirror config.yaml aliases)
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return normalize(s).trim();
}

// Word-set members are stored in normalized form so they compare equal to the
// normalized input. This matters for Hebrew words whose final letter forms are
// rewritten by normalize() — e.g. כן ("yes") normalizes to כנ.
function wordSet(...words: string[]): Set<string> {
  return new Set(words.map(norm));
}

const RESERVED = wordSet('home', 'work', 'בית', 'עבודה');
const CONTROL = wordSet('menu', 'help', 'תפריט', 'עזרה');
const CANCEL = wordSet('0', 'cancel', 'x', 'ביטול');
const BACK = wordSet('back'); // wizard: return to the previous step (§4.6)
const YES = wordSet('yes', 'y', 'כן');
const NO = wordSet('no', 'n', 'לא');

// ---------------------------------------------------------------------------
// Station labels — bilingual for menus, EN-only for report headers (the Hebrew
// label's RTL rendering flips the "→" arrow).
// ---------------------------------------------------------------------------

function labelBi(id: string): string {
  const en = stationName(id, 'english') ?? id;
  const he = stationName(id, 'hebrew');
  return he ? `${en}  (${he})` : en;
}

function labelEn(id: string): string {
  return stationName(id, 'english') ?? id;
}

// ---------------------------------------------------------------------------
// Route splitting
// ---------------------------------------------------------------------------

interface SplitRoute {
  origin: string;
  dest: string;
}

function splitRoute(text: string): SplitRoute | null {
  const t = text.trim();

  // Hebrew: "X אל Y" (אל as a standalone token)
  const he = t.split(/\s+אל\s+/);
  if (he.length === 2 && he[0].trim() && he[1].trim()) {
    return { origin: he[0].trim(), dest: he[1].trim() };
  }

  // English: "from X to Y" or "X to Y"
  const en = t.replace(/^from\s+/i, '').split(/\s+to\s+/i);
  if (en.length === 2 && en[0].trim() && en[1].trim()) {
    return { origin: en[0].trim(), dest: en[1].trim() };
  }

  return null;
}

/** Directional "to Y" / "אל Y" (origin omitted). Returns the destination text. */
function directionalDest(text: string): string | null {
  const t = text.trim();
  const he = t.match(/^אל\s+(.+)/);
  if (he) return he[1].trim();
  const en = t.match(/^to\s+(.+)/i);
  if (en) return en[1].trim();
  return null;
}

/** True when the message looks like a custom route (separator or directional). */
export function hasRouteSeparator(text: string): boolean {
  return splitRoute(text) !== null || directionalDest(text) !== null;
}

// ---------------------------------------------------------------------------
// Flow context carried between turns
// ---------------------------------------------------------------------------

interface Ctx {
  origin?: string; // resolved origin id (present when resolving destination)
  destText?: string; // raw destination text awaiting processing
}

function saveFlow(
  sender: string,
  store: ConversationStore,
  partial: Omit<PendingFlow, 'sender' | 'expiresAt' | 'candidates'> & { candidates?: string[] },
): void {
  store.set({ sender, candidates: [], ...partial });
}

// ---------------------------------------------------------------------------
// Half resolution
// ---------------------------------------------------------------------------

function applyMatch(
  text: string,
  role: Role,
  ctx: Ctx,
  sender: string,
  store: ConversationStore,
): RouteOutcome {
  // Reserved route-word used as a route half → clarify, never expand (§8).
  if (RESERVED.has(norm(text))) {
    store.clear(sender);
    return { kind: 'reply', text: customClarifyReserved(text.trim()) };
  }

  const m = matchStation(text);

  switch (m.action) {
    case 'accept':
      return resolveRole(role, m.stationId, ctx, sender, store);

    case 'confirm':
      saveFlow(sender, store, {
        awaiting: 'confirm',
        confirmTarget: m.stationId,
        confirmRole: role,
        origin: ctx.origin,
        destText: ctx.destText,
      });
      return { kind: 'reply', text: customConfirm(labelBi(m.stationId), role) };

    case 'menu':
      saveFlow(sender, store, {
        awaiting: role,
        candidates: m.candidates,
        origin: ctx.origin,
        destText: ctx.destText,
      });
      return {
        kind: 'reply',
        text: customMenu(`Which ${role}?`, m.candidates.map(labelBi)),
      };

    case 'too_broad':
      // Stay in the flow, awaiting fresh free text for this half.
      saveFlow(sender, store, { awaiting: role, origin: ctx.origin, destText: ctx.destText });
      return { kind: 'reply', text: customTooBroad() };

    case 'not_found':
      saveFlow(sender, store, {
        awaiting: role,
        candidates: m.suggestions,
        origin: ctx.origin,
        destText: ctx.destText,
      });
      return { kind: 'reply', text: customNotFound(m.suggestions.map(labelBi)) };
  }
}

function resolveRole(
  role: Role,
  id: string,
  ctx: Ctx,
  sender: string,
  store: ConversationStore,
): RouteOutcome {
  if (role === 'origin') {
    if (ctx.destText !== undefined) {
      // Origin pinned; now resolve the stashed destination.
      return applyMatch(ctx.destText, 'destination', { origin: id }, sender, store);
    }
    // Origin-only entry — ask where to.
    saveFlow(sender, store, { awaiting: 'destination', origin: id });
    return { kind: 'reply', text: `From ${labelEn(id)} — where to?` };
  }

  // role === 'destination' — origin is always pinned before a destination is
  // resolved (every awaiting:'destination' flow carries an origin), so a missing
  // origin here is an internal invariant violation, not a user-reachable state.
  const originId = ctx.origin;
  if (originId === undefined) {
    throw new Error('resolveRole: destination resolved without an origin');
  }
  if (originId === id) {
    store.clear(sender);
    return { kind: 'reply', text: customSameStation() };
  }
  // Route is resolved — hand off to the wizard's date step rather than fetching
  // immediately (the slots persist for the date/time/results follow-ups, §4.1).
  saveFlow(sender, store, {
    awaiting: 'date',
    originId: Number(originId),
    destId: Number(id),
    routeLabel: `${labelEn(originId)} → ${labelEn(id)}`,
  });
  return { kind: 'reply', text: askDate() };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Enter custom mode from the menu's "0 — Other route". */
export function enterCustomMode(sender: string, store: ConversationStore): RouteOutcome {
  saveFlow(sender, store, { awaiting: 'route' });
  return { kind: 'reply', text: customAskRoute() };
}

/** Start a fresh custom route from free text (separator, directional, or bare origin). */
export function beginRoute(text: string, sender: string, store: ConversationStore): RouteOutcome {
  const split = splitRoute(text);
  if (split) {
    return applyMatch(split.origin, 'origin', { destText: split.dest }, sender, store);
  }

  const dest = directionalDest(text);
  if (dest !== null) {
    // Origin omitted — stash destination, ask for origin (no recents in v1).
    saveFlow(sender, store, { awaiting: 'origin', destText: dest });
    return { kind: 'reply', text: 'Where from? Send the origin station.' };
  }

  // Bare text — treat as origin only.
  return applyMatch(text, 'origin', {}, sender, store);
}

/** Continue an in-progress flow with the user's reply. */
export function continueRoute(
  text: string,
  sender: string,
  flow: PendingFlow,
  store: ConversationStore,
  now: Date = new Date(),
): RouteOutcome {
  const n = norm(text);

  // Breakout / cancel (§9): control words win over any pending step.
  if (CANCEL.has(n)) {
    store.clear(sender);
    return { kind: 'reply', text: customCancelled() };
  }
  if (RESERVED.has(n) || CONTROL.has(n)) {
    store.clear(sender);
    return { kind: 'breakout', text };
  }

  switch (flow.awaiting) {
    case 'route':
      return beginRoute(text, sender, store);

    case 'date':
      return handleDate(text, sender, flow, store, now);

    case 'time':
      return handleTime(text, sender, flow, store, now);

    case 'results':
      return handleResults(text, sender, flow, store, now);

    case 'confirm': {
      const ctx: Ctx = { origin: flow.origin, destText: flow.destText };
      const role = flow.confirmRole ?? 'origin';
      // confirmTarget is always set when awaiting 'confirm' (see applyMatch).
      const target = flow.confirmTarget;
      if (target === undefined) {
        throw new Error('continueRoute: confirm flow without a confirmTarget');
      }
      // '1'/'2' are the primary (keyboard-neutral) answers; words are fallbacks.
      // No collision with menu numbering: a 'confirm' flow never carries
      // candidates, and menu picks are handled in the 'origin'/'destination'
      // case — the two are mutually exclusive on flow.awaiting.
      if (n === '1' || YES.has(n)) {
        return resolveRole(role, target, ctx, sender, store);
      }
      if (n === '2' || NO.has(n)) {
        saveFlow(sender, store, {
          awaiting: role,
          origin: flow.origin,
          destText: flow.destText,
        });
        return { kind: 'reply', text: `Okay — send the ${role} again.` };
      }
      // Unrecognised — re-ask.
      return { kind: 'reply', text: customConfirm(labelBi(target), role) };
    }

    case 'origin':
    case 'destination': {
      const role = flow.awaiting;
      const ctx: Ctx = { origin: flow.origin, destText: flow.destText };

      if (flow.candidates.length > 0) {
        const pick = Number.parseInt(text.trim(), 10);
        if (Number.isInteger(pick) && pick >= 1 && pick <= flow.candidates.length) {
          return resolveRole(role, flow.candidates[pick - 1], ctx, sender, store);
        }
        return {
          kind: 'reply',
          text: `Reply with a number 1–${flow.candidates.length} (0 to cancel).`,
        };
      }

      // Free text for this half.
      if (role === 'origin') {
        return applyMatch(text, 'origin', { destText: flow.destText }, sender, store);
      }
      return applyMatch(text, 'destination', { origin: flow.origin }, sender, store);
    }
  }
}

// ---------------------------------------------------------------------------
// Wizard steps (plan §4.3–§4.5). The route is already resolved; these fill the
// date/time slots and emit a `results` outcome for the pipeline to fetch.
// ---------------------------------------------------------------------------

/** The resolved-route slots carried through every wizard step. */
function routeSlots(flow: PendingFlow): { originId: number; destId: number; routeLabel: string } {
  if (flow.originId === undefined || flow.destId === undefined || flow.routeLabel === undefined) {
    throw new Error('wizard step reached without a resolved route');
  }
  return { originId: flow.originId, destId: flow.destId, routeLabel: flow.routeLabel };
}

function results(
  slots: { originId: number; destId: number; routeLabel: string },
  when: Date,
  isNow: boolean,
): RouteOutcome {
  return {
    kind: 'results',
    fromId: slots.originId,
    toId: slots.destId,
    label: slots.routeLabel,
    when,
    isNow,
  };
}

/** A concrete calendar date for carry-over: the stored date, else today. */
function carryDate(flow: PendingFlow, now: Date): DateSlot {
  if (flow.slotDate?.kind === 'date') return flow.slotDate;
  return resolveDate('today', now) as DateSlot; // 'today' always yields a date
}

function handleDate(
  text: string,
  sender: string,
  flow: PendingFlow,
  store: ConversationStore,
  now: Date,
): RouteOutcome {
  // A fresh "X to Y" mid-flow resets everything (§4.6).
  if (hasRouteSeparator(text)) {
    store.clear(sender);
    return beginRoute(text, sender, store);
  }
  if (BACK.has(norm(text))) {
    // The step before the date is the route entry — re-ask for a route.
    saveFlow(sender, store, { awaiting: 'route' });
    return { kind: 'reply', text: customAskRoute() };
  }
  const slots = routeSlots(flow);
  const date = resolveDate(text, now);
  if (date === null) {
    return { kind: 'reply', text: badDate() }; // stay on the step (§6.2)
  }
  if (date.kind === 'now') {
    // "now" sets date+time to now and skips the time step entirely (§4.3).
    saveFlow(sender, store, {
      awaiting: 'results',
      ...slots,
      slotDate: date,
      slotTime: { kind: 'now' },
    });
    return results(slots, now, true);
  }
  saveFlow(sender, store, { awaiting: 'time', ...slots, slotDate: date });
  return { kind: 'reply', text: askTime(describeDay(date, now)) };
}

function handleTime(
  text: string,
  sender: string,
  flow: PendingFlow,
  store: ConversationStore,
  now: Date,
): RouteOutcome {
  if (hasRouteSeparator(text)) {
    store.clear(sender);
    return beginRoute(text, sender, store);
  }
  const slots = routeSlots(flow);
  if (BACK.has(norm(text))) {
    saveFlow(sender, store, { awaiting: 'date', ...slots });
    return { kind: 'reply', text: askDate() };
  }
  const time = resolveTime(text);
  if (time === null) {
    return { kind: 'reply', text: badTime() }; // stay on the step (§6.2)
  }
  const date = carryDate(flow, now); // slotDate is set at the date step
  saveFlow(sender, store, { awaiting: 'results', ...slots, slotDate: date, slotTime: time });
  return results(slots, combine(date, time, now), false);
}

function handleResults(
  text: string,
  sender: string,
  flow: PendingFlow,
  store: ConversationStore,
  now: Date,
): RouteOutcome {
  // A new route wipes every slot and starts a fresh flow (§8.3).
  if (hasRouteSeparator(text)) {
    store.clear(sender);
    return beginRoute(text, sender, store);
  }
  const slots = routeSlots(flow);

  // Lone date → keep the last time (or "now" if the last query was a now-query).
  const date = resolveDate(text, now);
  if (date !== null) {
    const time = flow.slotTime ?? { kind: 'now' };
    saveFlow(sender, store, { awaiting: 'results', ...slots, slotDate: date, slotTime: time });
    return results(slots, combine(date, time, now), date.kind === 'now');
  }

  // Lone time → keep the last date.
  const time = resolveTime(text);
  if (time !== null) {
    const date2 = carryDate(flow, now);
    saveFlow(sender, store, { awaiting: 'results', ...slots, slotDate: date2, slotTime: time });
    return results(slots, combine(date2, time, now), false);
  }

  // Unrecognised — nudge again (§4.5).
  return { kind: 'reply', text: resultsNudge() };
}
