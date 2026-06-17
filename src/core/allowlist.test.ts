import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashSender, isAllowed } from './allowlist.ts';

describe('isAllowed', () => {
  const list = ['550e8400-e29b-41d4-a716-446655440000', 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'];

  it('returns true for an exact UUID match (case-insensitive)', () => {
    assert.equal(isAllowed('550e8400-e29b-41d4-a716-446655440000', list), true);
  });

  it('returns true for a different-case UUID match', () => {
    assert.equal(isAllowed('550E8400-E29B-41D4-A716-446655440000', list), true);
  });

  it('returns true for a lowercase match of an uppercase allowlist entry', () => {
    assert.equal(isAllowed('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', list), true);
  });

  it('returns false for a UUID not in the allowlist', () => {
    assert.equal(isAllowed('00000000-0000-0000-0000-000000000000', list), false);
  });

  it('returns false when sourceUuid is undefined', () => {
    assert.equal(isAllowed(undefined, list), false);
  });

  it('returns false against an empty allowlist', () => {
    assert.equal(isAllowed('550e8400-e29b-41d4-a716-446655440000', []), false);
  });
});

describe('hashSender', () => {
  const salt = 'test-salt';
  const id = '550e8400-e29b-41d4-a716-446655440000';

  it('is deterministic — same inputs yield same output', () => {
    assert.equal(hashSender(id, salt), hashSender(id, salt));
  });

  it('produces exactly 12 hex characters', () => {
    const result = hashSender(id, salt);
    assert.match(result, /^[0-9a-f]{12}$/, 'must be 12 lowercase hex chars');
  });

  it('is not equal to the raw id', () => {
    assert.notEqual(hashSender(id, salt), id);
  });

  it('different salts produce different hashes', () => {
    assert.notEqual(hashSender(id, 'salt-a'), hashSender(id, 'salt-b'));
  });

  it('different ids produce different hashes with the same salt', () => {
    assert.notEqual(hashSender(id, salt), hashSender('00000000-0000-0000-0000-000000000000', salt));
  });
});
