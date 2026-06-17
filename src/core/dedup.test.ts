import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DedupCache, dedupKey } from './dedup.ts';

describe('DedupCache', () => {
  it('returns false on first sight and true on duplicate', () => {
    const cache = new DedupCache();
    const key = 'uuid-1:1:1000000';
    assert.equal(cache.seen(key), false, 'first call should return false');
    assert.equal(cache.seen(key), true, 'second call should return true');
  });

  it('returns false for a distinct key (different timestamp)', () => {
    const cache = new DedupCache();
    assert.equal(cache.seen('uuid-1:1:1000000'), false);
    assert.equal(cache.seen('uuid-1:1:2000000'), false, 'different timestamp is a new message');
  });

  it('re-allows a key after TTL expiry', async () => {
    const cache = new DedupCache({ ttlMs: 20 }); // 20 ms TTL
    const key = 'uuid-exp:1:999';
    assert.equal(cache.seen(key), false);
    assert.equal(cache.seen(key), true, 'still within TTL');
    await new Promise((r) => setTimeout(r, 30)); // wait for expiry
    assert.equal(cache.seen(key), false, 'should be re-allowed after TTL');
  });

  it('evicts the LRU entry when max is exceeded', () => {
    const cache = new DedupCache({ max: 2, ttlMs: 60_000 });
    // Insert 'a' (LRU) then 'b' — store: {a, b}
    assert.equal(cache.seen('a'), false);
    assert.equal(cache.seen('b'), false);
    // Re-access 'a' to promote it — store becomes {b, a} (b is now LRU)
    assert.equal(cache.seen('a'), true);
    // Insert 'c' — triggers eviction of LRU ('b') → store: {a, c}
    assert.equal(cache.seen('c'), false);
    // 'b' was evicted — should register as new
    assert.equal(cache.seen('b'), false, "'b' should have been evicted");
    // After reinserting 'b', 'a' was the new LRU and gets evicted
    // Verify 'c' is still present (it was MRU before 'b' was added)
    assert.equal(cache.seen('c'), true, "'c' should still be present");
  });
});

describe('dedupKey', () => {
  it('joins parts with colons and omits absent serverGuid', () => {
    const key = dedupKey({ sourceUuid: 'u1', sourceDevice: 2, timestamp: 123 });
    assert.equal(key, 'u1:2:123');
  });

  it('includes serverGuid when present', () => {
    const key = dedupKey({
      sourceUuid: 'u1',
      sourceDevice: 2,
      timestamp: 123,
      serverGuid: 'guid-abc',
    });
    assert.equal(key, 'u1:2:123:guid-abc');
  });

  it('handles undefined fields gracefully', () => {
    const key = dedupKey({});
    assert.equal(key, '::');
  });

  it('omits empty string serverGuid', () => {
    const key = dedupKey({ sourceUuid: 'u', sourceDevice: 1, timestamp: 1, serverGuid: '' });
    assert.equal(key, 'u:1:1');
  });
});
