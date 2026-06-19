import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { customReport, routeReport } from './templates.ts';
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

describe('customReport header day', () => {
  it("shows today's DD/MM when the first line has no dayNote", () => {
    const out = customReport('Haifa → Afula', LINES, NOW, '');
    assert.ok(out.startsWith('Haifa → Afula — 19/06:'), out);
  });

  it('shows the first line dayNote when set', () => {
    const out = customReport('Haifa → Afula', LINES, NOW, 'Sun 21/06');
    assert.ok(out.startsWith('Haifa → Afula — Sun 21/06:'), out);
  });
});
