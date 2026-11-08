import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompleteAudio, convertNcm, decryptNcm, NcmError } from '../src/index.js';
import { makeFixture, pattern, png, flacAudio } from './fixture.js';
import { readMp3, readFlac } from './tag-readers.js';

const meta = { name: '歌名 🎵', artist: '甲/乙', artists: ['甲', '乙'], album: '专辑', format: 'mp3', duration: 1000, bitrate: 320000 };
const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), pattern(4097), Buffer.from('TAG' + 'x'.repeat(125))]);
const complete = (audio, format, options = {}) => createCompleteAudio({ audio, format, metadata: meta, cover: png, ...options });

function syncSize(value) { return Buffer.from([value >>> 21, (value >>> 14) & 127, (value >>> 7) & 127, value & 127]); }
function id3Frame(id, body, version = 3, flags = Buffer.alloc(2)) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from(id), version === 4 ? syncSize(body.length) : size, flags, body]);
}
function id3Tag(frames, version = 3, flags = 0, footer = false) {
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from([73, 68, 51, version, 0, flags]), syncSize(body.length), body,
    ...(footer ? [Buffer.from([51, 68, 73, version, 0, flags]), syncSize(body.length)] : [])]);
}
function flacBlock(type, body, last = false) {
  const header = Buffer.alloc(4);
  header[0] = type | (last ? 128 : 0);
  header.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([header, body]);
}
function comments(values, vendor = 'original encoder') {
  const u32 = (n) => { const value = Buffer.alloc(4); value.writeUInt32LE(n); return value; };
  return Buffer.concat([u32(Buffer.byteLength(vendor)), Buffer.from(vendor), u32(values.length), ...values.flatMap((value) => {
    const bytes = Buffer.from(value); return [u32(bytes.length), bytes];
  })]);
}

test('MP3 complete audio embeds Unicode title, artist, album and exact front cover', () => {
  const original = Buffer.from(mp3);
  const result = complete(mp3, 'mp3');
  const parsed = readMp3(result);
  assert.equal(parsed.version, 3);
  assert.equal(parsed.text('TIT2'), meta.name);
  assert.equal(parsed.text('TPE1'), meta.artist);
  assert.equal(parsed.text('TALB'), meta.album);
  assert.equal(parsed.picture().mime, 'image/png');
  assert.equal(parsed.picture().type, 3);
  assert.deepEqual(parsed.picture().data, png);
  assert.deepEqual(parsed.payload, original); // Includes unchanged trailing ID3v1.
  assert.deepEqual(mp3, original);
});

test('MP3 replaces managed frames and preserves unrelated existing v2.3 frames', () => {
  const encoder = Buffer.from([0, ...Buffer.from('existing encoder')]);
  const original = Buffer.concat([id3Tag([
    id3Frame('TSSE', encoder), id3Frame('TIT2', Buffer.from([0, 111, 108, 100])),
    id3Frame('APIC', Buffer.from([0, 0, 3, 0, 9])),
  ]), mp3]);
  const parsed = readMp3(complete(original, 'mp3'));
  assert.equal(parsed.frames.filter((frame) => frame.id === 'TIT2').length, 1);
  assert.equal(parsed.frames.filter((frame) => frame.id === 'APIC').length, 1);
  assert.deepEqual(parsed.frames.find((frame) => frame.id === 'TSSE').value, encoder);
  assert.deepEqual(parsed.payload, mp3);
  assert.equal(parsed.text('TIT2'), meta.name);
});

test('MP3 keeps v2.4, uses UTF-8 and handles an existing footer and unsynchronised new image', () => {
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 0, 255, 0, 0, 255, 217]);
  const original = Buffer.concat([id3Tag([id3Frame('TSSE', Buffer.from([3, 97]), 4)], 4, 0x10, true), mp3]);
  const parsed = readMp3(complete(original, 'mp3', { cover: jpeg }));
  assert.equal(parsed.version, 4);
  assert.equal(parsed.frames.find((frame) => frame.id === 'TIT2').value[0], 3);
  assert.equal(parsed.text('TIT2'), meta.name);
  assert.deepEqual(parsed.picture().data, jpeg);
  assert.deepEqual(parsed.payload, mp3);
});

test('MP3 v2.3 global unsynchronisation preserves opaque existing bytes and cover bytes', () => {
  const originalBody = Buffer.from([255, 0, 225, 255, 0, 0, 8]);
  const original = Buffer.concat([id3Tag([id3Frame('PRIV', originalBody)], 3, 0x80), mp3]);
  // Correct the original frame's decoded body length: two inserted zeroes are not counted.
  original.writeUInt32BE(5, 14);
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 0, 255, 0, 0, 255, 217]);
  const parsed = readMp3(complete(original, 'mp3', { cover: jpeg }));
  assert.deepEqual(parsed.frames.find((frame) => frame.id === 'PRIV').value, Buffer.from([255, 225, 255, 0, 8]));
  assert.deepEqual(parsed.picture().data, jpeg);
  assert.deepEqual(parsed.payload, mp3);
});

test('partial NCM tags keep existing fields and picture when replacements are absent', () => {
  const first = complete(mp3, 'mp3');
  const second = complete(first, 'mp3', { metadata: { name: '新标题' }, cover: new Uint8Array() });
  const parsed = readMp3(second);
  assert.equal(parsed.text('TIT2'), '新标题');
  assert.equal(parsed.text('TPE1'), meta.artist);
  assert.deepEqual(parsed.picture().data, png);
  assert.deepEqual(parsed.payload, mp3);
});

test('ID3 extended headers are removed on update and tag-alter frames are discarded', () => {
  for (const version of [3, 4]) {
    const extended = version === 3 ? Buffer.from([0, 0, 0, 6, 0, 0, 0, 0, 0, 0])
      : Buffer.from([0, 0, 0, 6, 1, 0]);
    const discard = id3Frame('PRIV', Buffer.from([1]), version, Buffer.from([version === 3 ? 0x80 : 0x40, 0]));
    const original = Buffer.concat([id3Tag([extended, discard], version, 0x40), mp3]);
    const parsed = readMp3(complete(original, 'mp3'));
    assert.ok(!parsed.frames.some((frame) => frame.id === 'PRIV'));
    assert.equal(parsed.text('TIT2'), meta.name);
    assert.deepEqual(parsed.payload, mp3);
  }
});

test('v2.4 global unsynchronisation is preserved as per-frame flags', () => {
  const original = Buffer.concat([id3Tag([
    id3Frame('PRIV', Buffer.from([255, 0, 224, 9]), 4),
  ], 4, 0x80), mp3]);
  const parsed = readMp3(complete(original, 'mp3'));
  assert.deepEqual(parsed.frames.find((frame) => frame.id === 'PRIV').value, Buffer.from([255, 224, 9]));
  assert.equal(parsed.text('TIT2'), meta.name);
  assert.deepEqual(parsed.payload, mp3);
});

test('repeated full conversion does not accumulate tags or lose payload', () => {
  for (const [format, audio, reader] of [['mp3', mp3, readMp3], ['flac', flacAudio(), readFlac]]) {
    const once = complete(audio, format);
    const twice = complete(once, format);
    assert.deepEqual(Buffer.from(twice), Buffer.from(once));
    assert.deepEqual(reader(twice).payload, format === 'mp3' ? mp3 : readFlac(audio).payload);
  }
});

test('FLAC complete audio embeds separate artist comments and picture, preserves STREAMINFO/frames', () => {
  const audio = flacAudio();
  const parsed = readFlac(complete(audio, 'flac'));
  assert.ok(parsed.comments.includes('TITLE=' + meta.name));
  assert.ok(parsed.comments.includes('ALBUM=' + meta.album));
  assert.deepEqual(parsed.comments.filter((entry) => entry.startsWith('ARTIST=')), ['ARTIST=甲', 'ARTIST=乙']);
  assert.equal(parsed.pictures[0].type, 3);
  assert.equal(parsed.pictures[0].mime, 'image/png');
  assert.equal(parsed.pictures[0].width, 1);
  assert.equal(parsed.pictures[0].height, 1);
  assert.deepEqual(parsed.pictures[0].data, png);
  assert.deepEqual(parsed.blocks[0].body, readFlac(audio).blocks[0].body);
  assert.deepEqual(parsed.payload, readFlac(audio).payload);
});

test('FLAC preserves vendor, unknown comments, application and seektable blocks', () => {
  const streaminfo = readFlac(flacAudio()).blocks[0].body;
  const audio = Buffer.concat([Buffer.from('fLaC'), flacBlock(0, streaminfo),
    flacBlock(2, Buffer.from('TESTapplication')), flacBlock(3, Buffer.alloc(18)),
    flacBlock(4, comments(['title=old', 'ARTIST=old', 'GENRE=Test', 'CUSTOM=保留'])),
    flacBlock(1, Buffer.alloc(12), true), pattern(123)]);
  const parsed = readFlac(complete(audio, 'flac'));
  assert.equal(parsed.vendor, 'original encoder');
  assert.ok(parsed.comments.includes('CUSTOM=保留'));
  assert.ok(parsed.comments.includes('GENRE=Test'));
  assert.ok(!parsed.comments.includes('title=old'));
  assert.deepEqual(parsed.blocks.find((block) => block.type === 2).body, Buffer.from('TESTapplication'));
  assert.deepEqual(parsed.blocks.find((block) => block.type === 3).body, Buffer.alloc(18));
  assert.deepEqual(parsed.payload, pattern(123));
});

test('cover-only metadata and no metadata are supported for both formats', () => {
  for (const [format, audio, reader] of [['mp3', mp3, readMp3], ['flac', flacAudio(), readFlac]]) {
    const result = complete(audio, format, { metadata: null });
    assert.ok(format === 'mp3' ? reader(result).picture() : reader(result).pictures.length);
    const nothing = complete(audio, format, { metadata: null, cover: new Uint8Array() });
    assert.deepEqual(Buffer.from(nothing), audio);
    assert.notEqual(nothing.buffer, audio.buffer);
  }
});

test('complete conversion is the new API default, raw decrypt API and opt-out stay byte exact', () => {
  const fixture = makeFixture();
  const raw = decryptNcm(fixture.bytes);
  assert.deepEqual(Buffer.from(raw.audio), fixture.audio);
  assert.deepEqual(Buffer.from(convertNcm(fixture.bytes, { embedMetadata: false }).audio), fixture.audio);
  const output = convertNcm(fixture.bytes);
  assert.ok(readFlac(output.audio).comments.includes('TITLE=' + fixture.metadata.musicName));
  assert.deepEqual(readFlac(output.audio).payload, readFlac(raw.audio).payload);
});

test('malformed tags fail explicitly rather than dropping or cutting audio', () => {
  const failures = [
    () => complete(Buffer.from('ID3'), 'mp3'),
    () => complete(Buffer.concat([Buffer.from([73, 68, 51, 2, 0, 0, 0, 0, 0, 0]), mp3]), 'mp3'),
    () => complete(Buffer.from('ID3\x03\0\0\x7f\x7f\x7f\x7f'), 'mp3'),
    () => complete(Buffer.from('fLaC'), 'flac'),
    () => complete(Buffer.concat([Buffer.from('fLaC'), flacBlock(1, Buffer.alloc(34), true)]), 'flac'),
    () => complete(mp3, null),
    () => complete(mp3, 'mp3', { cover: new Uint8Array([1, 2, 3]) }),
  ];
  for (const action of failures) assert.throws(action, (error) => error instanceof NcmError && error.code === 'ERR_TAGS');
});

test('malformed and duplicate FLAC comment blocks fail instead of silently losing fields', () => {
  const streaminfo = readFlac(flacAudio()).blocks[0].body;
  for (const bodies of [[Buffer.alloc(4)], [Buffer.from([0, 0, 0, 0, 255, 255, 255, 255])], [comments([]), comments([])]]) {
    const audio = Buffer.concat([Buffer.from('fLaC'), flacBlock(0, streaminfo),
      ...bodies.map((body, i) => flacBlock(4, body, i === bodies.length - 1)), pattern(12)]);
    assert.throws(() => complete(audio, 'flac'), (error) => error.code === 'ERR_TAGS');
  }
});
