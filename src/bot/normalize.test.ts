import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalize } from './normalize.ts';

describe('normalize', () => {
  it('trims leading and trailing whitespace', () => {
    assert.equal(normalize('  hello  '), 'hello');
  });

  it('collapses internal whitespace to single space', () => {
    assert.equal(normalize('hello   world'), 'hello world');
    assert.equal(normalize('a\t\tb'), 'a b');
    assert.equal(normalize('a  b  c'), 'a b c');
  });

  it('lowercases Latin characters', () => {
    assert.equal(normalize('Hello World'), 'hello world');
    assert.equal(normalize('ABC'), 'abc');
  });

  it('strips Hebrew niqqud (vowel points U+05B0–U+05C7)', () => {
    // בֵּית with dagesh and tsere → בית
    const withNiqqud = 'בֵּית'; // בֵּית
    assert.equal(normalize(withNiqqud), 'בית');
  });

  it('strips Hebrew cantillation marks (U+0591–U+05AF)', () => {
    // word with etnahta (U+0591)
    const withCantillation = 'ב֑ית';
    assert.equal(normalize(withCantillation), 'בית');
  });

  it('converts final letter ך to כ', () => {
    assert.equal(normalize('מלך'), 'מלכ');
  });

  it('converts final letter ם to מ', () => {
    assert.equal(normalize('שלום'), 'שלומ');
  });

  it('converts final letter ן to נ', () => {
    assert.equal(normalize('גן'), 'גנ');
  });

  it('converts final letter ף to פ', () => {
    assert.equal(normalize('אף'), 'אפ');
  });

  it('converts final letter ץ to צ', () => {
    assert.equal(normalize('ארץ'), 'ארצ');
  });

  it('normalizes alias "בית" (no niqqud, no final letters) unchanged', () => {
    // בית has no niqqud and no final letter forms
    assert.equal(normalize('בית'), 'בית');
  });

  it('normalizes alias "עבודה" unchanged', () => {
    assert.equal(normalize('עבודה'), 'עבודה');
  });

  it('strips bidirectional / zero-width marks (Step 0)', () => {
    // Hebrew mobile keyboards wrap RTL text with RLM (U+200F) / LRM (U+200E);
    // left in, "כן" would not match. After Step 0 + final-form mapping → "כנ".
    assert.equal(normalize('‏כן‎'), 'כנ');
    assert.equal(normalize('‫כן‬'), 'כנ'); // bidi embedding
    assert.equal(normalize('כן﻿'), 'כנ'); // BOM / ZWNBSP
  });

  it('strips an edge mark before trimming so leading whitespace still goes', () => {
    // A leading RLM is not whitespace, so trim() alone would not reach the
    // space behind it — Step 0 must run before trim.
    assert.equal(normalize('‏  כן  '), 'כנ');
  });

  it('handles combined niqqud + final letters', () => {
    // שָׁלוֹם with niqqud + final letter ם
    const withBoth = 'שָׁלוֹם';
    assert.equal(normalize(withBoth), 'שלומ');
  });

  it('leaves digits and punctuation untouched', () => {
    assert.equal(normalize('2 trains pls'), '2 trains pls');
    assert.equal(normalize('route-1'), 'route-1');
  });

  it('handles empty string', () => {
    assert.equal(normalize(''), '');
  });

  it('handles whitespace-only string', () => {
    assert.equal(normalize('   '), '');
  });
});
