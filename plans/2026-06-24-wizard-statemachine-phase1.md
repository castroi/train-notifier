# Guided Date/Time Wizard — Phase 1 Implementation Plan

**Goal:** Add a guided multi-turn wizard (Route → Date → Time → Results) so the owner can request a custom route for a future departure through bounded prompts.

**Architecture:** Extend the existing custom-route flow rather than fork it. `route.ts` already resolves `X to Y` (with disambiguation) and hands the pipeline a terminal `resolved` outcome; the wizard intercepts that step so a resolved route enters `AWAIT_DATE` instead of fetching "next 5 from now". Date/time tokens resolve through a new standalone `datetime.ts` to an absolute `Asia/Jerusalem` `Date`, which feeds the already-existing `fetchRoutes(…, when)` parameter.

**Key decisions:**
- **Phase 1 only.** The one-liner fast path (`Afula to Akko tomorrow 17:00`, README example 3) is out of scope — it needs `matchStation` to report a match span (`match.ts` returns ids only). Deferred to Phase 2.
- **Extend, don't fork.** Reuse `ConversationStore`, the disambiguation menu, and the `back`/`cancel`/breakout handling already in `continueRoute`. No second state machine.
- **Standalone datetime resolver** (`bot/datetime.ts`) per spec §9.3 — the seam Phase 2 reuses unchanged.
- **TTL 10 min** (`120s → 600s`) per spec §7.2 / example 8.
- **Keep per-sender keying** in the store — a strict superset of the plan's single-owner slot; already supports allowlisted friends.

**In scope (README example traces):** 1 (now skips time), 2 (full wizard + carry-over), 4 (disambiguation → date step), 5 (validation re-asks), 6 (back/cancel/restart), 7 (no-trains rollover), 8 (TTL).
**Out of scope:** 3 (one-liner, EN + HE) → Phase 2.

---

## Tasks

### Task 1: Standalone datetime resolver

**Independent:** Yes
**Estimated scope:** Small (2 files)

**Files:**
- Create: `src/bot/datetime.ts`
- Test: `src/bot/datetime.test.ts`

**API:**
```typescript
export type DateSlot = { kind: 'now' } | { kind: 'date'; y: number; m: number; d: number };
export type TimeSlot = { kind: 'now' } | { kind: 'hm'; hh: number; mm: number };

// Returns null on invalid input (caller re-asks).
export function resolveDate(token: string, now: Date): DateSlot | null;
export function resolveTime(token: string): TimeSlot | null;

// Combine a resolved date + time into an absolute local epoch.
// Process runs TZ=Asia/Jerusalem (see format.ts:71), so new Date(y, m-1, d, hh, mm)
// is the correct local wall-clock epoch. `now` is used when either slot is 'now'.
export function combine(date: DateSlot, time: TimeSlot, now: Date): Date;
```

**Accepted tokens (spec §5.3 / §5.4):**
- Date: `now`, `today`, `tomorrow`, `D/M`, `D/M/YYYY`. Weekday words (`sunday`/`ראשון`) are **rejected** (Phase 2). `D/M` with no year → current year.
- Time: `now`, `HH:MM`, bare `H`/`HH` (24h, `:00`). No AM/PM. Reject hour > 23 / minute > 59 (e.g. `25:00`).

**Steps:**
1. Write `datetime.test.ts` covering: each date keyword, `17/09`, `17/09/2027`, invalid `banana`; each time form (`now`, `7`, `19`, `12:30`, `17:00`), invalid `25:00`, `banana`; `combine` for now-date (uses `now`), date+`now`-time (date wall-clock + current HH:MM), date+HH:MM. Use a fixed `now` and assert on the Jerusalem-local epoch.
2. Run: `npm test -- src/bot/datetime.test.ts` → Expect: FAIL (module missing).
3. Implement the three functions. Normalize the token with `normalize()` before matching keywords so Hebrew/whitespace behave consistently.
4. Run: `npm test -- src/bot/datetime.test.ts` → Expect: PASS.

**Verification:** `npm test -- src/bot/datetime.test.ts`
**Acceptance criteria:**
- [ ] All listed token forms resolve / reject correctly.
- [ ] `combine` returns the correct absolute epoch for now / day-only / day+time.
- [ ] No I/O, no dependency on the conversation store (Phase-2 reusable).

---

### Task 2: Slots, states, and TTL in the conversation store

**Independent:** Yes
**Estimated scope:** Small (2 files)

**Files:**
- Modify: `src/bot/conversation.ts`
- Modify: `src/bot/conversation.test.ts`

**Steps:**
1. Extend `PendingFlow.awaiting` union with `'date' | 'time' | 'results'`.
2. Add wizard slots: `originId?: number`, `destId?: number`, `routeLabel?: string`, `slotDate?: DateSlot`, `slotTime?: TimeSlot` (import the slot types from `datetime.ts`).
3. Change `DEFAULT_TTL_MS` from `120_000` to `600_000` (10 min, spec §7.2).
4. Update/extend `conversation.test.ts`: assert a `'date'`-awaiting flow with slots round-trips through `set`/`get`, and that a flow stamped just before 600s is still live and just after is evicted.

**Verification:** `npm test -- src/bot/conversation.test.ts`
**Acceptance criteria:**
- [ ] New `awaiting` states and slot fields type-check and persist.
- [ ] TTL is 600s; expiry eviction still works.

---

### Task 3: Wizard transitions in the route orchestrator

**Independent:** No — depends on Tasks 1, 2.
**Estimated scope:** Medium (2 files)

**Files:**
- Modify: `src/route.ts`
- Modify: `src/route.test.ts`

**Steps:**
1. Add a new outcome to `RouteOutcome`:
   ```typescript
   | { kind: 'results'; fromId: number; toId: number; label: string; when: Date; isNow: boolean }
   ```
2. In `resolveRole`, the destination branch no longer returns `{kind:'resolved'}`. Instead, save `awaiting:'date'` with slots `{originId, destId, routeLabel: label}` and return `{kind:'reply', text: askDate()}`. (`enterCustomMode`/`beginRoute` entry and all disambiguation stay unchanged — example 4: disambiguation falls through to the date step naturally.)
3. Add `continueRoute` cases:
   - **`'date'`**: `resolveDate(text, now)`.
     - `now` → set `slotDate=now, slotTime=now`; save `awaiting:'results'`; return `{kind:'results', when: now, isNow: true, …}` (skips time, spec §4.3 / example 1).
     - day-only (`today`/`tomorrow`/explicit) → save `awaiting:'time'` with `slotDate`; return `{kind:'reply', text: askTime()}`.
     - `back` → re-ask the route entry (`{kind:'reply', text: customAskRoute()}`, keep flow at the route step) (spec §4.6 / example 6).
     - invalid → `{kind:'reply', text: badDate()}`, stay on step (example 5).
   - **`'time'`**: `resolveTime(text)`.
     - valid (`now` / `HH:MM` / bare hour) → `when = combine(slotDate, timeSlot, now)`; save `awaiting:'results'`; return `{kind:'results', when, isNow:false, …}`.
     - `back` → save `awaiting:'date'`; return `{kind:'reply', text: askDate()}` (example 6).
     - invalid → `{kind:'reply', text: badTime()}`, stay (example 5).
   - **`'results'`** (follow-ups, spec §4.5 / §8.3):
     - `hasRouteSeparator(text)` → reset slots, `beginRoute(text, …)` (new route wipes slots — example 2 / §6 mid-flow restart).
     - else `resolveDate(text, now)` succeeds and is **not** a bare hour → lone date: keep `slotTime`, update `slotDate`, re-query (example 2: `today` keeps `12:00`).
     - else `resolveTime(text)` succeeds → lone time: keep `slotDate`, update `slotTime`, re-query (example 2: `12:00` keeps `Tue 23`).
     - else → `{kind:'reply', text: resultsNudge()}`.
4. Precedence note for `results`: a bare integer (`8`) is a **time** (§5.4); explicit dates need a `/` or a keyword (`today`/`tomorrow`) — so date vs time never collide. Resolve route-separator first, then date-keyword/`D/M`, then time.
5. `back`/`cancel`/breakout: `CANCEL`/`RESERVED`/`CONTROL` checks at the top of `continueRoute` already cover `cancel`; add `back` handling per-state above. `cancel` → `customCancelled()` (example 6).
6. Extend `route.test.ts` with transition-level tests for each case above (drive `continueRoute` directly with a stubbed store, assert outcome kind + saved `awaiting`).

**Verification:** `npm test -- src/route.test.ts`
**Acceptance criteria:**
- [ ] `now` at date step yields a `results` outcome with `isNow:true` and skips time.
- [ ] Day-only date → time step; valid time → `results` with correct `when`.
- [ ] Carry-over: lone time keeps date, lone date keeps time.
- [ ] `back` returns to the prior step; `cancel` clears; mid-flow `X to Y` resets.
- [ ] Invalid date/time re-ask and stay on step.

---

### Task 4: Templates — prompts, header echo, rollover wording

**Independent:** No — depends on Task 1 (slot types for the header).
**Estimated scope:** Small (2 files)

**Files:**
- Modify: `src/bot/templates.ts`
- Modify: `src/bot/templates.test.ts`

**Steps:**
1. Add prompt builders:
   - `askDate()` → `"When?\n now / today / tomorrow / custom date (like 17/09)"`
   - `askTime()` → `"When tomorrow?\n now / custom time (like 7, 19, 12:30)"` (wording per examples; "tomorrow" is illustrative — keep it generic: `"When?\n now / custom time (like 7, 19, 12:30)"`, or interpolate the chosen day — confirm against example 2 which shows "When tomorrow?").
   - `badDate()` → `"Didn't catch that. Type one of: now / today / tomorrow / a date like 17/09"`
   - `badTime()` → `"That's not a valid time. Type a time like 7:00, 19, or 12:30"`
   - `resultsNudge()` → `"Different date/time, or a new route?"`
2. Add a datetime header builder `wizardHeader(label: string, when: Date, isNow: boolean): string`:
   - now / day-only → `"<label> · Today 22 Jun:"` / `"<label> · Tue 23 Jun:"`
   - with time → `"<label> · Tue 23 Jun, 17:00:"`
   - "Today"/"Tomorrow" substitute for the weekday when `when` is the current / next Jerusalem day.
3. Add `wizardReport(label, lines, when, isNow)` = header + bulleted lines + `"\n" + resultsNudge()` (combines the report and the follow-up nudge into one message — examples render two bubbles; one send is acceptable, flag if two are required).
4. Add `wizardRollover(label, lines, when)` for example 7: `"No more trains today for <label>. Next service:\n<header>\n<bullets>"`.
5. Extend `templates.test.ts` for header forms (now / day-only / day+time) and the rollover string.

**Verification:** `npm test -- src/bot/templates.test.ts`
**Acceptance criteria:**
- [ ] Header renders `Today DD Mon`, `Wkd DD Mon`, and `Wkd DD Mon, HH:MM` correctly.
- [ ] Rollover wording matches example 7.

---

### Task 5: Pipeline dispatch + end-to-end example traces

**Independent:** No — depends on Tasks 1–4.
**Estimated scope:** Medium (2 files)

**Files:**
- Modify: `src/pipeline.ts`
- Modify: `src/pipeline.test.ts`

**Steps:**
1. In `dispatchCustom`, handle the new `outcome.kind === 'results'`:
   - Fetch `CUSTOM_ROUTE_COUNT` trains at `outcome.when` via `withDeadline` (same discipline as the current `resolved` path).
   - If `lines.length === 0` → `customNoTrains` (existing).
   - Else if the first train's `dayNote` indicates it rolled past the queried day (no service left that day, example 7) → `wizardRollover(...)`.
   - Else → `wizardReport(outcome.label, lines, outcome.when, outcome.isNow)`.
   - Record counters as today (`CUSTOM_KEY`, success/fail).
2. Remove (or keep dormant) the old `resolved` branch — `route.ts` no longer emits `resolved`; the wizard path replaces it. Confirm no other caller depends on `resolved`.
3. The flow stays in `awaiting:'results'` (saved by `route.ts`), so the next message is routed back through `continueRoute` — no pipeline change needed for follow-ups beyond the existing `store.get(sender)` branch.
4. Add end-to-end traces to `pipeline.test.ts` for examples 1, 2, 4, 5, 6, 7, 8: feed the message sequence through `handleMessage` with a stubbed `fetchRoutes`/`send`/`now`, and assert the ordered `send` payloads.

**Verification:** `npm test -- src/pipeline.test.ts`
**Acceptance criteria:**
- [ ] Example 1 (now skips time), 2 (carry-over), 4 (disambiguation → date), 5 (validation), 6 (back/cancel/restart), 7 (rollover), 8 (TTL) all pass as ordered-send assertions.
- [ ] Existing on-demand / config-route / eager-greeting tests unchanged.

---

## Dependency Graph

```
Task 1 (datetime)      ──┐
                         ├──► Task 3 (route) ──┐
Task 2 (store/TTL)     ──┘                     ├──► Task 5 (pipeline + E2E)
Task 1 ──► Task 4 (templates) ─────────────────┘
```

**Parallelizable:** Tasks 1, 2.
**Sequential:** Task 4 after 1; Task 3 after 1+2; Task 5 after 3+4.

---

## Verification Summary

| Task | Verification Command | Expected |
| --- | --- | --- |
| 1 | `npm test -- src/bot/datetime.test.ts` | All pass |
| 2 | `npm test -- src/bot/conversation.test.ts` | All pass |
| 3 | `npm test -- src/route.test.ts` | All pass |
| 4 | `npm test -- src/bot/templates.test.ts` | All pass |
| 5 | `npm test -- src/pipeline.test.ts` | All pass |
| all | `npm run typecheck && npm test` | Exit 0, all pass |

---

## Open items carried from the spec (decided for this build)

- **§10.1** weekday words — **deferred** to Phase 2 (rejected by the date prompt).
- **§10.2** TTL — **10 min**.
- **§10.3** `now` one-tap default — listed first in the date prompt; no separate quick-reply.
- **§10.4** disambiguation ordering — reuse `matchStation`'s existing deterministic candidate order.
- **§10.5** absolute datetimes in `Asia/Jerusalem` — confirmed: `combine` builds local epochs, `fetchRoutes` formats `date`/`hour` in `Asia/Jerusalem` (`client.ts:69`).
