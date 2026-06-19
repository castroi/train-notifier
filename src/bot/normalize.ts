/**
 * Text normalization for bot input matching.
 *
 * Steps applied in order:
 * 1. Trim leading/trailing whitespace
 * 2. Collapse internal whitespace runs to a single space
 * 3. Lowercase all Latin characters
 * 4. Strip Hebrew niqqud (U+0591–U+05C7: cantillation marks, vowel points,
 *    punctuation like dagesh, rafe, holam, etc.)
 * 5. Convert Hebrew final letter forms to their non-final equivalents:
 *      ך (U+05DA) → כ (U+05DB)
 *      ם (U+05DD) → מ (U+05DE)
 *      ן (U+05DF) → נ (U+05E0)
 *      ף (U+05E3) → פ (U+05E4)
 *      ץ (U+05E5) → צ (U+05E6)
 */
export function normalize(s: string): string {
  // Step 0: strip invisible bidirectional / zero-width formatting characters.
  // Hebrew mobile keyboards and Signal wrap RTL text with marks like U+200F
  // (RLM) or U+200E (LRM); left in, they make e.g. "כן" fail to match.
  // Covers: zero-width + directional marks (U+200B–U+200F), bidi
  // embeddings/overrides (U+202A–U+202E), word joiner + isolates
  // (U+2060–U+206F), and BOM/ZWNBSP (U+FEFF).
  let result = s.replace(/[​-‏‪-‮⁠-⁯﻿]/g, '');

  // Step 1 & 2: trim + collapse whitespace
  result = result.trim().replace(/\s+/g, ' ');

  // Step 3: lowercase Latin (leaves Hebrew, digits, symbols unchanged)
  result = result.toLowerCase();

  // Step 4: strip Hebrew niqqud U+0591–U+05C7
  // This range covers cantillation marks and all vowel/diacritic points
  // eslint-disable-next-line no-control-regex
  result = result.replace(/[֑-ׇ]/g, '');

  // Step 5: map final letter forms to standard forms
  result = result
    .replace(/ך/g, 'כ') // ך → כ
    .replace(/ם/g, 'מ') // ם → מ
    .replace(/ן/g, 'נ') // ן → נ
    .replace(/ף/g, 'פ') // ף → פ
    .replace(/ץ/g, 'צ'); // ץ → צ

  return result;
}
