import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isKnownStation, stationName, stationsById } from './stations.ts';

describe('stationName', () => {
  it('returns English name for station 1260 (Afula R.Eitan)', () => {
    assert.equal(stationName(1260, 'english'), 'Afula R.Eitan');
  });

  it('returns English name for station 2100 (Haifa Center - HaShmona)', () => {
    assert.equal(stationName(2100, 'english'), 'Haifa Center - HaShmona');
  });

  it('accepts string ids as well as numbers', () => {
    assert.equal(stationName('1260', 'english'), 'Afula R.Eitan');
    assert.equal(stationName('2100', 'english'), 'Haifa Center - HaShmona');
  });

  it('returns Hebrew name when locale is hebrew', () => {
    assert.equal(stationName(1260, 'hebrew'), 'עפולה ר. איתן');
    assert.equal(stationName(2100, 'hebrew'), 'חיפה - מרכז השמונה');
  });

  it('defaults to english when no locale provided', () => {
    assert.equal(stationName(3700), 'Tel Aviv - Savidor Center');
  });

  it('returns undefined for unknown station id', () => {
    assert.equal(stationName(9999), undefined);
    assert.equal(stationName('0'), undefined);
  });
});

describe('isKnownStation', () => {
  it('returns true for known station ids', () => {
    assert.equal(isKnownStation(1260), true);
    assert.equal(isKnownStation(2100), true);
    assert.equal(isKnownStation('3700'), true);
  });

  it('returns false for unknown station ids', () => {
    assert.equal(isKnownStation(9999), false);
    assert.equal(isKnownStation('0'), false);
  });
});

describe('stationsById map', () => {
  it('has string keys even though source ids are strings', () => {
    assert.ok('1260' in stationsById);
    assert.ok('2100' in stationsById);
  });

  it('map contains expected number of stations', () => {
    const count = Object.keys(stationsById).length;
    assert.ok(count >= 60, `expected at least 60 stations, got ${count}`);
  });
});
