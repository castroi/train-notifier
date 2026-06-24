import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  combine,
  type DateSlot,
  describeDay,
  resolveDate,
  resolveTime,
  type TimeSlot,
} from './datetime.ts';

// Fixed reference instant: 2026-06-22 12:00 Asia/Jerusalem (IDT, UTC+3) → 09:00Z.
const NOW = new Date(Date.UTC(2026, 5, 22, 9, 0, 0));

/** Render an instant as Jerusalem "YYYY-MM-DD HH:MM" — host-TZ independent. */
function jeru(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(d)
    .replace(',', '');
}

describe('resolveDate', () => {
  it('resolves "now"', () => {
    assert.deepEqual(resolveDate('now', NOW), { kind: 'now' });
  });

  it('resolves "today" to the Jerusalem date of now', () => {
    assert.deepEqual(resolveDate('today', NOW), { kind: 'date', y: 2026, m: 6, d: 22 });
  });

  it('resolves "tomorrow" to the next Jerusalem day', () => {
    assert.deepEqual(resolveDate('tomorrow', NOW), { kind: 'date', y: 2026, m: 6, d: 23 });
  });

  it('resolves "D/M" with the current year', () => {
    assert.deepEqual(resolveDate('17/09', NOW), { kind: 'date', y: 2026, m: 9, d: 17 });
  });

  it('resolves "D/M/YYYY"', () => {
    assert.deepEqual(resolveDate('17/09/2027', NOW), { kind: 'date', y: 2027, m: 9, d: 17 });
  });

  it('resolves Hebrew "עכשיו" (now)', () => {
    assert.deepEqual(resolveDate('עכשיו', NOW), { kind: 'now' });
  });

  it('resolves Hebrew "היום" (today), incl. final-letter normalization', () => {
    assert.deepEqual(resolveDate('היום', NOW), { kind: 'date', y: 2026, m: 6, d: 22 });
    // Padded / wrapped in an RTL mark still resolves (normalize() strips them).
    assert.deepEqual(resolveDate(' ‏היום ', NOW), { kind: 'date', y: 2026, m: 6, d: 22 });
  });

  it('resolves Hebrew "מחר" (tomorrow)', () => {
    assert.deepEqual(resolveDate('מחר', NOW), { kind: 'date', y: 2026, m: 6, d: 23 });
  });

  it('rejects weekday words (Phase 2)', () => {
    assert.equal(resolveDate('sunday', NOW), null);
    assert.equal(resolveDate('ראשון', NOW), null);
  });

  it('rejects garbage', () => {
    assert.equal(resolveDate('banana', NOW), null);
  });

  it('rejects out-of-range month/day', () => {
    assert.equal(resolveDate('40/13', NOW), null);
  });

  it('rejects a bare hour (that is a time, not a date)', () => {
    assert.equal(resolveDate('8', NOW), null);
  });
});

describe('resolveTime', () => {
  it('resolves "now"', () => {
    assert.deepEqual(resolveTime('now'), { kind: 'now' });
  });

  it('resolves Hebrew "עכשיו" (now)', () => {
    assert.deepEqual(resolveTime('עכשיו'), { kind: 'now' });
  });

  it('resolves "HH:MM"', () => {
    assert.deepEqual(resolveTime('17:00'), { kind: 'hm', hh: 17, mm: 0 });
    assert.deepEqual(resolveTime('12:30'), { kind: 'hm', hh: 12, mm: 30 });
  });

  it('resolves a bare hour as HH:00 (24h)', () => {
    assert.deepEqual(resolveTime('7'), { kind: 'hm', hh: 7, mm: 0 });
    assert.deepEqual(resolveTime('19'), { kind: 'hm', hh: 19, mm: 0 });
    assert.deepEqual(resolveTime('8'), { kind: 'hm', hh: 8, mm: 0 });
  });

  it('rejects an invalid time', () => {
    assert.equal(resolveTime('25:00'), null);
    assert.equal(resolveTime('12:60'), null);
    assert.equal(resolveTime('24'), null);
    assert.equal(resolveTime('banana'), null);
  });
});

describe('combine', () => {
  it('date "now" returns now unchanged', () => {
    const out = combine({ kind: 'now' }, { kind: 'now' }, NOW);
    assert.equal(out.getTime(), NOW.getTime());
  });

  it('explicit date + explicit time → that Jerusalem wall-clock', () => {
    const date: DateSlot = { kind: 'date', y: 2026, m: 6, d: 23 };
    const time: TimeSlot = { kind: 'hm', hh: 17, mm: 0 };
    assert.equal(jeru(combine(date, time, NOW)), '23/06/2026 17:00');
  });

  it('explicit date + time "now" → chosen day at the current Jerusalem time', () => {
    const date: DateSlot = { kind: 'date', y: 2026, m: 6, d: 23 };
    // NOW is 12:00 Jerusalem, so the result is 23 Jun 12:00.
    assert.equal(jeru(combine(date, { kind: 'now' }, NOW)), '23/06/2026 12:00');
  });

  it('resolves a winter date across DST (offset is computed, not hard-coded)', () => {
    // Jan 2026: Jerusalem is UTC+2 (IST). 08:00 wall-clock must round-trip.
    const date: DateSlot = { kind: 'date', y: 2026, m: 1, d: 15 };
    const time: TimeSlot = { kind: 'hm', hh: 8, mm: 0 };
    assert.equal(jeru(combine(date, time, NOW)), '15/01/2026 08:00');
  });
});

describe('describeDay', () => {
  it('labels the current day "today"', () => {
    assert.equal(describeDay({ kind: 'date', y: 2026, m: 6, d: 22 }, NOW), 'today');
  });

  it('labels the next day "tomorrow"', () => {
    assert.equal(describeDay({ kind: 'date', y: 2026, m: 6, d: 23 }, NOW), 'tomorrow');
  });

  it('labels any other day "on D/M"', () => {
    assert.equal(describeDay({ kind: 'date', y: 2026, m: 9, d: 17 }, NOW), 'on 17/9');
  });
});
