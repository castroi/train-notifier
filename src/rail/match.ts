import { normalize } from '../bot/normalize.ts';
import { stations } from './stations.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MatchResult =
  | { action: 'accept'; stationId: string }
  | { action: 'confirm'; stationId: string }
  | { action: 'menu'; candidates: string[] } // 2..8 station ids, ordered deterministically
  | { action: 'too_broad' } // >8 candidates
  | { action: 'not_found'; suggestions: string[] }; // up to 3 closest station ids

export interface MatchOptions {
  fastMode?: boolean; // default false
}

// ---------------------------------------------------------------------------
// G0 city-alias table (non-substring abbreviations only)
// Full city names (חיפה, tel aviv, …) fall out naturally from scoring.
// ---------------------------------------------------------------------------

const ALIAS_TABLE: Record<string, string[]> = {
  tlv: ['3700', '4600', '3600', '4900'],
  ta: ['3700', '4600', '3600', '4900'],
  תא: ['3700', '4600', '3600', '4900'],
  'ת"א': ['3700', '4600', '3600', '4900'],
  bs: ['7300', '7320'],
  hfa: ['2100', '2200', '2300'],
};

// ---------------------------------------------------------------------------
// Language detection (§3)
// ---------------------------------------------------------------------------

// Detect Hebrew by the base-letter block U+05D0–U+05EA. Final forms and
// gershayim/geresh are normalized away later and never appear without a base
// letter, so this narrow range is sufficient for language selection.
function isHebrew(s: string): boolean {
  return /[א-ת]/.test(s);
}

// ---------------------------------------------------------------------------
// Extended normalization (§4) — builds on base normalize()
// Strip quote chars (gershayim ״, geresh ׳, ASCII " ') and parentheses.
// ---------------------------------------------------------------------------

function normalizeForMatch(s: string): string {
  let r = normalize(s);
  r = r.replace(/["'״׳]/g, '');
  r = r.replace(/[()]/g, '');
  r = r.trim().replace(/\s+/g, ' ');
  return r;
}

// ---------------------------------------------------------------------------
// Tokenizer — split on spaces, dashes, and slashes (§4)
// ---------------------------------------------------------------------------

function tokenize(s: string): string[] {
  return s
    .split(/[\s\-/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Levenshtein distance (§5)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  // (full matrix below; callers gate on length difference before invoking)
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ---------------------------------------------------------------------------
// Max edit distance for a token of a given length (§2, with one deviation).
//
// Spec §2: len 3–4 → 1; len 5–6 → 2; len ≥7 → 3.
// DEVIATION (load-bearing): len 5–6 is reduced to dist 1, not 2. This is the
// ONLY guard that blocks עפולה↔סגולה (both 5 chars, edit distance 2): the
// length guard at bestTokenScore() does not help there since min(5,5)=5 already
// satisfies its dist-2 threshold. No required §13 case needs dist 2 on a
// 5–6-char token, so reducing it is safe and prevents that spurious match.
// Do not raise this back to 2 without re-checking עפולה / השמונה collisions.
// ---------------------------------------------------------------------------

function maxEditDist(len: number): number {
  if (len <= 2) return 0; // tokens ≤2 chars are never fuzzy-matched
  if (len <= 4) return 1;
  if (len <= 6) return 1; // intentionally 1, see comment above
  return 3;
}

// ---------------------------------------------------------------------------
// Per-station cached token data
// ---------------------------------------------------------------------------

interface StationTokenData {
  id: string;
  tokens: string[]; // normalized tokens of the primary name
  aliases: string[][]; // normalized tokens for each alias
  rawAliases: string[]; // normalized raw alias strings (for exact-alias check)
  rawFull: string; // normalized full name string (for exact-full-name check)
}

function buildStationData(lang: 'hebrew' | 'english'): StationTokenData[] {
  return stations.map((st) => {
    const nameStr = normalizeForMatch(st[lang]);
    const tokens = tokenize(nameStr);
    const rawAliases: string[] = [];
    const aliasTokenArrays: string[][] = [];
    for (const a of st.alias ?? []) {
      const norm = normalizeForMatch(a);
      rawAliases.push(norm);
      aliasTokenArrays.push(tokenize(norm));
    }
    return { id: st.id, tokens, aliases: aliasTokenArrays, rawAliases, rawFull: nameStr };
  });
}

// ---------------------------------------------------------------------------
// Token-level scoring (§5)
//
// Returns the best score a single query token earns against a set of station
// tokens: 3 = exact, 2 = prefix, 1 = fuzzy, 0 = no match (disqualifies).
// Hebrew ה-prefix stripping is applied on the station token side only (§4).
// ---------------------------------------------------------------------------

function bestTokenScore(queryToken: string, stationTokens: string[]): number {
  let best = 0;
  const qLen = queryToken.length;
  const qMaxDist = maxEditDist(qLen);

  for (const st of stationTokens) {
    // Exact match
    if (queryToken === st) return 3;

    // ה-stripped form of station token (for prefix/fuzzy matching)
    const stStripped = st.startsWith('ה') && st.length > 1 ? st.slice(1) : null;

    // Prefix: query token is a prefix of the station token
    if (st.startsWith(queryToken)) {
      best = Math.max(best, 2);
      continue;
    }
    if (stStripped?.startsWith(queryToken)) {
      best = Math.max(best, 2);
      continue;
    }

    // Fuzzy: only for query tokens of length ≥ 3.
    // Additional constraint: both tokens must be long enough that the edit
    // distance represents a meaningful similarity (not just a shared suffix).
    // Specifically, min(lenQuery, lenStation) must be ≥ ceil(maxDist * 7/3),
    // which maps to: dist 1 → min ≥ 3, dist 2 → min ≥ 5, dist 3 → min ≥ 7.
    // This prevents e.g. בנימינה(7) from fuzzy-matching דימונה(6) at dist 3.
    if (qLen >= 3 && qMaxDist > 0) {
      const minLenRequired = Math.ceil((qMaxDist * 7) / 3);
      // Early-bail: if the lengths differ by more than maxDist the edit distance
      // cannot be ≤ maxDist, so skip the O(m·n) Levenshtein entirely.
      if (
        Math.min(qLen, st.length) >= minLenRequired &&
        Math.abs(qLen - st.length) <= qMaxDist &&
        levenshtein(queryToken, st) <= qMaxDist
      ) {
        best = Math.max(best, 1);
        continue;
      }
      if (
        stStripped !== null &&
        Math.min(qLen, stStripped.length) >= minLenRequired &&
        Math.abs(qLen - stStripped.length) <= qMaxDist &&
        levenshtein(queryToken, stStripped) <= qMaxDist
      ) {
        best = Math.max(best, 1);
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Station scoring
// ---------------------------------------------------------------------------

interface ScoredStation {
  id: string;
  score: number;
  exactCount: number; // query tokens that earned exactly 3 points
  isExact: boolean; // exact alias or exact full-name match
  hasAlias: boolean; // matched via an alias
  firstTokenExact: boolean; // all query tokens are exact AND single-token query matches station[0]
}

function scoreStations(
  queryTokens: string[],
  normalizedQuery: string,
  data: StationTokenData[],
): ScoredStation[] {
  const results: ScoredStation[] = [];
  const isSingleToken = queryTokens.length === 1;
  const singleQueryToken = isSingleToken ? queryTokens[0] : '';

  for (const st of data) {
    const allTokenSets: string[][] = [st.tokens, ...st.aliases];

    let totalScore = 0;
    let exactCount = 0;
    let disqualified = false;

    for (const qTok of queryTokens) {
      let best = 0;
      for (const tokenSet of allTokenSets) {
        const s = bestTokenScore(qTok, tokenSet);
        if (s > best) best = s;
      }
      if (best === 0) {
        disqualified = true;
        break;
      }
      totalScore += best;
      if (best === 3) exactCount++;
    }

    if (disqualified) continue;

    const isExactAlias = st.rawAliases.includes(normalizedQuery);
    const isExactFullName = st.rawFull === normalizedQuery;
    const isExact = isExactAlias || isExactFullName;

    // "First-token accept" rule: a single-token query that scores exactly 3
    // against the first token of the station's primary name is treated as an
    // exact match (accept-eligible) even if the station has additional tokens.
    // This lets 'afula' → accept 1260 ('Afula R.Eitan') and
    // 'עפולה' → accept 1260 ('עפולה ר. איתן') without requiring the query to
    // equal the full normalized station name.
    //
    // DELIBERATE §6 DIVERGENCE: spec §6 says a unique subset-of-name match
    // should Confirm, not Accept. We Accept here because a query equal to the
    // first token of the ONLY station in that city is genuinely unambiguous
    // (single-station cities like Afula/Nahariya) — confirming would just add a
    // tap with no wrong-station risk. Multi-station cities never hit this: their
    // city token ties N>1 stations, so `unique` is false and it goes to a menu.
    const firstTokenExact =
      isSingleToken &&
      exactCount === 1 &&
      st.tokens.length > 0 &&
      st.tokens[0] === singleQueryToken;

    results.push({
      id: st.id,
      score: totalScore,
      exactCount,
      isExact: isExact || firstTokenExact,
      hasAlias: isExactAlias,
      firstTokenExact,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Deterministic menu ordering (§ "Disambiguation menu ordering"):
//   1. Higher score first
//   2. More exact token matches first
//   3. Alias matches first
//   4. Station id ascending (numeric)
// ---------------------------------------------------------------------------

function sortCandidates(scored: ScoredStation[]): ScoredStation[] {
  return [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.exactCount !== a.exactCount) return b.exactCount - a.exactCount;
    if (a.hasAlias !== b.hasAlias) return a.hasAlias ? -1 : 1;
    return Number(a.id) - Number(b.id);
  });
}

// ---------------------------------------------------------------------------
// Not-found suggestions: top-3 closest stations by total Levenshtein distance
// ---------------------------------------------------------------------------

function notFoundSuggestions(queryTokens: string[], data: StationTokenData[]): string[] {
  const scored = data.map((st) => {
    const allTokens = [...st.tokens, ...st.aliases.flat()];
    let totalDist = 0;
    for (const qTok of queryTokens) {
      let minD = Number.POSITIVE_INFINITY;
      for (const stTok of allTokens) {
        const d = levenshtein(qTok, stTok);
        if (d < minD) minD = d;
      }
      totalDist += minD === Number.POSITIVE_INFINITY ? qTok.length : minD;
    }
    return { id: st.id, dist: totalDist };
  });

  scored.sort((a, b) => a.dist - b.dist || Number(a.id) - Number(b.id));
  return scored.slice(0, 3).map((x) => x.id);
}

// ---------------------------------------------------------------------------
// Fast-mode auto-accept (§2)
// Upgrade unique fuzzy confirm → accept ONLY when:
//   - the matched token is ≥ 6 chars
//   - the edit distance is exactly 1
//   - the score gap to the 2nd-best candidate is ≥ 2
// ---------------------------------------------------------------------------

function canFastAccept(
  queryTokens: string[],
  winner: ScoredStation,
  allScored: ScoredStation[],
  data: StationTokenData[],
): boolean {
  const sorted = sortCandidates(allScored);
  if (sorted.length >= 2 && sorted[0].score - sorted[1].score < 2) return false;

  const stData = data.find((d) => d.id === winner.id);
  if (!stData) return false;

  const allStTokens = [...stData.tokens, ...stData.aliases.flat()];
  for (const qTok of queryTokens) {
    if (qTok.length < 6) continue;
    for (const stTok of allStTokens) {
      if (levenshtein(qTok, stTok) === 1) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main matcher entry point
// ---------------------------------------------------------------------------

export function matchStation(query: string, opts?: MatchOptions): MatchResult {
  const fastMode = opts?.fastMode ?? false;

  // G0: city-alias pre-check (before length check)
  const normForAlias = normalizeForMatch(query);
  if (Object.hasOwn(ALIAS_TABLE, normForAlias)) {
    const ids = ALIAS_TABLE[normForAlias];
    if (ids.length === 1) return { action: 'accept', stationId: ids[0] };
    return { action: 'menu', candidates: ids };
  }

  // Full normalization
  const normQuery = normalizeForMatch(query);
  const queryTokens = tokenize(normQuery);

  // G1: minimum length check
  if (normQuery.length < 3) {
    return { action: 'not_found', suggestions: [] };
  }

  // Language detection and station data
  const lang: 'hebrew' | 'english' = isHebrew(query) ? 'hebrew' : 'english';
  const data = buildStationData(lang);

  // Score all stations
  const scored = scoreStations(queryTokens, normQuery, data);

  if (scored.length === 0) {
    return { action: 'not_found', suggestions: notFoundSuggestions(queryTokens, data) };
  }

  if (scored.length > 8) {
    return { action: 'too_broad' };
  }

  const sorted = sortCandidates(scored);

  if (sorted.length === 1) {
    const winner = sorted[0];
    if (winner.isExact) {
      return { action: 'accept', stationId: winner.id };
    }
    if (fastMode && canFastAccept(queryTokens, winner, scored, data)) {
      return { action: 'accept', stationId: winner.id };
    }
    return { action: 'confirm', stationId: winner.id };
  }

  // 2–8 candidates
  return { action: 'menu', candidates: sorted.map((s) => s.id) };
}
