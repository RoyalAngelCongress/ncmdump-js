import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeFixture } from './fixture.js';
import { readFlac } from './tag-readers.js';

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
    const complete = await readFile(join(output, 'artist.song.flac'));
    const tags = readFlac(complete);
    assert.ok(tags.comments.includes('TITLE=' + fixture.metadata.musicName));
    assert.deepEqual(tags.pictures[0].data, fixture.cover);
    assert.deepEqual(tags.payload, readFlac(fixture.audio).payload);
    assert.deepEqual(await readFile(join(output, 'artist.song.cover.png')), fixture.cover);
    const json = JSON.parse(await readFile(join(output, 'artist.song.metadata.json'), 'utf8'));
    assert.deepEqual(json.rawMetadata, fixture.metadata);
    assert.equal(run(input, '-o', output).status, 1);
    assert.deepEqual(await readFile(join(output, 'artist.song.flac')), complete);
    assert.equal(run(input, '-o', output, '--force', '--extract').status, 0);
    const batch = run(join(directory, 'missing.ncm'), input, '--force');
    assert.equal(batch.status, 1);
    assert.deepEqual(await readFile(join(directory, 'artist.song.flac')), complete);
    assert.equal(run(input, '-o', output, '--force', '--raw').status, 0);
    assert.deepEqual(await readFile(join(output, 'artist.song.flac')), fixture.audio);
    assert.equal(run('--bad-option').status, 1);
    assert.equal(run('-o').status, 1);
    assert.equal(run().status, 1);
    assert.equal(run('--help').status, 0);
    assert.ok((await readdir(output)).includes('artist.song.flac'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI reports unsupported full-conversion tags and raw mode still recovers audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ncmdump-js-'));
  try {
    const audio = Buffer.from([73, 68, 51, 2, 0, 0, 0, 0, 0, 0, 255, 251, 144, 100]);
    const fixture = makeFixture({ audio, metadata: { musicName: '标题', format: 'mp3' } });
    const input = join(directory, 'legacy.ncm');
    await writeFile(input, fixture.bytes);
    const failed = run(input);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /raw mode/);
    assert.ok(!(await readdir(directory)).includes('legacy.mp3'));
    assert.equal(run(input, '--raw').status, 0);
    assert.deepEqual(await readFile(join(directory, 'legacy.mp3')), audio);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
