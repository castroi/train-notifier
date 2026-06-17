/**
 * Heartbeat file helpers for Docker HEALTHCHECK.
 * touch() writes the current epoch ms to a file on tmpfs.
 * isFresh() reads it back and checks whether it is within maxAgeMs.
 * Tolerates a missing file (isFresh → false).
 */

import { readFileSync, writeFileSync } from 'node:fs';

const DEFAULT_PATH = process.env.HEARTBEAT_PATH ?? '/run/heartbeat';

/**
 * Writes the current epoch milliseconds to the heartbeat file.
 * A write failure must NOT crash the process: it is called from a timer with
 * no catch, and a failed heartbeat should let the file go stale (triggering a
 * healthcheck restart) rather than hard-crash-looping. Logs and swallows.
 */
export function touch(path: string = DEFAULT_PATH): void {
  try {
    writeFileSync(path, String(Date.now()), 'utf8');
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'heartbeat touch failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Returns true if the heartbeat file exists and its recorded timestamp
 * is no older than maxAgeMs milliseconds ago.
 * Returns false if the file is missing, unreadable, or stale.
 */
export function isFresh(path: string = DEFAULT_PATH, maxAgeMs: number): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // File missing or unreadable — not fresh
    return false;
  }

  const ts = Number(raw.trim());
  if (!Number.isFinite(ts)) return false;

  return Date.now() - ts <= maxAgeMs;
}
