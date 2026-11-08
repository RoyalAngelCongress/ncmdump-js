import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptNcm, parseNcm, detectAudioFormat, detectImageMimeType, NcmError } from '../src/index.js';
import { decodeBase64 } from '../src/bytes.js';
import { makeFixture, defaultMetadata, pattern, png } from './fixture.js';

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof NcmError && error.code === code && Number.isInteger(error.offset));
}

test('complete FLAC, Unicode metadata, raw fields, cover padding and CRC field', () => {
  const fixture = makeFixture();
  const original = Buffer.from(fixture.bytes);
  const result = decryptNcm(fixture.bytes);
  assert.deepEqual(Buffer.from(result.audio), fixture.audio);
  assert.deepEqual(Buffer.from(result.cover), fixture.cover);
  assert.deepEqual(result.rawMetadata, defaultMetadata);
  assert.equal(result.metadata.name, defaultMetadata.musicName);
  assert.equal(result.metadata.artist, '歌手甲/Artist B');
  assert.deepEqual(result.metadata.artists, ['歌手甲', 'Artist B']);
  assert.equal(result.metadata.duration, 123456);
  assert.equal(result.coverMimeType, 'image/png');
  assert.equal(result.crc32, 0x81234567);
  assert.equal(result.format, 'flac');
  assert.equal(result.mimeType, 'audio/flac');
  assert.equal(result.audioOffset, fixture.audioOffset);
  assert.equal(result.audioLength, fixture.audio.length);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(fixture.bytes, original);
  // Returned buffers own their storage.
  result.audio.fill(0);
  result.cover.fill(0);
  assert.deepEqual(fixture.bytes, original);
});

test('ArrayBuffer and views with nonzero byte offsets, including Node Buffer', () => {
  const fixture = makeFixture();
  const padded = new Uint8Array(fixture.bytes.length + 41);
  padded.set(fixture.bytes, 23);
  const inputs = [
    padded.subarray(23, 23 + fixture.bytes.length),
    new DataView(padded.buffer, 23, fixture.bytes.length),
    Buffer.from(padded.buffer, 23, fixture.bytes.length),
    fixture.bytes.buffer.slice(fixture.bytes.byteOffset, fixture.bytes.byteOffset + fixture.bytes.byteLength),
  ];
  for (const input of inputs) assert.deepEqual(Buffer.from(decryptNcm(input).audio), fixture.audio);
  assert.throws(() => decryptNcm('file.ncm'), TypeError);
  assert.throws(() => decryptNcm([1, 2, 3]), TypeError);
});

test('metadata and cover are optional', () => {
  const fixture = makeFixture({ metadata: null, cover: Buffer.alloc(0), coverPadding: Buffer.alloc(0) });
  const result = decryptNcm(fixture.bytes);
  assert.deepEqual(Buffer.from(result.audio), fixture.audio);
  assert.equal(result.metadata, null);
  assert.equal(result.rawMetadata, null);
  assert.equal(result.cover.length, 0);
  assert.equal(result.coverMimeType, null);
  assert.equal(result.format, 'flac');
});

test('ID3 and bare MPEG MP3, with signature taking precedence over metadata', () => {
  for (const prefix of [Buffer.from('ID3'), Buffer.from([0xff, 0xfb, 0x90, 0x64])]) {
    const fixture = makeFixture({ audio: Buffer.concat([prefix, pattern(1000)]) });
    const result = decryptNcm(fixture.bytes);
    assert.equal(result.format, 'mp3');
    assert.equal(result.mimeType, 'audio/mpeg');
    assert.match(result.warnings[0], /overrides/);
    assert.deepEqual(Buffer.from(result.audio), fixture.audio);
  }
});

test('unknown signature uses a safe metadata hint or returns null', () => {
  const audio = Buffer.from([0, 1, 2, 3]);
  assert.equal(decryptNcm(makeFixture({ audio, metadata: { format: 'MP3' } }).bytes).format, 'mp3');
  for (const format of ['', '../../evil', 'wav']) {
    const result = decryptNcm(makeFixture({ audio, metadata: { format } }).bytes);
    assert.equal(result.format, null);
    assert.equal(result.mimeType, 'application/octet-stream');
    assert.match(result.warnings[0], /Unknown audio format/);
  }
});

test('format and image detection avoid invalid or short signatures', () => {
  assert.equal(detectAudioFormat(Buffer.from('fLaC')), 'flac');
  assert.equal(detectAudioFormat(Buffer.from('ID3')), 'mp3');
  assert.equal(detectAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'mp3');
  for (const bytes of [[], [0xff], [0xff, 0xff, 0xff, 0xff], [0xff, 0xe0, 0, 0], [0xff, 0xeb, 0x90, 0], [0xff, 0xfd, 0x90, 0]]) {
    assert.equal(detectAudioFormat(new Uint8Array(bytes)), null);
  }
  assert.equal(detectImageMimeType(png), 'image/png');
  assert.equal(detectImageMimeType(new Uint8Array([0xff, 0xd8, 0xff])), 'image/jpeg');
  assert.equal(detectImageMimeType(new Uint8Array([1, 2, 3])), null);
});

for (const size of [1, 15, 17, 255, 256, 257, 32767, 32768]) {
  test(`arbitrary ${size}-byte chunks agree with whole-file output`, () => {
    const fixture = makeFixture();
    const parsed = parseNcm(fixture.bytes);
    const encrypted = fixture.bytes.subarray(parsed.audioOffset);
    const output = new Uint8Array(parsed.audioLength);
    // Reverse order proves that the decoder has no implicit cursor state.
    const offsets = Array.from({ length: Math.ceil(encrypted.length / size) }, (_, i) => i * size).reverse();
    for (const offset of offsets) {
      output.set(parsed.decryptAudioChunk(encrypted.subarray(offset, offset + size), offset), offset);
    }
    assert.deepEqual(Buffer.from(output), fixture.audio);
  });
}

test('chunk offsets above 2^32 and near MAX_SAFE_INTEGER retain their phase', () => {
  const fixture = makeFixture();
  const parsed = parseNcm(fixture.bytes);
  const chunk = pattern(19);
  for (const offset of [2 ** 32 + 13, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(parsed.decryptAudioChunk(chunk, offset), parsed.decryptAudioChunk(chunk, offset % 256));
  }
  for (const offset of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parsed.decryptAudioChunk(chunk, offset), RangeError);
  }
});

test('every truncated header position fails rather than seeking beyond the file', () => {
  const fixture = makeFixture();
  for (let cut = 0; cut < fixture.audioOffset; cut++) {
    expectCode(() => parseNcm(fixture.bytes.subarray(0, cut)), 'ERR_TRUNCATED');
  }
});

test('bad magic, invalid key lengths, huge lengths and invalid key plaintext', () => {
  const fixture = makeFixture();
  const badMagic = Buffer.from(fixture.bytes);
  badMagic[0] = 0;
  expectCode(() => decryptNcm(badMagic), 'ERR_INVALID_NCM');
  for (const length of [0, 1, 17, 0xffffffff]) {
    const bytes = Buffer.from(fixture.bytes);
    bytes.writeUInt32LE(length, 10);
    expectCode(() => decryptNcm(bytes), 'ERR_KEY');
  }
  const hugeKey = Buffer.from(fixture.bytes);
  hugeKey.writeUInt32LE(0xfffffff0, 10);
  expectCode(() => decryptNcm(hugeKey), 'ERR_TRUNCATED');
  for (const keyPlaintext of [Buffer.from('neteasecloudmusic'), Buffer.from('bad-prefix-and-key')]) {
    expectCode(() => decryptNcm(makeFixture({ keyPlaintext }).bytes), 'ERR_KEY');
  }
  const corrupt = Buffer.from(fixture.bytes);
  corrupt.fill(0, 14, fixture.metadataLengthOffset);
  expectCode(() => decryptNcm(corrupt), 'ERR_KEY');
});

test('invalid metadata is strict by default; opt-in recovery keeps audio and warnings', () => {
  for (const options of [
    { metadataBytes: Buffer.from('broken') },
    { metadataBytes: Buffer.from("163 key(Don't modify):%%%%").map((x) => x ^ 0x63) },
    { metadataPlaintext: Buffer.from('badprefix') },
    { metadataPlaintext: Buffer.from('music:{') },
    { metadataPlaintext: Buffer.from('music:null') },
    { metadataPlaintext: Buffer.from('music:[]') },
  ]) {
    const fixture = makeFixture(options);
    expectCode(() => decryptNcm(fixture.bytes), 'ERR_METADATA');
    const recovered = decryptNcm(fixture.bytes, { strictMetadata: false });
    assert.deepEqual(Buffer.from(recovered.audio), fixture.audio);
    assert.equal(recovered.metadata, null);
    assert.match(recovered.warnings[0], /metadata/i);
  }
});

test('out-of-bounds metadata length cannot be recovered', () => {
  const fixture = makeFixture();
  fixture.bytes.writeUInt32LE(0xffffffff, fixture.metadataLengthOffset);
  expectCode(() => decryptNcm(fixture.bytes, { strictMetadata: false }), 'ERR_TRUNCATED');
});

test('invalid cover lengths and empty audio', () => {
  const fixture = makeFixture();
  const oversized = Buffer.from(fixture.bytes);
  oversized.writeUInt32LE(0xffffffff, fixture.imageLengthOffset);
  expectCode(() => decryptNcm(oversized), 'ERR_COVER');
  const frame = Buffer.from(fixture.bytes);
  frame.writeUInt32LE(0xffffffff, fixture.coverFrameLengthOffset);
  expectCode(() => decryptNcm(frame), 'ERR_TRUNCATED');
  const empty = makeFixture({ audio: Buffer.alloc(0) });
  assert.equal(parseNcm(empty.bytes).audioLength, 0);
  expectCode(() => decryptNcm(empty.bytes), 'ERR_EMPTY_AUDIO');
});

test('normalization tolerates optional metadata fields without losing raw JSON', () => {
  const raw = { artist: [['甲', 1], null, ['乙'], [23], 'bad'], album: null, duration: 'bad', custom: { foo: 'bar' } };
  const result = decryptNcm(makeFixture({ metadata: raw }).bytes);
  assert.equal(result.metadata.artist, '甲/乙');
  assert.equal(result.metadata.name, '');
  assert.equal(result.metadata.album, '');
  assert.equal(result.metadata.duration, 0);
  assert.deepEqual(result.rawMetadata, raw);
});

test('Base64 standard padding, whitespace and rejection cases', () => {
  for (let length = 0; length < 20; length++) {
    const data = pattern(length);
    assert.deepEqual(Buffer.from(decodeBase64(data.toString('base64'))), data);
  }
  assert.equal(Buffer.from(decodeBase64(' Y W\nJj\r\t ')).toString(), 'abc');
  for (const bad of ['a', 'abc', 'abcde===', 'a===', '====', 'YW$j', 'AA==AA==']) {
    assert.throws(() => decodeBase64(bad), /Base64/);
  }
});
