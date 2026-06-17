import { readFileSync } from 'node:fs';
import cron from 'node-cron';
import { parse } from 'yaml';
import { isKnownStation } from '../rail/stations.ts';
import type { Config, TimeWindow } from './types.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{6,14}$/;

function isValidIdentity(value: string): boolean {
  return UUID_RE.test(value) || E164_RE.test(value);
}

/** Zero-pad a single HH:mm token for safe lexical comparison. */
function padHHMM(t: string): string {
  const [h, m] = t.split(':');
  return `${(h ?? '').padStart(2, '0')}:${(m ?? '').padStart(2, '0')}`;
}

/** Returns true if [aStart, aEnd) and [bStart, bEnd) overlap (lexical HH:mm). */
function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  const aS = padHHMM(a.start);
  const aE = padHHMM(a.end);
  const bS = padHHMM(b.start);
  const bE = padHHMM(b.end);
  // Overlap when one starts before the other ends
  return aS < bE && bS < aE;
}

export function validateConfig(cfg: Config): void {
  // --- signal ---
  if (!cfg.signal?.bot_number) {
    throw new Error('Config validation failed: signal.bot_number is missing or empty');
  }

  if (!isValidIdentity(cfg.signal.owner_uuid)) {
    // Do not echo the value — it is a personal identifier (ends up in logs).
    throw new Error(
      'Config validation failed: signal.owner_uuid is neither a valid UUID nor a valid E.164 number',
    );
  }

  cfg.signal.allowlist?.forEach((entry, i) => {
    if (!isValidIdentity(entry)) {
      throw new Error(
        `Config validation failed: allowlist entry [${i}] is neither a valid UUID nor a valid E.164 number`,
      );
    }
  });

  // --- routes ---
  const routeKeys = new Set<string>();
  for (const route of cfg.routes ?? []) {
    if (routeKeys.has(route.key)) {
      throw new Error(`Config validation failed: duplicate route key "${route.key}"`);
    }
    routeKeys.add(route.key);

    if (!isKnownStation(route.from_id)) {
      throw new Error(
        `Config validation failed: route "${route.key}" from_id ${route.from_id} is not a known station`,
      );
    }
    if (!isKnownStation(route.to_id)) {
      throw new Error(
        `Config validation failed: route "${route.key}" to_id ${route.to_id} is not a known station`,
      );
    }
  }

  // --- schedules ---
  const scheduleIds = new Set<string>();
  for (const schedule of cfg.schedules ?? []) {
    if (!schedule.id) {
      throw new Error('Config validation failed: a schedule is missing its id');
    }
    if (scheduleIds.has(schedule.id)) {
      throw new Error(`Config validation failed: duplicate schedule id "${schedule.id}"`);
    }
    scheduleIds.add(schedule.id);

    if (!cron.validate(schedule.cron)) {
      throw new Error(
        `Config validation failed: schedule "${schedule.id}" has an invalid cron expression "${schedule.cron}"`,
      );
    }

    if (!routeKeys.has(schedule.route_key)) {
      throw new Error(
        `Config validation failed: schedule "${schedule.id}" references unknown route key "${schedule.route_key}"`,
      );
    }
  }

  // --- time_windows ---
  const windows: TimeWindow[] = cfg.time_windows ?? [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    const start = padHHMM(w.start);
    const end = padHHMM(w.end);
    if (end <= start) {
      throw new Error(
        `Config validation failed: time_window[${i}] end "${w.end}" must be after start "${w.start}"`,
      );
    }
  }

  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      if (windowsOverlap(windows[i]!, windows[j]!)) {
        throw new Error(
          `Config validation failed: time_windows[${i}] (${windows[i]!.start}–${windows[i]!.end}) and time_windows[${j}] (${windows[j]!.start}–${windows[j]!.end}) overlap`,
        );
      }
    }
  }
}

export function loadConfig(path: string = process.env.CONFIG_PATH ?? './config.yaml'): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Config load failed: cannot read file "${path}": ${(err as Error).message}`);
  }

  const cfg = parse(raw) as Config;
  validateConfig(cfg);
  return cfg;
}
