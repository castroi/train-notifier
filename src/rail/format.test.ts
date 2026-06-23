import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractTrains, formatTrainLine } from './format.ts';
import type { RailApiGetRoutesResult } from './types.ts';

function makeResult(
  overrides: Partial<{
    departureTime: string;
    arrivalTime: string;
    originPlatform: number;
    calcDiffMinutes: number | undefined;
    trainPosition: unknown;
  }>,
): RailApiGetRoutesResult {
  const {
    departureTime = '2024-01-15T07:30:00',
    arrivalTime = '2024-01-15T08:15:00',
    originPlatform = 2,
    calcDiffMinutes,
    trainPosition,
  } = overrides;

  const position =
    trainPosition !== undefined
      ? trainPosition
      : calcDiffMinutes !== undefined
        ? { calcDiffMinutes }
        : null;

  return {
    result: {
      travels: [
        {
          departureTime,
          arrivalTime,
          trains: [
            {
              trainNumber: 100,
              orignStation: 1260,
              destinationStation: 2100,
              originPlatform,
              destPlatform: 1,
              arrivalTime,
              departureTime,
              trainPosition: position,
            },
          ],
        },
      ],
    },
  };
}

describe('formatTrainLine', () => {
  it('renders on-time train with platform', () => {
    const line = formatTrainLine({
      departHHMM: '07:30',
      arriveHHMM: '08:15',
      delayMin: 0,
      platform: 2,
      dayNote: '',
    });
    assert.equal(line, '07:30 → 08:15 · on time · plat 2');
  });

  it('renders delayed train with platform', () => {
    const line = formatTrainLine({
      departHHMM: '07:30',
      arriveHHMM: '08:15',
      delayMin: 5,
      platform: 3,
      dayNote: '',
    });
    assert.equal(line, '07:30 → 08:15 · +5 min · plat 3');
  });

  it('omits platform when platform is 0 (falsy)', () => {
    const line = formatTrainLine({
      departHHMM: '09:00',
      arriveHHMM: '09:45',
      delayMin: 0,
      platform: 0,
      dayNote: '',
    });
    assert.equal(line, '09:00 → 09:45 · on time');
  });

  it('negative delay is treated as on time', () => {
    const line = formatTrainLine({
      departHHMM: '10:00',
      arriveHHMM: '10:30',
      delayMin: -2,
      platform: 1,
      dayNote: '',
    });
    assert.equal(line, '10:00 → 10:30 · on time · plat 1');
  });

  it('appends the day marker when set', () => {
    const line = formatTrainLine({
      departHHMM: '05:45',
      arriveHHMM: '06:18',
      delayMin: 0,
      platform: 1,
      dayNote: 'tomorrow',
    });
    assert.equal(line, '05:45 → 06:18 · on time · plat 1 · tomorrow');
  });
});

describe('extractTrains', () => {
  it('extracts on-time train (null trainPosition → delay=0)', () => {
    const result = makeResult({ originPlatform: 2, calcDiffMinutes: undefined });
    const trains = extractTrains(result, 3, 0);
    assert.equal(trains.length, 1);
    assert.equal(trains[0].delayMin, 0);
    assert.equal(trains[0].platform, 2);
  });

  it('extracts delayed train from trainPosition.calcDiffMinutes', () => {
    const result = makeResult({ calcDiffMinutes: 7, originPlatform: 4 });
    const trains = extractTrains(result, 3, 0);
    assert.equal(trains[0].delayMin, 7);
    assert.equal(trains[0].platform, 4);
  });

  it('respects count limit', () => {
    const multiResult: RailApiGetRoutesResult = {
      result: {
        travels: [
          {
            departureTime: '2024-01-15T07:00:00',
            arrivalTime: '2024-01-15T07:45:00',
            trains: [
              {
                trainNumber: 1,
                orignStation: 1260,
                destinationStation: 2100,
                originPlatform: 1,
                destPlatform: 1,
                arrivalTime: '2024-01-15T07:45:00',
                departureTime: '2024-01-15T07:00:00',
                trainPosition: null,
              },
            ],
          },
          {
            departureTime: '2024-01-15T08:00:00',
            arrivalTime: '2024-01-15T08:45:00',
            trains: [
              {
                trainNumber: 2,
                orignStation: 1260,
                destinationStation: 2100,
                originPlatform: 2,
                destPlatform: 1,
                arrivalTime: '2024-01-15T08:45:00',
                departureTime: '2024-01-15T08:00:00',
                trainPosition: null,
              },
            ],
          },
          {
            departureTime: '2024-01-15T09:00:00',
            arrivalTime: '2024-01-15T09:45:00',
            trains: [
              {
                trainNumber: 3,
                orignStation: 1260,
                destinationStation: 2100,
                originPlatform: 3,
                destPlatform: 1,
                arrivalTime: '2024-01-15T09:45:00',
                departureTime: '2024-01-15T09:00:00',
                trainPosition: null,
              },
            ],
          },
        ],
      },
    };

    const trains = extractTrains(multiResult, 2, 0);
    assert.equal(trains.length, 2);
  });

  it('drops trains whose departure is already past', () => {
    const r: RailApiGetRoutesResult = {
      result: {
        travels: [
          {
            departureTime: '2030-01-01T08:00:00',
            arrivalTime: '2030-01-01T08:45:00',
            trains: [
              {
                trainNumber: 1,
                orignStation: 1260,
                destinationStation: 2100,
                originPlatform: 1,
                destPlatform: 1,
                arrivalTime: '2030-01-01T08:45:00',
                departureTime: '2030-01-01T08:00:00',
                trainPosition: null,
              },
            ],
          },
          {
            departureTime: '2030-01-01T10:00:00',
            arrivalTime: '2030-01-01T10:45:00',
            trains: [
              {
                trainNumber: 2,
                orignStation: 1260,
                destinationStation: 2100,
                originPlatform: 7,
                destPlatform: 1,
                arrivalTime: '2030-01-01T10:45:00',
                departureTime: '2030-01-01T10:00:00',
                trainPosition: null,
              },
            ],
          },
        ],
      },
    };
    // now = 09:00 (same parse path as the fixtures → TZ-consistent comparison)
    const now = new Date('2030-01-01T09:00:00').getTime();
    const trains = extractTrains(r, 3, now);
    assert.equal(trains.length, 1, 'the 08:00 train is past and dropped');
    assert.equal(trains[0].platform, 7, 'only the 10:00 train survives');
  });

  it('is delay-aware: a delayed train is kept until its delayed departure passes', () => {
    const now = new Date('2030-01-01T09:20:00').getTime();

    // Scheduled 09:00 but +30 min → real departure 09:30, still upcoming at 09:20.
    const delayed = makeResult({
      departureTime: '2030-01-01T09:00:00',
      arrivalTime: '2030-01-01T09:45:00',
      calcDiffMinutes: 30,
      originPlatform: 4,
    });
    const keptDelayed = extractTrains(delayed, 3, now);
    assert.equal(keptDelayed.length, 1, 'delayed train still upcoming → kept');
    assert.equal(keptDelayed[0].delayMin, 30);

    // Same 09:00 departure but on time → already past at 09:20 → dropped.
    const onTime = makeResult({
      departureTime: '2030-01-01T09:00:00',
      arrivalTime: '2030-01-01T09:45:00',
      calcDiffMinutes: 0,
    });
    const droppedOnTime = extractTrains(onTime, 3, now);
    assert.equal(droppedOnTime.length, 0, 'on-time 09:00 train is past at 09:20');
  });

  it('handles missing platform (0) correctly', () => {
    const result = makeResult({ originPlatform: 0, calcDiffMinutes: 0 });
    const trains = extractTrains(result, 3, 0);
    assert.equal(trains[0].platform, 0);
    const line = formatTrainLine(trains[0]);
    assert.ok(!line.includes('plat'), 'should omit platform when 0');
  });

  // The boarding station (orignStation) sits mid-route at index 3.
  const ROUTE = [1600, 1500, 1220, 2100, 2200, 2500, 2800, 8600];
  const BOARD = 2100;

  function makePositioned(opts: {
    departureTime: string;
    arrivalTime: string;
    board?: number;
    route?: number[] | undefined;
    currentLastStation?: number;
    calcDiffMinutes?: number;
    nullPosition?: boolean;
  }): RailApiGetRoutesResult {
    const {
      departureTime,
      arrivalTime,
      board = BOARD,
      currentLastStation,
      calcDiffMinutes = 0,
      nullPosition = false,
    } = opts;
    // Honour an explicit `route: undefined` (omitting it defaults to ROUTE).
    const route = 'route' in opts ? opts.route : ROUTE;

    return {
      result: {
        travels: [
          {
            departureTime,
            arrivalTime,
            trains: [
              {
                trainNumber: 1,
                orignStation: board,
                destinationStation: 8600,
                originPlatform: 2,
                destPlatform: 1,
                arrivalTime,
                departureTime,
                trainPosition: nullPosition
                  ? null
                  : { currentLastStation, nextStation: 0, calcDiffMinutes },
                routeStations: route?.map((stationId) => ({ stationId })),
              },
            ],
          },
        ],
      },
    };
  }

  describe('position-based catchability', () => {
    // now = 2030-06-01 12:00 (parsed via same path as fixtures → TZ-consistent)
    const now = new Date('2030-06-01T12:00:00').getTime();

    it('A: keeps a through-train still upstream of board even though its scheduled time passed', () => {
      // Scheduled 11:30 (30m ago), only +5 delay → fallback would DROP it.
      const r = makePositioned({
        departureTime: '2030-06-01T11:30:00',
        arrivalTime: '2030-06-01T13:00:00',
        currentLastStation: 1500, // idx 1 < board idx 3 → not yet arrived
        calcDiffMinutes: 5,
      });
      const trains = extractTrains(r, 3, now);
      assert.equal(trains.length, 1, 'train upstream of board is still catchable');
    });

    it('B: drops a train that has passed the board station despite a future final arrival', () => {
      const r = makePositioned({
        departureTime: '2030-06-01T11:50:00',
        arrivalTime: '2030-06-01T13:00:00', // still en route to terminus
        currentLastStation: 2500, // idx 5 > board idx 3 → already rolled through
      });
      const trains = extractTrains(r, 3, now);
      assert.equal(trains.length, 0, 'train past the board station is gone');
    });

    it('C: keeps a delayed train sitting at the board station', () => {
      const r = makePositioned({
        departureTime: '2030-06-01T11:40:00', // 20m ago by schedule
        arrivalTime: '2030-06-01T12:40:00',
        currentLastStation: 2100, // idx == board idx → at the platform
      });
      const trains = extractTrains(r, 3, now);
      assert.equal(trains.length, 1, 'train boarding at the platform is catchable');
    });

    it('D: falls back to scheduled logic when trainPosition is null', () => {
      // routeStations present but no position → old behavior: past schedule → dropped.
      const r = makePositioned({
        departureTime: '2030-06-01T11:30:00',
        arrivalTime: '2030-06-01T12:15:00',
        nullPosition: true,
      });
      const trains = extractTrains(r, 3, now);
      assert.equal(trains.length, 0, 'no position → scheduled fallback drops the past train');
    });

    it('E: falls back when currentLastStation is not in routeStations (guards indexOf -1)', () => {
      // A naive `indexOf(cur) <= boardIx` would wrongly keep this (-1 <= 3).
      const r = makePositioned({
        departureTime: '2030-06-01T11:30:00',
        arrivalTime: '2030-06-01T12:15:00',
        currentLastStation: 9999, // not on the route
      });
      const trains = extractTrains(r, 3, now);
      assert.equal(trains.length, 0, 'unknown position → fallback, past train dropped');
    });

    it('F: falls back when the board station is not in routeStations', () => {
      // board not on route → boardIx -1 → not usable → fallback keeps a future train.
      const r = makePositioned({
        departureTime: '2030-06-01T12:30:00', // future
        arrivalTime: '2030-06-01T13:15:00',
        board: 7777, // orignStation absent from ROUTE
        currentLastStation: 1500,
      });
      const trains = extractTrains(r, 3, now);
      assert.equal(trains.length, 1, 'unlocatable board → fallback keeps the upcoming train');
    });

    it('G: keeps a usable-position train that is upstream and still on schedule', () => {
      // The common, non-bug case: position usable, upstream of board, future schedule.
      const r = makePositioned({
        departureTime: '2030-06-01T12:30:00', // future
        arrivalTime: '2030-06-01T13:30:00',
        currentLastStation: 1500, // idx 1 < board idx 3 → approaching
      });
      const trains = extractTrains(r, 3, now);
      assert.equal(trains.length, 1, 'upstream train on schedule is catchable');
    });

    it('falls back to scheduled logic when routeStations is absent', () => {
      // API may omit routeStations entirely → route undefined → fallback path.
      const r = makePositioned({
        departureTime: '2030-06-01T11:30:00', // past
        arrivalTime: '2030-06-01T12:15:00',
        route: undefined,
        currentLastStation: 1500,
      });
      const trains = extractTrains(r, 3, now);
      assert.equal(trains.length, 0, 'no routeStations → scheduled fallback drops past train');
    });
  });

  it("marks a next-day departure with dayNote 'tomorrow'", () => {
    // Midday times so the calendar-day comparison is stable across runner TZs.
    const now = new Date('2030-01-01T12:00:00').getTime();
    const r: RailApiGetRoutesResult = {
      result: {
        travels: [
          {
            departureTime: '2030-01-02T12:00:00',
            arrivalTime: '2030-01-02T12:45:00',
            trains: [
              {
                trainNumber: 1,
                orignStation: 1260,
                destinationStation: 2100,
                originPlatform: 1,
                destPlatform: 1,
                arrivalTime: '2030-01-02T12:45:00',
                departureTime: '2030-01-02T12:00:00',
                trainPosition: null,
              },
            ],
          },
        ],
      },
    };
    const t = extractTrains(r, 3, now);
    assert.equal(t.length, 1);
    assert.equal(t[0].dayNote, 'tomorrow');
  });
});
