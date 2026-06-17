/**
 * Deduplication cache with LRU eviction and TTL expiry.
 * In-memory only — no PII stored here; keys are opaque strings.
 */

const DEFAULT_TTL_MS = 600_000; // 10 minutes
const DEFAULT_MAX = 500;

interface Entry {
  expiresAt: number;
}

export class DedupCache {
  private readonly ttlMs: number;
  private readonly max: number;
  /** Insertion/access order — Map iterates in insertion order */
  private readonly store: Map<string, Entry> = new Map();

  constructor(opts?: { ttlMs?: number; max?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.max = opts?.max ?? DEFAULT_MAX;
  }

  /**
   * Returns true if the key was already seen and has not expired
   * (and refreshes its recency so it won't be LRU-evicted soon).
   * Returns false for new/expired keys, and records them.
   */
  seen(key: string): boolean {
    const now = Date.now();
    const entry = this.store.get(key);

    if (entry !== undefined) {
      if (now < entry.expiresAt) {
        // Refresh recency: delete + re-insert moves to end of Map
        this.store.delete(key);
        this.store.set(key, { expiresAt: now + this.ttlMs });
        return true;
      }
      // Expired — treat as unseen; fall through to re-record
      this.store.delete(key);
    }

    // Record the key
    this.store.set(key, { expiresAt: now + this.ttlMs });

    // LRU eviction when over capacity
    if (this.store.size > this.max) {
      // The first key in the Map is the least recently used
      const lruKey = this.store.keys().next().value as string;
      this.store.delete(lruKey);
    }

    return false;
  }
}

/**
 * Builds a stable dedup key from Signal envelope fields.
 * serverGuid is appended only when present.
 */
export function dedupKey(msg: {
  sourceUuid?: string;
  sourceDevice?: number;
  timestamp?: number;
  serverGuid?: string;
}): string {
  const parts: (string | number | undefined)[] = [msg.sourceUuid, msg.sourceDevice, msg.timestamp];
  if (msg.serverGuid !== undefined && msg.serverGuid !== '') {
    parts.push(msg.serverGuid);
  }
  return parts.map((p) => (p === undefined ? '' : String(p))).join(':');
}
