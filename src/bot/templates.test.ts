import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  askTime,
  refreshNotReady,
  resultsNudge,
  routeReport,
  wizardHeader,
  wizardReport,
  wizardRollover,
} from './templates.ts';
import type { BotRoute } from './types.ts';

const ROUTE: BotRoute = {
  key: 'home',
  index: 1,
  label_en: 'Haifa → Afula',
  label_he: 'חיפה → עפולה',
  aliases: [],
};

// 2026-06-19 12:00 Asia/Jerusalem (UTC+3) → 09:00Z.
const NOW = new Date('2026-06-19T09:00:00Z');
const LINES = ['04:59 → 06:09 · on time · plat 2'];

describe('routeReport header day', () => {
  it("shows today's DD/MM (no year) when the first line has no dayNote", () => {
    const out = routeReport(ROUTE, LINES, NOW, '');
    assert.ok(out.startsWith('Haifa → Afula — 19/06:'), out);
    assert.ok(!out.includes('2026'), `year should be dropped; got: ${out}`);
  });

  it("shows 'tomorrow' when the first line's dayNote is 'tomorrow'", () => {
    const out = routeReport(ROUTE, LINES, NOW, 'tomorrow');
    assert.ok(out.startsWith('Haifa → Afula — tomorrow:'), out);
  });

  it('shows the explicit day marker when the first line carries one', () => {
    const out = routeReport(ROUTE, LINES, NOW, 'Sun 21/06');
    assert.ok(out.startsWith('Haifa → Afula — Sun 21/06:'), out);
  });
});

// ---------------------------------------------------------------------------
// Wizard templates
// ---------------------------------------------------------------------------

/** Jerusalem-local instant for the given June-2026 day/time (IDT = UTC+3). */
function juneAt(day: number, hh: number, mm = 0): Date {
  return new Date(Date.UTC(2026, 5, day, hh - 3, mm));
}

describe('askTime', () => {
  it('personalises the prompt with a day word', () => {
    assert.equal(askTime('tomorrow'), 'When tomorrow?\nnow / custom time (like 7, 19, 12:30)');
  });

  it('falls back to a generic prompt with no day word', () => {
    assert.equal(askTime(), 'When?\nnow / custom time (like 7, 19, 12:30)');
  });
});

describe('wizardHeader', () => {
  it('labels the current Jerusalem day "Today DD Mon" (day-only)', () => {
    const out = wizardHeader('Afula → Akko', juneAt(19, 19, 8), NOW, false);
    assert.equal(out, 'Afula → Akko · Today 19 Jun:');
  });

  it('labels another day by weekday and appends the time', () => {
    const out = wizardHeader('Afula → Akko', juneAt(23, 17, 0), NOW, true);
    assert.equal(out, 'Afula → Akko · Tue 23 Jun, 17:00:');
  });
});

describe('wizardReport', () => {
  it('renders header, bullets, and the follow-up nudge', () => {
    const out = wizardReport('Afula → Akko', LINES, juneAt(23, 17, 0), NOW, true);
    assert.equal(
      out,
      'Afula → Akko · Tue 23 Jun, 17:00:\n • 04:59 → 06:09 · on time · plat 2\n\nRefresh, a different date/time, or a new route?',
    );
  });
});

describe('wizardRollover', () => {
  it('says "today" and shows the next service day when the request was for today', () => {
    const out = wizardRollover(
      'Afula → Akko',
      ['05:21 → 06:30 · on time'],
      juneAt(23, 5, 21), // next service day
      NOW,
      juneAt(19, 23, 55), // requested: today, too late for service
    );
    assert.equal(
      out,
      'No more trains today for Afula → Akko. Next service:\nAfula → Akko · Tue 23 Jun:\n • 05:21 → 06:30 · on time\n\nRefresh, a different date/time, or a new route?',
    );
  });

  it('says "that day" when the request was for a future day', () => {
    const out = wizardRollover(
      'Afula → Akko',
      ['05:21 → 06:30 · on time'],
      juneAt(24, 5, 21),
      NOW,
      juneAt(23, 23, 55), // requested: a future day, not today
    );
    assert.match(out, /^No more trains that day for Afula → Akko\. Next service:/);
  });
});

describe('resultsNudge', () => {
  it('advertises refresh in English and lists no Hebrew', () => {
    const out = resultsNudge();
    assert.equal(out, 'Refresh, a different date/time, or a new route?');
    assert.doesNotMatch(out, /[֐-׿]/);
  });
});

describe('refreshNotReady', () => {
  it('tells the user to finish choosing a route first', () => {
    assert.equal(refreshNotReady(), 'Finish choosing your route first.');
  });
});
