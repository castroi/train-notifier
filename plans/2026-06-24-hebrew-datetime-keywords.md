# Accept Hebrew relative date/time keywords (issue #19)

**Goal:** Let a Hebrew-keyboard user answer the wizard's `When?` prompt without switching layout, by accepting `עכשיו`/`היום`/`מחר` as aliases for `now`/`today`/`tomorrow`.

**Architecture:** Purely additive change to the standalone resolver `src/bot/datetime.ts`. `resolveDate`/`resolveTime` already normalize the token before matching English keyword literals; replace those literals with small keyword sets (EN + HE) so the Hebrew forms resolve to the identical slots. No change to callers, prompts, headers, or numeric forms.

**Key decisions:**
- **Build the keyword sets by running the source words through `normalize()` at module load** — `new Set(['now','עכשיו'].map(normalize))` — rather than hand-writing the normalized spellings. `normalize()` folds Hebrew final-letter forms (`היום`→`היומ`) and lowercases Latin; deriving the set this way keeps the match correct without me guessing the folded form, mirroring the `wordSet(...)` idiom in `src/route.ts`.
- **`now` is shared** between `resolveDate` and `resolveTime`, so `עכשיו` must be accepted by both (one shared `NOW_WORDS` set).
- **Input only.** Prompt/header wording and `describeDay()` output stay English (the menu-in-English convention from #15). Numeric forms (`D/M`, `HH:MM`, bare hour) and invalid-token re-ask behavior are untouched.

---

## Tasks

### Task 1: Hebrew keyword aliases in the datetime resolver

**Independent:** Yes
**Estimated scope:** Small (2 files)

**Files:**
- Modify: `src/bot/datetime.ts`
- Modify: `src/bot/datetime.test.ts`

**Steps:**
1. Add keyword sets near the top of `datetime.ts` (after the `TZ` constant), built via `normalize()`:
   ```typescript
   // Relative-date/time keywords, EN + HE (issue #19). Built through normalize()
   // so Hebrew final-letter folding (היום → היומ) is handled automatically.
   const NOW_WORDS = new Set(['now', 'עכשיו'].map(normalize));
   const TODAY_WORDS = new Set(['today', 'היום'].map(normalize));
   const TOMORROW_WORDS = new Set(['tomorrow', 'מחר'].map(normalize));
   ```
2. In `resolveDate`, replace the three string-equality checks:
   ```typescript
   if (NOW_WORDS.has(t)) return { kind: 'now' };
   if (TODAY_WORDS.has(t)) return { kind: 'date', ...jerusalemYMD(now) };
   if (TOMORROW_WORDS.has(t)) {
     return { kind: 'date', ...jerusalemYMD(new Date(now.getTime() + 86_400_000)) };
   }
   ```
3. In `resolveTime`, replace `if (t === 'now')` with `if (NOW_WORDS.has(t))`.
4. Extend `datetime.test.ts`:
   - `resolveDate('עכשיו', NOW)` → `{ kind: 'now' }`
   - `resolveDate('היום', NOW)` → `{ kind: 'date', y: 2026, m: 6, d: 22 }`
   - `resolveDate('מחר', NOW)` → `{ kind: 'date', y: 2026, m: 6, d: 23 }`
   - `resolveTime('עכשיו')` → `{ kind: 'now' }`
   - A normalization guard: `resolveDate` accepts `היום` even with a trailing RTL mark / mixed form (e.g. `' היום '`) → still `today`.

**Verification:** `node --test src/bot/datetime.test.ts`
**Acceptance criteria:**
- [ ] `עכשיו`/`היום`/`מחר` resolve to the same slots as `now`/`today`/`tomorrow`.
- [ ] `resolveTime('עכשיו')` resolves to `{ kind: 'now' }`.
- [ ] English forms and numeric forms still resolve; garbage/weekday words still reject.
- [ ] No change to prompts, headers, or `describeDay`.

---

## Verification Summary

| Task | Verification Command | Expected |
| --- | --- | --- |
| 1 | `node --test src/bot/datetime.test.ts` | All pass |
| all | `npm run typecheck && npm run lint && npm test` | Exit 0, all pass |

---

## Issue #19 traceability

| Criterion | Covered by |
| --- | --- |
| `resolveDate` accepts עכשיו/היום/מחר | Task 1 step 2 + tests |
| `resolveTime` accepts עכשיו | Task 1 step 3 + test |
| Final-letter normalization (היום) | Sets built via `normalize()` + guard test |
| Prompts/headers/numeric forms unchanged | No edits outside the two match blocks |
