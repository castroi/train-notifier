/**
 * Allowlist checking, sender hashing, and rate-limited unknown-sender logging.
 * Privacy rules:
 *   - Never log raw phone numbers, UUIDs, or message bodies.
 *   - Store/log sender only as a truncated salted HMAC.
 */

import { createHmac } from 'node:crypto';

/**
 * Returns true if sourceUuid is present and matches any entry in the
 * allowlist (case-insensitive).
 */
export function isAllowed(sourceUuid: string | undefined, allowlist: string[]): boolean {
  // Reject undefined AND empty string: an empty key would otherwise collapse
  // distinct senders into one shared conversation flow / rate-limit bucket.
  if (!sourceUuid) return false;
  const lower = sourceUuid.toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === lower);
}

/**
 * Computes a truncated (first 12 hex chars) HMAC-SHA256 of id using salt.
 * Deterministic and safe to log — does not reveal the original id.
 */
export function hashSender(id: string, salt: string): string {
  return createHmac('sha256', salt).update(id).digest('hex').slice(0, 12);
}

/** Per-process tracking for rate-limited logging: hashedId → last-logged timestamp */
const _lastLogged: Map<string, number> = new Map();
const LOG_INTERVAL_MS = 60_000; // ~60 seconds

/**
 * Logs that an unknown sender was seen, at most once per ~60 s per hashed id.
 * Never logs the raw id, the UUID, phone number, or any message body.
 */
export function logUnknownSender(hashedId: string): void {
  const now = Date.now();
  const last = _lastLogged.get(hashedId) ?? 0;
  if (now - last < LOG_INTERVAL_MS) return;
  _lastLogged.set(hashedId, now);
  // Only log the hashed id — no raw identity, no message content
  console.log(`[allowlist] unknown sender hash=${hashedId}`);
}
