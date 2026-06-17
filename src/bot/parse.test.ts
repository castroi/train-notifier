import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseInput, resolveEager } from './parse.ts';
import type { BotRoute, BotWindow } from './types.ts';

// ---------------------------------------------------------------------------
// Test fixtures (plan §16.1 / Task 5 spec)
// ---------------------------------------------------------------------------

const ROUTE_WORK: BotRoute = {
  key: 'work',
  index: 1,
  label_en: 'Work',
  label_he: 'עבודה',
  aliases: ['work', 'עבודה'],
};

const ROUTE_HOME: BotRoute = {
  key: 'home',
  index: 2,
  label_en: 'Home',
  label_he: 'בית',
  aliases: ['home', 'בית'],
};

const ROUTES: BotRoute[] = [ROUTE_WORK, ROUTE_HOME];

// Windows matching the plan's locked decisions (§locked-decisions):
//   06:00–10:00 → work
//   15:00–18:00 → home
const WINDOWS: BotWindow[] = [
  { start: '06:00', end: '10:00', route_key: 'work' },
  { start: '15:00', end: '18:00', route_key: 'home' },
];

// ---------------------------------------------------------------------------
// parseInput — plan trace examples §16.1 B/C/D/E/F/G/H
// ---------------------------------------------------------------------------

describe('parseInput — numeric input (rule a)', () => {
  it('trace B: "2" → route2 (home)', () => {
    const result = parseInput('2', ROUTES);
    assert.equal(result.kind, 'route');
    assert.ok(result.kind === 'route');
    assert.equal(result.route.key, 'home');
  });

  it('trace C: "2 trains pls" → route2 (home, trailing text ignored)', () => {
    const result = parseInput('2 trains pls', ROUTES);
    assert.equal(result.kind, 'route');
    assert.ok(result.kind === 'route');
    assert.equal(result.route.key, 'home');
  });

  it('"1" → route1 (work)', () => {
    const result = parseInput('1', ROUTES);
    assert.equal(result.kind, 'route');
    assert.ok(result.kind === 'route');
    assert.equal(result.route.key, 'work');
  });

  it('trace D: "9" → menu (integer out of range)', () => {
    const result = parseInput('9', ROUTES);
    assert.equal(result.kind, 'menu');
  });

  it('"0" → menu (0 is out of 1-based range)', () => {
    const result = parseInput('0', ROUTES);
    assert.equal(result.kind, 'menu');
  });

  it('"3" → menu (3 exceeds routes.length of 2)', () => {
    const result = parseInput('3', ROUTES);
    assert.equal(result.kind, 'menu');
  });

  it('leading whitespace before integer is tolerated', () => {
    const result = parseInput('  2', ROUTES);
    assert.equal(result.kind, 'route');
    assert.ok(result.kind === 'route');
    assert.equal(result.route.key, 'home');
  });
});

describe('parseInput — alias match (rule b)', () => {
  it('trace E: "home" → route2 by Latin alias', () => {
    const result = parseInput('home', ROUTES);
    assert.equal(result.kind, 'route');
    assert.ok(result.kind === 'route');
    assert.equal(result.route.key, 'home');
  });

  it('trace F: "בית" → route2 by Hebrew alias (normalized)', () => {
    const result = parseInput('בית', ROUTES);
    assert.equal(result.kind, 'route');
    assert.ok(result.kind === 'route');
    assert.equal(result.route.key, 'home');
  });

  it('"work" → route1 by Latin alias', () => {
    const result = parseInput('work', ROUTES);
    assert.equal(result.kind, 'route');
    assert.ok(result.kind === 'route');
    assert.equal(result.route.key, 'work');
  });

  it('"עבודה" → route1 by Hebrew alias', () => {
    const result = parseInput('עבודה', ROUTES);
    assert.equal(result.kind, 'route');
    assert.ok(result.kind === 'route');
    assert.equal(result.route.key, 'work');
  });

  it('alias match is case-insensitive for Latin ("HOME" → route2)', () => {
    const result = parseInput('HOME', ROUTES);
    assert.equal(result.kind, 'route');
    assert.ok(result.kind === 'route');
    assert.equal(result.route.key, 'home');
  });

  it('alias match strips niqqud ("בֵּית" with vowel points → route2)', () => {
    const result = parseInput('בֵּית', ROUTES);
    assert.equal(result.kind, 'route');
    assert.ok(result.kind === 'route');
    assert.equal(result.route.key, 'home');
  });
});

describe('parseInput — menu fallback (rule c)', () => {
  it('trace G: "there in 5 min" → menu', () => {
    const result = parseInput('there in 5 min', ROUTES);
    assert.equal(result.kind, 'menu');
  });

  it('trace H: "hello" → menu', () => {
    const result = parseInput('hello', ROUTES);
    assert.equal(result.kind, 'menu');
  });

  it('empty string → menu', () => {
    const result = parseInput('', ROUTES);
    assert.equal(result.kind, 'menu');
  });

  it('whitespace-only → menu', () => {
    const result = parseInput('   ', ROUTES);
    assert.equal(result.kind, 'menu');
  });

  it('"train" (not an alias) → menu', () => {
    const result = parseInput('train', ROUTES);
    assert.equal(result.kind, 'menu');
  });
});

// ---------------------------------------------------------------------------
// resolveEager — plan §5.1 / locked-decisions time windows
// ---------------------------------------------------------------------------

/**
 * Build a Date whose Asia/Jerusalem local time matches the given HH:mm.
 * We use a fixed UTC date and offset: Asia/Jerusalem is UTC+3 (standard)
 * so local = UTC + 3h. We pick a UTC base such that local = HH:mm exactly.
 *
 * For test isolation we construct the UTC epoch directly without relying on
 * the runtime's TZ env, by computing the correct UTC offset via Intl.
 */
function dateAtJerusalemTime(hh: number, mm: number): Date {
  // Pick an arbitrary date (2026-06-15 — a Mon, no DST transition)
  // Jerusalem in June is UTC+3 (IDT)
  // So local HH:mm = UTC(HH-3):mm  →  UTC hours = HH - 3
  const utcHours = hh - 3;
  // Construct via ISO string to avoid local TZ issues
  const utcMs = Date.UTC(2026, 5, 15, utcHours, mm, 0, 0); // month is 0-based
  return new Date(utcMs);
}

describe('resolveEager — window matching', () => {
  it('08:00 Jerusalem → matches work window (06:00–10:00)', () => {
    const now = dateAtJerusalemTime(8, 0);
    const key = resolveEager(now, WINDOWS);
    assert.equal(key, 'work');
  });

  it('06:00 Jerusalem (window start, inclusive) → work', () => {
    const now = dateAtJerusalemTime(6, 0);
    assert.equal(resolveEager(now, WINDOWS), 'work');
  });

  it('09:59 Jerusalem → still work window', () => {
    const now = dateAtJerusalemTime(9, 59);
    assert.equal(resolveEager(now, WINDOWS), 'work');
  });

  it('10:00 Jerusalem (window end, exclusive) → null (no window)', () => {
    const now = dateAtJerusalemTime(10, 0);
    assert.equal(resolveEager(now, WINDOWS), null);
  });

  it('16:00 Jerusalem → matches home window (15:00–18:00)', () => {
    const now = dateAtJerusalemTime(16, 0);
    const key = resolveEager(now, WINDOWS);
    assert.equal(key, 'home');
  });

  it('15:00 Jerusalem (window start, inclusive) → home', () => {
    const now = dateAtJerusalemTime(15, 0);
    assert.equal(resolveEager(now, WINDOWS), 'home');
  });

  it('17:59 Jerusalem → still home window', () => {
    const now = dateAtJerusalemTime(17, 59);
    assert.equal(resolveEager(now, WINDOWS), 'home');
  });

  it('18:00 Jerusalem (window end, exclusive) → null', () => {
    const now = dateAtJerusalemTime(18, 0);
    assert.equal(resolveEager(now, WINDOWS), null);
  });

  it('12:00 Jerusalem → null (between windows)', () => {
    const now = dateAtJerusalemTime(12, 0);
    assert.equal(resolveEager(now, WINDOWS), null);
  });

  it('03:00 Jerusalem → null (before all windows)', () => {
    const now = dateAtJerusalemTime(3, 0);
    assert.equal(resolveEager(now, WINDOWS), null);
  });

  it('window with no route_key returns null', () => {
    const windowsNoKey: BotWindow[] = [{ start: '08:00', end: '10:00' }];
    const now = dateAtJerusalemTime(9, 0);
    assert.equal(resolveEager(now, windowsNoKey), null);
  });

  it('empty windows array returns null', () => {
    const now = dateAtJerusalemTime(8, 0);
    assert.equal(resolveEager(now, []), null);
  });
});
