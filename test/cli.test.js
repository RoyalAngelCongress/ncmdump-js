import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeFixture } from './fixture.js';

const cli = fileURLToPath(new URL('../bin/ncmdump.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('CLI output, extraction, overwrite protection, batch failures and dotted filenames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ncmdump-js-'));
  try {
    const fixture = makeFixture();
    const input = join(directory, 'artist.song.NCM');
    const output = join(directory, 'output');
    await writeFile(input, fixture.bytes);
    const first = run(input, '-o', output, '--extract');
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(await readFile(join(output, 'artist.song.flac')), fixture.audio);
    assert.deepEqual(await readFile(join(output, 'artist.song.cover.png')), fixture.cover);
    const json = JSON.parse(await readFile(join(output, 'artist.song.metadata.json'), 'utf8'));
    assert.deepEqual(json.rawMetadata, fixture.metadata);
    assert.equal(run(input, '-o', output).status, 1);
    assert.deepEqual(await readFile(join(output, 'artist.song.flac')), fixture.audio);
    assert.equal(run(input, '-o', output, '--force', '--extract').status, 0);
    const batch = run(join(directory, 'missing.ncm'), input, '--force');
    assert.equal(batch.status, 1);
    assert.deepEqual(await readFile(join(directory, 'artist.song.flac')), fixture.audio);
    assert.equal(run('--bad-option').status, 1);
    assert.equal(run('-o').status, 1);
    assert.equal(run().status, 1);
    assert.equal(run('--help').status, 0);
    assert.ok((await readdir(output)).includes('artist.song.flac'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
