import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateLimiter } from './ratelimit.ts';

describe('RateLimiter', () => {
  it('allows a burst up to capacity, then throttles', () => {
    const t = 0;
    const rl = new RateLimiter(3, 0.5, 100, () => t);
    assert.equal(rl.allow('a'), true);
    assert.equal(rl.allow('a'), true);
    assert.equal(rl.allow('a'), true);
    assert.equal(rl.allow('a'), false); // capacity exhausted, no time passed
  });

  it('refills tokens over time', () => {
    let t = 0;
    const rl = new RateLimiter(1, 0.5, 100, () => t); // 1 token / 2s
    assert.equal(rl.allow('a'), true);
    assert.equal(rl.allow('a'), false);
    t = 2000; // 2s → +1 token
    assert.equal(rl.allow('a'), true);
  });

  it('tracks separate buckets per key', () => {
    const t = 0;
    const rl = new RateLimiter(1, 0.5, 100, () => t);
    assert.equal(rl.allow('a'), true);
    assert.equal(rl.allow('b'), true); // different key, own bucket
    assert.equal(rl.allow('a'), false);
  });

  it('evicts oldest key past max', () => {
    const t = 0;
    const rl = new RateLimiter(1, 0.5, 2, () => t);
    rl.allow('a');
    rl.allow('b');
    rl.allow('c'); // exceeds max=2 → 'a' evicted
    // 'a' is fresh again (evicted → new bucket at full capacity)
    assert.equal(rl.allow('a'), true);
  });
});
