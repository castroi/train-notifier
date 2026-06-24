# Guided Date/Time Wizard — State-Machine Spec (Phase 1)

Status: draft for review. Scope: the **guided, multi-turn wizard** (Route → Date → Time → Results), plus §11 capturing the Phase-2 one-liner chunk strategy as forward design (build later). Body language EN; aliases/labels bilingual per the main plan.

---

## 1. Goal & non-goals

1.1 Let the owner request a route for a future departure through bounded prompts, with no free-text date/time parsing required.
1.2 Reuse the slot model and the datetime resolver that the later one-liner feature will also use.
1.3 Non-goal: parsing a complete sentence in one message (`Afula to Akko tomorrow 17:00`). That is Phase 2.
1.4 Non-goal: changing the existing stateless fast paths (number/alias → next-from-now). The wizard is additive.

---

## 2. Slots (the shared model)

The wizard fills a single in-memory context for the owner:

2.1 `originId` (number) — resolved station id.
2.2 `destId` (number) — resolved station id (after disambiguation if the city has several stations).
2.3 `date` — one of `now | today | tomorrow | <explicit date>`; resolved to an absolute local date.
2.4 `time` — `now` or `HH:MM` (24h); resolved to an absolute local time.
2.5 `resolvedAt` — timestamp for TTL (§7).
2.6 The same slot shape is what the Phase-2 one-liner will pre-fill in a single message.

---

## 3. States

3.1 `IDLE` — no flow in progress.
3.2 `AWAIT_DEST_DISAMBIG` — destination city has multiple stations; waiting for a pick. (Also applies to origin if needed.)
3.3 `AWAIT_DATE` — waiting for date choice.
3.4 `AWAIT_TIME` — waiting for time choice.
3.5 `RESULTS` — results shown; waiting for a follow-up (new date/time or new route).

Only one flow is active at a time (single owner).

---

## 4. Transitions

4.1 `IDLE → …` on a route message (`X to Y` / alias):
- If destination (or origin) resolves to multiple stations → `AWAIT_DEST_DISAMBIG`.
- Else → `AWAIT_DATE`.

4.2 `AWAIT_DEST_DISAMBIG → AWAIT_DATE` once a valid station number is picked.

4.3 `AWAIT_DATE`:
- `now` → set date+time to now, **skip the time step**, → `RESULTS`.
- `today` / `tomorrow` / valid custom date → set `date`, → `AWAIT_TIME`.
- invalid → re-ask, stay in `AWAIT_DATE` (§6).

4.4 `AWAIT_TIME`:
- `now` → set time to current local time, → `RESULTS`.
- valid `HH:MM` / bare hour → set `time`, → `RESULTS`.
- invalid → re-ask, stay in `AWAIT_TIME` (§6).

4.5 `RESULTS` (follow-ups):
- lone time → keep last `date`, update `time`, → `RESULTS` (re-query).
- lone date → keep last `time`, update `date`, → `RESULTS` (re-query).
- new route (`X to Y` / alias) → reset all slots → 4.1.
- anything unrecognized → show the `RESULTS` nudge again.

4.6 Global commands valid in any non-IDLE state:
- `back` → return to the previous step and re-ask.
- `cancel` / `x` → drop the flow → `IDLE`.
- a new `X to Y` mid-flow → reset and start at 4.1.

---

## 5. Bounded inputs per prompt

5.1 Route (entry): `X to Y`, or alias, or the existing menu path. (Hebrew `X אל/ל Y` accepted.)
5.2 Disambiguation prompt: an integer `1..K` (K = stations listed). Out-of-range / non-integer → re-ask.
5.3 Date prompt — accepted: `now`, `today`, `tomorrow`, explicit date `D/M` or `D/M/YYYY`. (Weekday words like `sunday`/`ראשון` are **Phase-2** territory; not accepted by the wizard prompt to keep it bounded — revisit if you want them here.)
5.4 Time prompt — accepted: `now`, `HH:MM`, or a bare hour `H`/`HH` (interpreted 24h). No AM/PM.
5.5 Pending-question precedence: when in `AWAIT_*`, the next message is interpreted as the **answer to that prompt first** — so `2` at disambiguation is "station 2", not "route 2".

---

## 6. Validation rule

6.1 Every prompt validates its input against the bounded set in §5.
6.2 On invalid input: reply with a precise correction that restates the accepted formats, and **stay on the same step** (never crash the flow, never fall through).
6.3 Examples: bad date → "Type one of: now / today / tomorrow / a date like 17/09"; bad time → "Type a time like 7:00, 19, or 12:30".

---

## 7. State lifecycle / TTL

7.1 The wizard context is a single in-memory slot for the owner (no DB, no per-user keying).
7.2 TTL ≈ 10 min of inactivity. After TTL, the context is abandoned and the next message is treated as a fresh start (not as a step answer).
7.3 TTL is checked on each inbound message before routing it to a state.
7.4 On `cancel` or completion-with-no-followup beyond TTL, return to `IDLE`.

---

## 8. Results & carry-over

8.1 Results render per the main plan's train-line contract (`HH:MM → HH:MM · status · plat N`).
8.2 Every result echoes the resolved absolute datetime header: `Afula → Akko · Tue 23 Jun, 17:00:` (or `· Today 22 Jun:` for `now`/day-only) — the safeguard against a wrong slot.
8.3 Carry-over rule (drives all "type again" follow-ups), stated explicitly:
- lone **time** → keeps the last **date**.
- lone **date** → keeps the last **time** (or `now` if the last result was a `now` query).
- new **route** → resets every slot.
8.4 No-trains handling: if the resolved datetime has no remaining service that day, roll to the next service day and say so (reuses the main plan's rollover + outage behavior).
8.5 After results, prompt: "Different date/time, or a new route?"

---

## 9. The seam for Phase 2 (one-liner) — design now, build later

9.1 The wizard must fill the **same slot object** (§2) that the Phase-2 resolver will pre-fill from a single message.
9.2 Phase 2 attaches as an alternate entry point: resolve stations → if leftover text exists, parse date/time and jump straight to `RESULTS`; if leftover is empty, drop into `AWAIT_DATE` (i.e. the wizard).
9.3 Keep the datetime resolver (date/time tokens → absolute local datetime, `Asia/Jerusalem`) as a **standalone, separately-testable function** the wizard calls — so Phase 2 reuses it unchanged.
9.4 Prerequisite to confirm before Phase 2 (not blocking Phase 1): the station resolver can report match **span/position**, not just an id — needed for clean sentence segmentation.

---

## 10. Open items to settle before building Phase 1

10.1 Exact prompt wording (EN), and whether the date prompt should also accept weekday words now or defer to Phase 2.
10.2 TTL value (10 min proposed).
10.3 Whether `now` at the date step should also be offered as a one-tap default for the most common path.
10.4 Disambiguation list ordering (by usage, alphabetical, or rail-API order).
10.5 Confirm the resolver returns absolute datetimes in `Asia/Jerusalem` to feed the rail request's `departureDate` (per the verified time mechanism in the main plan).

---

## 11. Phase 2 — One-liner chunk strategy (design captured; build later)

Forward design for the Phase-2 one-line resolver (e.g. `TLV to Haifa tomorrow 12:00`). Not part of the Phase-1 build scope; recorded here because it reuses the Phase-1 slot model (§2) and the standalone datetime resolver (§9.3). This is the content that will seed the Phase-2 GitHub issue.

### 11.1 Goal
Turn a single-message request into two parts — a **stations chunk** and a **datetime chunk** — so each is handed to its own resolver.

### 11.2 Core principle: anchor on the closed set, not the open one
Stations are a finite, known list, so "is this a station?" has a definite yes/no answer. Time phrasing is open-ended ("tomorrow", "מחר בבוקר", "next Sunday", "17:00"), so "is this a time word?" does not. Therefore **resolve the stations first and let the datetime be whatever is left** — never find the time first.

### 11.3 The split
1. Run the existing station matcher over the whole message, **longest-match**, taking the two best hits **with their positions**.
2. Stations chunk = up to the end of the second station; datetime chunk = everything after it.
3. Resolve the stations chunk → origin + destination.
4. Resolve the datetime chunk with the lexicon + regex → absolute datetime (`Asia/Jerusalem`). Empty leftover → no time given → fall back to the wizard / next-from-now.

### 11.4 Why not the alternatives
- Split by the first **number**: fails on no-digit inputs (`tomorrow`, `מחר בבוקר`), on multi-word/digit-bearing station names, and needs to be taught what "a number" is. Fragile.
- Split on the first **time-word**: better, but still boundary-guessing — a time-word can overlap a station name, so the boundary stays ambiguous from text alone.
- Anchor on **resolved stations**: most robust and least work — reuses the matcher already owned and computes the boundary from where stations actually are.

### 11.5 Hard prerequisite
The station resolver must return match **span/position (longest-match)**, not just an id/boolean. If it only returns an id today, extend it to report the span first — this single capability is what makes the clean split possible.

### 11.6 Edge cases — station-vs-time collisions
The governing rule (one line):
> Resolve the two longest station matches over the full message first; the datetime scan operates **only** on text outside those spans. A token inside a station span is never eligible to be a date/time word.

This is what makes `ראשון לציון` (Rishon LeZion) safe: longest-match binds `ראשון לציון` as one station before any time scan, so the `ראשון` inside it can never be misread as Sunday. Running edge-case corpus to test:
- `TLV to ראשון לציון tomorrow 12:00` — `ראשון` inside the station must not become a date.
- `ראשון לציון לחיפה ראשון` — first `ראשון` binds to the origin station; only the trailing `ראשון` is the day.
- bare `ראשון` — ambiguous between the station and the weekday; needs a tie-break (lean: a known station alias in the stations position wins over a day-word).
- multi-word / no-digit names: `בית שמש`, `באר שבע` (where `ב` also starts a time chunk), `כפר סבא`, `ראש העין`.
- short names that could prefix other words: `שדרות`, `שדה`.

### 11.7 Seam reuse
Attaches as an alternate entry point: resolve stations → if leftover text exists, parse date/time and jump straight to `RESULTS`; if leftover is empty, drop into `AWAIT_DATE` (the wizard). Reuses the Phase-1 slot object (§2) and the standalone datetime resolver (§9.3) unchanged.
