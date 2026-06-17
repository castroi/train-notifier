import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isFresh, touch } from './heartbeat.ts';

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hb-test-'));
  return join(dir, 'heartbeat');
}

describe('heartbeat', () => {
  it('isFresh returns true immediately after touch', () => {
    const path = tmpFile();
    touch(path);
    assert.equal(isFresh(path, 5_000), true, 'file should be fresh right after touch');
  });

  it('isFresh returns false for a stale timestamp', () => {
    const path = tmpFile();
    // Write a timestamp 10 seconds in the past
    writeFileSync(path, String(Date.now() - 10_000), 'utf8');
    assert.equal(isFresh(path, 5_000), false, 'timestamp older than maxAgeMs should be stale');
  });

  it('isFresh returns false when the file does not exist', () => {
    const path = `${tmpFile()}-nonexistent`;
    assert.equal(isFresh(path, 5_000), false, 'missing file should not be fresh');
  });

  it('touch can be called multiple times; always updates the timestamp', async () => {
    const path = tmpFile();
    touch(path);
    const first = Number(readFileSync(path, 'utf8'));
    await new Promise<void>((r) => setTimeout(r, 5));
    touch(path);
    const second = Number(readFileSync(path, 'utf8'));
    assert.ok(second >= first, 'second touch should have a >= timestamp');
  });
});
