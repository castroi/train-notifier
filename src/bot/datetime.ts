/**
 * Standalone date/time resolver for the guided wizard (wizard plan §9.3).
 *
 * Pure functions, no I/O and no dependency on the conversation store, so the
 * later Phase-2 one-liner can reuse them unchanged: the wizard hands raw user
 * tokens here and gets back slot values, then an absolute `Asia/Jerusalem`
 * `Date` to feed `fetchRoutes(…, when)`.
 *
 * Accepted tokens (wizard plan §5.3 / §5.4):
 *   date — now | today | tomorrow | D/M | D/M/YYYY   (weekday words are Phase 2)
 *   time — now | HH:MM | bare H/HH (24h)             (no AM/PM)
 */

import { normalize } from './normalize.ts';

export type DateSlot = { kind: 'now' } | { kind: 'date'; y: number; m: number; d: number };
export type TimeSlot = { kind: 'now' } | { kind: 'hm'; hh: number; mm: number };

const TZ = 'Asia/Jerusalem';

// Relative-date/time keywords, EN + HE (issue #19). Built through normalize()
// so Hebrew final-letter folding (היום → היומ) is handled automatically, and so
// a Hebrew-keyboard user need not switch layout to answer the When? prompt.
const NOW_WORDS = new Set(['now', 'עכשיו'].map(normalize));
const TODAY_WORDS = new Set(['today', 'היום'].map(normalize));
const TOMORROW_WORDS = new Set(['tomorrow', 'מחר'].map(normalize));

/** Jerusalem-local Y/M/D for an instant. */
function jerusalemYMD(at: Date): { y: number; m: number; d: number } {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at); // "2026-06-22"
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

/** Jerusalem-local HH:MM (24h) for an instant. */
function jerusalemHM(at: Date): { hh: number; mm: number } {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at); // "14:05"
  const [hh, mm] = s.split(':').map(Number);
  return { hh, mm };
}

/**
 * Minutes Asia/Jerusalem is ahead of UTC at the given instant. Used to convert
 * a Jerusalem wall-clock into an absolute epoch independent of the host TZ
 * (the app container runs TZ=Asia/Jerusalem, but tests/CI may not).
 */
function jerusalemOffsetMs(atUtcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(new Date(atUtcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - atUtcMs;
}

/** Absolute epoch for a Jerusalem wall-clock date/time, host-TZ independent. */
function jerusalemWallClockToDate(y: number, m: number, d: number, hh: number, mm: number): Date {
  // Treat the wall-clock as UTC, then subtract Jerusalem's offset at that
  // instant. One correction is exact outside the brief DST-transition windows.
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return new Date(guess - jerusalemOffsetMs(guess));
}

/** Resolve a date token to a slot, or null if it is not an accepted date form. */
export function resolveDate(token: string, now: Date): DateSlot | null {
  const t = normalize(token);
  if (NOW_WORDS.has(t)) return { kind: 'now' };
  if (TODAY_WORDS.has(t)) return { kind: 'date', ...jerusalemYMD(now) };
  if (TOMORROW_WORDS.has(t)) {
    return { kind: 'date', ...jerusalemYMD(new Date(now.getTime() + 86_400_000)) };
  }
  // D/M or D/M/YYYY — year defaults to the current Jerusalem year.
  const m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (m) {
    const d = Number(m[1]);
    const mon = Number(m[2]);
    const y = m[3] ? Number(m[3]) : jerusalemYMD(now).y;
    if (mon < 1 || mon > 12 || d < 1 || d > 31) return null;
    return { kind: 'date', y, m: mon, d };
  }
  return null;
}

/** Resolve a time token to a slot, or null if it is not an accepted time form. */
export function resolveTime(token: string): TimeSlot | null {
  const t = normalize(token);
  if (NOW_WORDS.has(t)) return { kind: 'now' };
  const hm = t.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const hh = Number(hm[1]);
    const mm = Number(hm[2]);
    if (hh > 23 || mm > 59) return null;
    return { kind: 'hm', hh, mm };
  }
  const bare = t.match(/^(\d{1,2})$/);
  if (bare) {
    const hh = Number(bare[1]);
    if (hh > 23) return null;
    return { kind: 'hm', hh, mm: 0 };
  }
  return null;
}

/**
 * Combine resolved date + time slots into an absolute departure `Date`.
 *   - date `now`        → `now` (time is irrelevant; the "now" fast path).
 *   - time `now`        → the chosen day at the current Jerusalem HH:MM (§4.4).
 *   - explicit HH:MM    → the chosen day at that Jerusalem wall-clock.
 */
export function combine(date: DateSlot, time: TimeSlot, now: Date): Date {
  if (date.kind === 'now') return now;
  const { hh, mm } = time.kind === 'now' ? jerusalemHM(now) : { hh: time.hh, mm: time.mm };
  return jerusalemWallClockToDate(date.y, date.m, date.d, hh, mm);
}

/**
 * Human day word for a resolved date slot relative to `now`, used in the time
 * prompt ("When tomorrow?"): "today" | "tomorrow" | "on D/M".
 */
export function describeDay(date: DateSlot, now: Date): string {
  if (date.kind === 'now') return 'now';
  const today = jerusalemYMD(now);
  const tomorrow = jerusalemYMD(new Date(now.getTime() + 86_400_000));
  if (date.y === today.y && date.m === today.m && date.d === today.d) return 'today';
  if (date.y === tomorrow.y && date.m === tomorrow.m && date.d === tomorrow.d) return 'tomorrow';
  return `on ${date.d}/${date.m}`;
}
