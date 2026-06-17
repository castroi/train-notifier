import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig, validateConfig } from './load.ts';
import type { Config } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid baseline config used as the starting point for mutation tests. */
function validConfig(): Config {
  return {
    signal: {
      bot_number: '+972500000001',
      owner_uuid: '00000000-0000-0000-0000-000000000000',
      allowlist: ['00000000-0000-0000-0000-000000000000'],
    },
    routes: [
      {
        key: 'work',
        from_id: 1260,
        to_id: 2100,
        label_en: 'Afula → Haifa',
        label_he: 'עפולה → חיפה',
        aliases: ['work'],
      },
      {
        key: 'home',
        from_id: 2100,
        to_id: 1260,
        label_en: 'Haifa → Afula',
        label_he: 'חיפה → עפולה',
        aliases: ['home'],
      },
    ],
    schedules: [
      { id: 's1', cron: '30 6 * * 0-4', route_key: 'work', count: 3 },
      { id: 's2', cron: '0 16 * * 0-4', route_key: 'home', count: 3 },
    ],
    time_windows: [
      { start: '06:00', end: '10:00', route_key: 'work' },
      { start: '15:00', end: '18:00', route_key: 'home' },
    ],
    defaults: { on_demand_count: 2 },
  };
}

function assertThrowsContaining(fn: () => void, substring: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.ok(
      err.message.includes(substring),
      `expected message to contain "${substring}", got: "${err.message}"`,
    );
    return true;
  });
}

// ---------------------------------------------------------------------------
// Happy path — real config.yaml
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('loads and validates the real config.yaml without throwing', () => {
    const cfg = loadConfig('./config.yaml');
    assert.equal(cfg.routes.length, 2);
    assert.equal(cfg.schedules.length, 2);
    assert.equal(cfg.time_windows.length, 2);
    assert.equal(cfg.defaults.on_demand_count, 2);
    assert.ok(cfg.signal.bot_number.length > 0);
  });
});

// ---------------------------------------------------------------------------
// validateConfig rejection paths
// ---------------------------------------------------------------------------

describe('validateConfig — duplicate route key', () => {
  it('throws on duplicate route key', () => {
    const cfg = validConfig();
    cfg.routes[1]!.key = 'work'; // duplicate
    assertThrowsContaining(() => validateConfig(cfg), 'duplicate route key');
  });
});

describe('validateConfig — duplicate schedule id', () => {
  it('throws on duplicate schedule id', () => {
    const cfg = validConfig();
    cfg.schedules[1]!.id = 's1'; // duplicate
    assertThrowsContaining(() => validateConfig(cfg), 'duplicate schedule id');
  });

  it('throws when a schedule is missing its id', () => {
    const cfg = validConfig();
    (cfg.schedules[0] as Partial<(typeof cfg.schedules)[0]>).id = '';
    assertThrowsContaining(() => validateConfig(cfg), 'missing its id');
  });
});

describe('validateConfig — invalid cron expression', () => {
  it('throws on a nonsense cron string', () => {
    const cfg = validConfig();
    cfg.schedules[0]!.cron = 'not a cron';
    assertThrowsContaining(() => validateConfig(cfg), 'invalid cron expression');
  });

  it('throws on a cron with wrong field count', () => {
    const cfg = validConfig();
    cfg.schedules[0]!.cron = '* * * *'; // only 4 fields, needs 5
    assertThrowsContaining(() => validateConfig(cfg), 'invalid cron expression');
  });
});

describe('validateConfig — unknown station id', () => {
  it('throws when from_id is not a known station', () => {
    const cfg = validConfig();
    cfg.routes[0]!.from_id = 9999;
    assertThrowsContaining(() => validateConfig(cfg), 'not a known station');
  });

  it('throws when to_id is not a known station', () => {
    const cfg = validConfig();
    cfg.routes[0]!.to_id = 99999;
    assertThrowsContaining(() => validateConfig(cfg), 'not a known station');
  });
});

describe('validateConfig — schedule references missing route', () => {
  it('throws when route_key does not match any route', () => {
    const cfg = validConfig();
    cfg.schedules[0]!.route_key = 'nonexistent';
    assertThrowsContaining(() => validateConfig(cfg), 'unknown route key');
  });
});

describe('validateConfig — bad UUID / E.164', () => {
  it('throws when owner_uuid is invalid', () => {
    const cfg = validConfig();
    cfg.signal.owner_uuid = 'not-a-uuid';
    assertThrowsContaining(() => validateConfig(cfg), 'owner_uuid');
  });

  it('throws when an allowlist entry is invalid', () => {
    const cfg = validConfig();
    cfg.signal.allowlist = ['bad-entry'];
    assertThrowsContaining(() => validateConfig(cfg), 'allowlist entry');
  });

  it('accepts a valid E.164 number in the allowlist', () => {
    const cfg = validConfig();
    cfg.signal.allowlist = ['+972501234567'];
    assert.doesNotThrow(() => validateConfig(cfg));
  });

  it('accepts a valid E.164 number as owner_uuid', () => {
    const cfg = validConfig();
    cfg.signal.owner_uuid = '+972501234567';
    assert.doesNotThrow(() => validateConfig(cfg));
  });
});

describe('validateConfig — missing bot_number', () => {
  it('throws when bot_number is empty string', () => {
    const cfg = validConfig();
    cfg.signal.bot_number = '';
    assertThrowsContaining(() => validateConfig(cfg), 'bot_number');
  });
});

describe('validateConfig — time_window end <= start', () => {
  it('throws when end equals start', () => {
    const cfg = validConfig();
    cfg.time_windows[0]!.end = '06:00'; // same as start
    assertThrowsContaining(() => validateConfig(cfg), 'must be after start');
  });

  it('throws when end is before start', () => {
    const cfg = validConfig();
    cfg.time_windows[0]!.end = '05:00'; // before start 06:00
    assertThrowsContaining(() => validateConfig(cfg), 'must be after start');
  });
});

describe('validateConfig — overlapping time_windows', () => {
  it('throws when two windows overlap', () => {
    const cfg = validConfig();
    // Second window starts at 09:00, overlapping the first (06:00–10:00)
    cfg.time_windows[1]!.start = '09:00';
    cfg.time_windows[1]!.end = '12:00';
    assertThrowsContaining(() => validateConfig(cfg), 'overlap');
  });

  it('does not throw when windows are adjacent (touching but not overlapping)', () => {
    const cfg = validConfig();
    cfg.time_windows[0]!.start = '06:00';
    cfg.time_windows[0]!.end = '10:00';
    cfg.time_windows[1]!.start = '10:00'; // starts exactly where first ends
    cfg.time_windows[1]!.end = '14:00';
    assert.doesNotThrow(() => validateConfig(cfg));
  });

  it('throws when three windows are defined and two of them overlap', () => {
    const cfg = validConfig();
    cfg.time_windows.push({ start: '09:00', end: '11:00' }); // overlaps first (06:00–10:00)
    assertThrowsContaining(() => validateConfig(cfg), 'overlap');
  });
});
