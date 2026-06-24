# Refresh — re-run the last route (issue #15)

**Goal:** Let the owner re-fetch fresh trains for their last *resolved* route by sending a refresh word (`refresh`/`again`/`רענן`/`שוב`/`עוד פעם`) — no retyping — reusing the existing wizard slot object + 10-min TTL.

**Architecture:** Refresh is a new intercept at the top of `continueRoute` (alongside the existing `cancel`/reserved/control word handling). When the flow is in the finished `awaiting:'results'` state it re-emits a `results` outcome built from the stored slots; the pipeline's existing `results` branch fetches + formats + rolls over, and `saveFlow` re-stamps the TTL. `combine(slotDate, slotTime, now)` already re-resolves `now`-slots against the live clock and replays clock slots exactly, so issue rules 1–3 + 5 fall out of reuse. No new storage, no new state.

**Key decisions (confirmed):**
- **Two-bucket not-ready handling.** Any *in-progress* flow that isn't `awaiting:'results'` (entering custom mode, picking origin/destination, confirm, or the date/time prompts) → reply `refreshNotReady()` ("Finish choosing your route first.") and leave the flow untouched. *No or expired context* (no flow) → the existing `wizardNoRoute()` ("I don't have a route in mind — send one like \"Afula to Haifa\" first."). This satisfies extra-note #1: a half-built `tlv → haifa` where the station wasn't picked yet cannot refresh.
- **Nudge advertises refresh (English only).** `resultsNudge()` becomes `"Refresh, a different date/time, or a new route?"`. Hebrew triggers are accepted but never rendered (extra-note #2). The menu and all other prompts stay English/unchanged.
- **Trigger set (issue #15, case-insensitive via `normalize`):** EN `refresh`, `again`; HE `רענן`, `שוב`, `עוד פעם`. Stored in a `wordSet(...)` like the existing `RESERVED`/`CONTROL`/`CANCEL` sets, so `normalize`'s final-letter folding + whitespace-collapse handles `רענן`→`רענ` and the two-token `עוד פעם`→`עוד פעמ` on both sides.
- **`isNow` derivation on refresh:** `isNow = slotDate?.kind === 'now'` (matches every existing now-path: the date-step `now` fast-path and a lone-`now` follow-up both set `slotDate.kind==='now'`; clock/explicit queries are `false` so the time shows in the header). `when = combine(slotDate, slotTime, now)`.

**In scope:** all 5 issue acceptance criteria + the two extra notes.
**Out of scope:** changing route/date/time (existing follow-ups), one-liner sentence parsing (Phase 2).

---

## Tasks

### Task 1: Templates — advertise refresh in the nudge + add the not-ready message

**Independent:** Yes
**Estimated scope:** Small (2 files)

**Files:**
- Modify: `src/bot/templates.ts`
- Modify: `src/bot/templates.test.ts`

**Steps:**
1. Update `resultsNudge()`:
   ```typescript
   /** Follow-up nudge shown after every result (§8.5). */
   export function resultsNudge(): string {
     return 'Refresh, a different date/time, or a new route?';
   }
   ```
2. Add the not-ready reply (used when a refresh word arrives mid-flow, before a route+datetime have produced results):
   ```typescript
   /** Refresh word during an unfinished flow — route not yet resolved to results. */
   export function refreshNotReady(): string {
     return 'Finish choosing your route first.';
   }
   ```
3. Update the `resultsNudge` assertion in `templates.test.ts` and add a `refreshNotReady` test (exact string).

**Verification:** `npm test -- src/bot/templates.test.ts`
**Acceptance criteria:**
- [ ] `resultsNudge()` returns the refresh-advertising English string; no Hebrew.
- [ ] `refreshNotReady()` returns the exact string.

> Note: `resultsNudge()` is embedded by `wizardReport`/`wizardRollover`, so every result bubble now advertises refresh automatically — no caller changes.

---

### Task 2: Route orchestrator — refresh trigger set, predicate, and intercept

**Independent:** No — depends on Task 1 (`refreshNotReady`).
**Estimated scope:** Small (2 files)

**Files:**
- Modify: `src/route.ts`
- Modify: `src/route.test.ts`

**Steps:**
1. Add the trigger set beside the other word sets (after `BACK`):
   ```typescript
   // wizard: re-run the last resolved route with fresh data (issue #15).
   const REFRESH = wordSet('refresh', 'again', 'רענן', 'שוב', 'עוד פעם');
   ```
2. Export a predicate for the pipeline's no-flow path:
   ```typescript
   /** True when text is a refresh trigger (EN/HE, case-insensitive). */
   export function isRefreshWord(text: string): boolean {
     return REFRESH.has(norm(text));
   }
   ```
3. Add a refresh helper that re-emits a `results` outcome from the stored slots:
   ```typescript
   function refreshResults(
     sender: string,
     flow: PendingFlow,
     store: ConversationStore,
     now: Date,
   ): RouteOutcome {
     const slots = routeSlots(flow); // throws only if not in results state — guarded by caller
     const date = flow.slotDate ?? { kind: 'now' };
     const time = flow.slotTime ?? { kind: 'now' };
     // Re-save to re-stamp the 10-min TTL (issue rule 3); slots are unchanged.
     saveFlow(sender, store, { awaiting: 'results', ...slots, slotDate: date, slotTime: time });
     return results(slots, combine(date, time, now), date.kind === 'now');
   }
   ```
4. Intercept in `continueRoute`, immediately **after** the `CANCEL` / `RESERVED`/`CONTROL` block and **before** the `switch (flow.awaiting)`:
   ```typescript
   if (REFRESH.has(n)) {
     // Refresh only re-runs a finished results view. Any other in-progress
     // step (route/origin/destination/confirm/date/time) isn't a resolved
     // route yet → tell the user to finish choosing first (extra-note #1).
     if (flow.awaiting === 'results') {
       return refreshResults(sender, flow, store, now);
     }
     return { kind: 'reply', text: refreshNotReady() };
   }
   ```
   Import `refreshNotReady` from `./bot/templates.ts`.
5. Add transition tests to `route.test.ts` (drive `continueRoute` with a stubbed store + fixed `now`):
   - `awaiting:'results'` + clock slots (`slotDate:{date}`, `slotTime:{hm 08:00}`) + each trigger word → `kind:'results'`, `isNow:false`, `when` === the exact stored wall-clock; assert TTL re-stamped (store.set called).
   - `awaiting:'results'` + now slots (`slotDate:{now}`, `slotTime:{now}`) → `isNow:true`, `when` === `now` (advance the fixed `now` between calls to prove re-resolution).
   - `awaiting:'origin'` / `'destination'` / `'confirm'` / `'date'` / `'time'` + a trigger → `kind:'reply'`, text === `refreshNotReady()`; flow NOT cleared.
   - Each Hebrew trigger (`רענן`, `שוב`, `עוד פעם`) recognised; mixed case `ReFrEsh` recognised.
   - `isRefreshWord` unit cases: true for every trigger (EN/HE/case), false for `refreshed`, a station name, empty string.

**Verification:** `npm test -- src/route.test.ts`
**Acceptance criteria:**
- [ ] Refresh in `results` re-emits `results` with correct `when`/`isNow` and re-stamps TTL.
- [ ] `now`-query refresh re-resolves to the new `now`; clock-query refresh replays the exact datetime.
- [ ] Refresh in any non-results flow returns `refreshNotReady()` and preserves the flow.
- [ ] All EN/HE triggers + mixed case recognised; `isRefreshWord` exported and correct.

---

### Task 3: Pipeline — no-flow refresh + end-to-end traces

**Independent:** No — depends on Tasks 1, 2.
**Estimated scope:** Small/Medium (2 files)

**Files:**
- Modify: `src/pipeline.ts`
- Modify: `src/pipeline.test.ts`

**Steps:**
1. Import `isRefreshWord` from `./route.ts`.
2. In the no-flow conversation block (the `else if` chain after `const flow = store.get(sender)` is falsy), add a branch so a refresh word with no live context returns the "no route in mind" message instead of falling through to the menu:
   ```typescript
   } else if (isRefreshWord(coreBody)) {
     await withDeadline(
       (signal) => deps.send(botNumber, ownerUuid, wizardNoRoute(), signal),
       25_000,
     );
     return;
   }
   ```
   Place it after the `CUSTOM_ENTRY` check (order vs `hasRouteSeparator` is irrelevant — refresh words contain no separator). `wizardNoRoute` is already imported.
3. Add end-to-end traces to `pipeline.test.ts` (feed message sequences through `handleMessage` with stubbed `fetchRoutes`/`send`/`now`, assert ordered `send` payloads). Cover the issue's three examples + the extra notes:
   - **Clock refresh:** `Afula to Haifa` → pick → `at 8` (or `8`) → `refresh`. Assert the second result's header equals the first (`… · <day>, 08:00:`) and that `fetchRoutes` was called twice with the same `when`. Stub fresh data on the 2nd fetch to show updated status.
   - **`now` refresh re-resolves:** date-step `now` (fixed `now` = T1) → `עוד פעם` with `now` advanced to T2. Assert the 2nd `fetchRoutes` `when` ≈ T2 (day-only header, `isNow`).
   - **TTL reset:** refresh at minute 9 keeps the context alive; a second refresh at minute 9+8 (i.e. 17 min after the original) still works (would have expired at 10 without the re-stamp).
   - **No/expired context:** `refresh` with no flow → exactly `wizardNoRoute()`; nothing fetched.
   - **Mid-flow (extra-note #1):** `Tel Aviv to Haifa` that triggers a station disambiguation menu (`awaiting:'destination'` with candidates) → `refresh` → exactly `refreshNotReady()`; the disambiguation flow is preserved (next numeric pick still works).
   - **Nudge text (extra-note #2):** assert a normal result bubble ends with `Refresh, a different date/time, or a new route?`.

**Verification:** `npm test -- src/pipeline.test.ts`
**Acceptance criteria:**
- [ ] Clock refresh replays the exact datetime with a fresh fetch; `now` refresh re-resolves.
- [ ] Refresh re-stamps the 10-min TTL (works past the original 10-min mark).
- [ ] No/expired context → `wizardNoRoute()`, no fetch.
- [ ] Mid-disambiguation refresh → `refreshNotReady()`, flow preserved.
- [ ] Result bubbles advertise refresh in English; no Hebrew in any prompt.

---

## Dependency Graph

```
Task 1 (templates) ──┬──► Task 2 (route.ts) ──► Task 3 (pipeline + E2E)
                     └───────────────────────────►┘
```

**Sequential:** Task 1 → Task 2 → Task 3. (Task 3 also uses Task 1's nudge string directly.)

---

## Verification Summary

| Task | Verification Command | Expected |
| --- | --- | --- |
| 1 | `npm test -- src/bot/templates.test.ts` | All pass |
| 2 | `npm test -- src/route.test.ts` | All pass |
| 3 | `npm test -- src/pipeline.test.ts` | All pass |
| all | `npm run typecheck && npm test` | Exit 0, all pass |

---

## Issue #15 acceptance-criteria traceability

| Criterion | Covered by |
| --- | --- |
| All trigger words re-query the last route | Task 2 (`REFRESH` set) + Task 3 clock/now traces |
| Clock query replays the exact datetime | Task 2 (`combine` with stored `hm` slot) + Task 3 clock trace |
| `now` query re-evaluates to current time | Task 2 (`combine` with `now` slot + live `now`) + Task 3 now trace |
| Refresh resets the 10-min TTL | Task 2 (`saveFlow` re-stamp) + Task 3 TTL trace |
| No/expired context → "no route in mind" | Task 3 no-flow branch |
| Echo resolved route + datetime header | Reuse of `wizardReport` (unchanged) |
| **Extra #1:** unresolved route can't refresh | Task 2 two-bucket intercept + Task 3 mid-flow trace |
| **Extra #2:** English menu, Hebrew accepted unlisted | Task 1 nudge + Task 2 `REFRESH` set |
