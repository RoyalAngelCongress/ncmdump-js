// Run the actual ESM dependency graph in an isolated realm without Node globals.
// The loader is Node-only; the loaded core can only see standard JavaScript APIs.
import { SourceTextModule, createContext, runInContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { makeFixture } from './fixture.js';

const context = createContext({ TextDecoder });
assert.equal(runInContext('typeof process', context), 'undefined');
assert.equal(runInContext('typeof Buffer', context), 'undefined');
assert.equal(runInContext('typeof require', context), 'undefined');
assert.equal(runInContext('typeof crypto', context), 'undefined');
assert.equal(runInContext('typeof atob', context), 'undefined');
const cache = new Map();
async function load(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  const module = new SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href });
  cache.set(url.href, module);
  await module.link((specifier, parent) => {
    assert.ok(specifier.startsWith('./'), `Nonportable import: ${specifier}`);
    return load(new URL(specifier, parent.identifier));
  });
  return module;
}
const entry = await load(new URL('../src/index.js', import.meta.url));
await entry.evaluate();
const fixture = makeFixture();
const result = entry.namespace.decryptNcm(new Uint8Array(fixture.bytes));
assert.deepEqual(Buffer.from(result.audio), fixture.audio);
assert.deepEqual(Buffer.from(result.cover), fixture.cover);
assert.equal(result.metadata.name, fixture.metadata.musicName);
console.log('Portable realm passed: no process, Buffer, require, crypto or atob');
