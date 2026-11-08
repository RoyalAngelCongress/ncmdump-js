import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('actual core works in an isolated JavaScript realm without Node or WebCrypto', () => {
  const runner = fileURLToPath(new URL('./portable-runner.js', import.meta.url));
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', runner], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Portable realm passed/);
});
