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
  // Step 1 & 2: trim + collapse whitespace
  let result = s.trim().replace(/\s+/g, ' ');

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
