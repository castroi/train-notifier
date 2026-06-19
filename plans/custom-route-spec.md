# Custom Route Matching — Spec & Implementation Plan

Companion to `train-notifier-plan.md`. Covers the **non-core (on-demand custom) route** feature: a user types an arbitrary origin/destination (HE or EN) over Signal and the bot resolves it to real station IDs, then fetches the schedule. The existing home/work flow is unchanged and must stay fully insulated.

---

## 1. Goal & scope

- Resolve free-text station input (Hebrew **or** English, never mixed) to a station ID pair.
- Tolerate typos, partial names, shared words (`מרכז`/`center`), and multi-station cities (`חיפה` = 3).
- Optimise for **wrong-station prevention** over one-message speed (transit safety).
- Deterministic and unit-testable. **No LLM, no location-as-source-of-truth** (see §16).
- **Custom on-demand routes return 5 upcoming trains** (vs. the core routes' configurable count, default 3). The custom-flow count is fixed at **5** (`CUSTOM_ROUTE_COUNT = 5`) unless overridden in config.

## 2. Decisions locked

| Decision | Value | Rationale |
|---|---|---|
| Non-exact unique match | **Confirm** (`Did you mean X? yes/no`) | Wrong city = wrong platform |
| Disambiguation menu cap | **2–8 → menu; >8 → "add a word/city"** | 5 too aggressive for 65 stations |
| Fuzzy threshold | len 3–4 → dist 1; len 5–6 → dist 2; **len ≥7 → dist 3** | length-scaled; long tokens tolerate more edits |
| Fast-mode auto-accept | Only if: edit-dist **1** on token **≥6 chars** AND gap to 2nd ≥2 | opt-in; default always confirms |
| Entry | **`0` = "Other route"** in menu, OR direct `X אל/to Y` | discoverable + power path |

## 3. Language detection

Single scan for Hebrew code points (`֐–׿`). Any present → match against `hebrew` names + Hebrew aliases. Else → `english`. Input is never mixed (user-confirmed).

## 4. Normalization & tokenization

**Hebrew:** strip niqqud; normalise final letters (ץ→צ, ם→מ, ן→נ, ף→פ, ך→כ); **strip gershayim `"` and geresh `'`** (required for `נתב"ג`→`נתבג` and the in-name quote in `כפר חב"ד`); remove parentheses; collapse whitespace. On prefix matching, if a station token starts with `ה`, also try matching after stripping it (`כרמל`↔`הכרמל`).

**English:** lowercase; strip apostrophes (`be'er`→`beer`); remove punctuation except `/`; collapse whitespace.

**Tokenise:** split on spaces and dashes. No stemming/truncation.

## 5. Scoring model — decide by *shape*, not tiers

For each station, score the **query's coverage** of it. Per query token, find its best home in the station's tokens:

| Query token match quality | Points |
|---|---|
| equals a station token (exact) | 3 |
| is a prefix of a station token | 2 |
| within edit distance (per §2 threshold) | 1 |
| no home anywhere | **disqualifies the station** |

Station score = sum over query tokens. Exact alias (`נתבג`) and exact full-name matches are flagged separately as `exact`.

**Why this works:** the city name is a token in every station of that city, so `חיפה` ties 3 stations and `עפולה` matches 1 — disambiguation falls out of the tie count with **no hand-maintained city list**. A small alias table is kept only for non-substring abbreviations (`תא`, `tlv`, `bs`, `נתבג`).

## 6. Decision table (per resolved half)

| Shape | Action |
|---|---|
| Exact alias / full name, unique | **Accept** |
| Unique, all tokens exact but a subset of station name, clear gap | **Confirm** |
| Unique, fuzzy (needed edit distance) | **Confirm** (fast-mode may accept per §2) |
| 2–8 candidates tied/close | **Numbered menu** (cap 8) |
| >8 candidates | "Too broad — add a city or another word" |
| No station survives (token with no home) | **Not found → top-3 closest as a numbered menu** |

## 7. Entry trigger ladder (evaluated top-to-bottom, on the whole message)

1. **Whole message is** a reserved word (`home`/`work`/`בית`/`עבודה`), a bare number, or a control word (`menu`/`help`/`cancel`/`yes`/`no`/Hebrew equivs) → **core/control path** (existing behaviour, always wins).
2. Message **contains a separator** (` to `, `from`, `אל`) → **custom-route matcher** (split, resolve each half).
3. Bare station-looking text, not reserved → **attempt match**; if it resolves, enter custom mode as origin and prompt for destination; else fall to core menu.
4. Anything else → core time-aware menu.

`0` is repurposed: from the main menu it means **"Other route"** (enters custom mode); inside a pending flow it means **cancel**.

## 8. Reserved-word rule (the insulation guarantee)

`work`/`home`/`עבודה`/`בית` are **route** aliases, not station aliases. They are honoured **only as a standalone message** (ladder rule 1). If one appears as a route *half* (e.g. `עבודה אל חיפה`), it is **not** expanded into a station — the bot clarifies: *"‘עבודה’ is a saved route, not a station. Type a station name, or send ‘עבודה’ on its own for that route."* This guarantees the daily path can never be hijacked by the matcher and no reserved word resolves to a wrong train.

## 9. Conversation state (ephemeral)

The core bot is statelessly numbered (`2` = route #2). Custom menus use **dynamic numbering** (`2` = 2nd listed candidate), so per-sender state is required.

```
PendingFlow {
  sender: string            // Signal UUID
  awaiting: 'origin' | 'destination' | 'confirm'
  origin?: stationId
  destination?: stationId
  candidates: stationId[]    // what the numbers map to
  confirmTarget?: stationId  // for yes/no
  expiresAt: epochMs         // short TTL, ~2 min
}
```

- **Number-routing precedence:** a numeric reply resolves against `candidates` **iff** a non-expired pending flow exists for that sender; otherwise it falls through to the core route index.
- **TTL / staleness:** expire after ~2 min; on expiry, treat the next message as fresh (don't resolve against a dead menu).
- **Escape:** any reserved/control word during a pending flow aborts it (no "invalid number" error), then runs that word normally.

## 10. Route parsing

- Split on ` to ` / `from … to …` (EN) or `אל` (HE). Each half resolves independently via §4–6.
- **Directional:** `to Y` → origin null (fill from recents/memory or prompt). Bare `X` → origin, await destination.
- **Source == destination** (G4): checked after both halves resolve; if equal, re-prompt.

## 11. Recents / favorites (v2, optional)

Persistent, separate store from §9 (different lifetime). Powers `to חיפה` (fill last origin) and one-tap repeat (`recent` → numbered menu). Not on the v1 critical path, but §9's resolved pairs should be promotable into it. This is the feature that collapses a 3-prompt custom route back to one tap.

## 12. Message templates (dialog contract)

Menu labels bilingual (EN + HE); message body EN-only (matches `train-notifier-plan.md` §13.4). Menus always include `(0 to cancel)`. See dialog traces in §13 / the design discussion for exact phrasing.

## 13. Test matrix (the contract)

Build as `stations`-backed unit tests, both language paths.

| # | Input | Origin → | Destination → |
|---|---|---|---|
| 1 | ראשון אל חיפה | Menu(2): Rishon-HaRishonim / Moshe Dayan | Menu(3): Bat Galim / Hof HaKarmel / Center-HaShmona |
| 2 | תל אביב אל חיפה | Menu(4): Savidor / HaShalom / University / HaHagana | Menu(3) Haifa |
| 3 | TLV to afula | Menu(4) TA (alias) | Accept: Afula R. Eitan |
| 5 | יהושע אל כפר ברוך | Menu(2): Bet Yehoshu'a / Kfar Yehoshu'a | Confirm: Migdal Ha'emek - Kfar Barukh |
| 6 | מפרץ אל תל אביב | Menu(2): Hutzot HaMifratz / HaMifrats Central | Menu(4) TA |
| 7 | חוף הכרמל אל תל אביב | Confirm: Haifa - Hof HaKarmel | Menu(4) TA |
| 8 | השמונה אל בת גלים | Confirm: Haifa Center - HaShmona | Confirm: Haifa - Bat Galim |
| 9 | פתח תקווה אל באר שבע | Menu(2): Segula / Kiryat Arye | Menu(2): North-University / Center |
| 10 | בנימינה אל נהריה | Accept: Binyamina | Accept: Nahariya |
| 11 | Narahria to carmely | Confirm: Nahariya (dist 3, len≥7) | Confirm: Karmiel |
| 12 | נמל תעופה אל חיפה | Confirm: Ben Gurion Airport | Menu(3) Haifa |
| 13 | נתב"ג אל עפולה | Accept: Ben Gurion Airport (alias, post-gershayim-strip) | Accept: Afula R. Eitan |
| T1 | `home` (whole msg) | — core path (insulated) | — |
| T2 | `2` w/ pending vs none | pending candidate vs core route #2 | — |
| T3 | `to afula` | empty → memory/prompt | Accept: Afula |
| T4 | `עבודה אל חיפה` | **Clarify** (reserved route-word, not a station) | — |
| T5 | `חיפה אל חיפה` | resolve both → G4 re-prompt (source==dest) | — |

Collision watch (must not leak): `בת גלים` must exclude `בת ים`/`בתיה` (token `גלים` has no home there); `כפר ברוך` filters 4 `כפר` stations to one via `ברוך`.

## 14. Startup validation (additions to existing)

Fail fast if: two stations share a normalised alias; a city/abbreviation alias collides with a station alias; any alias collides with a reserved/control word; an alias references a missing station ID. Run normalization (incl. gershayim/geresh) before these checks.

## 15. Implementation plan

1. **`src/rail/match.ts`** — normalization (extend `bot/normalize.ts` with gershayim/geresh + HE `ה`-prefix), tokenizer, scorer, decision function returning `{action, candidates, target}`. Pure, no I/O.
2. **`src/rail/match.test.ts`** — encode §13 matrix as the contract. Write tests first.
3. **Abbreviation alias table** — small map for `תא`/`tlv`/`bs`/etc. + `נתבג` already in `stations.ts`.
4. **Conversation state** — in-memory per-sender `PendingFlow` map with TTL (§9). Single module, e.g. `src/bot/conversation.ts`.
5. **Trigger ladder** — extend `src/bot/parse.ts` to implement §7 precedence (reserved-first, separator→matcher, number→pending-vs-core), wiring §8 clarify and `0` handling.
6. **Pipeline** — thread pending state through the receive loop; on resolved pair, reuse existing fetch+format path.
7. **Templates** — add custom-route menu/confirm/clarify/cancel strings (bilingual labels, EN body).
8. **(v2)** recents store.

## 16. Explicitly out of scope

- **Local LLM** — closed 65-item domain; nondeterministic; latency on the Pi; prompt-injection surface. Deterministic matching wins (consistent with `train-notifier-plan.md` §12.1).
- **Location as source-of-truth** — GPS-nearest ≠ intended origin (users plan from elsewhere). If ever added, treat a location pin as an *accelerator* that proposes the nearest station and **confirms**, never silently adopts.
