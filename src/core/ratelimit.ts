/**
 * Per-sender token-bucket rate limiter (plan A04 hardening).
 *
 * Caps how often a single allowlisted sender can trigger work (a rail fetch +
 * Signal send), so a misbehaving / compromised owner device can't drive
 * unbounded outbound calls on the operator's RAIL_API_KEY. In-memory, LRU-
 * bounded; one bucket per sender key.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly max: number;
  private readonly now: () => number;

  /**
   * @param capacity      max burst (tokens available at rest)
   * @param refillPerSec  tokens regained per second
   * @param max           max distinct sender keys retained (LRU)
   * @param now           clock override for testing (ms)
   */
  constructor(capacity = 5, refillPerSec = 0.5, max = 500, now: () => number = () => Date.now()) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.max = max;
    this.now = now;
  }

  /** Consume one token for `key`. Returns true if allowed, false if throttled. */
  allow(key: string): boolean {
    const t = this.now();
    const existing = this.buckets.get(key);
    let tokens: number;

    if (existing === undefined) {
      tokens = this.capacity;
    } else {
      // Refill based on elapsed time, then drop the old entry so re-inserting
      // it below refreshes LRU recency.
      this.buckets.delete(key);
      const elapsedSec = (t - existing.last) / 1000;
      tokens = Math.min(this.capacity, existing.tokens + elapsedSec * this.refillPerSec);
    }

    let allowed = false;
    if (tokens >= 1) {
      tokens -= 1;
      allowed = true;
    }

    this.buckets.set(key, { tokens, last: t });

    // LRU eviction: oldest-inserted key first.
    if (this.buckets.size > this.max) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }

    return allowed;
  }
}
