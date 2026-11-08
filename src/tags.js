// Container metadata only: audio frames are copied without decoding/re-encoding.
import { ascii, asBytes, startsWith } from './bytes.js';
import { detectImageMimeType, NcmError } from './ncm.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fail = (message) => { throw new NcmError('ERR_TAGS', message); };

function concat(parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function uint32(value, littleEndian = false) {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, littleEndian);
  return output;
}

function read32(bytes, offset, littleEndian = false) {
  if (offset + 4 > bytes.length) fail('Truncated audio metadata integer');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian);
}

function syncSafe(value) {
  if (value > 0x0fffffff) fail('ID3 tag is too large');
  return new Uint8Array([value >>> 21, (value >>> 14) & 127, (value >>> 7) & 127, value & 127]);
}

function readSyncSafe(bytes, offset) {
  const chunk = bytes.subarray(offset, offset + 4);
  if (chunk.length !== 4 || chunk.some((byte) => byte > 127)) fail('Invalid ID3 synchsafe size');
  return chunk.reduce((value, byte) => value * 128 + byte, 0);
}

function unsynchronize(bytes) {
  let extra = 0;
  const needsZero = (i) => bytes[i] === 255 && (i + 1 === bytes.length || bytes[i + 1] === 0 || bytes[i + 1] >= 224);
  for (let i = 0; i < bytes.length; i++) if (needsZero(i)) extra++;
  if (!extra) return bytes;
  const output = new Uint8Array(bytes.length + extra);
  let offset = 0;
  for (let i = 0; i < bytes.length; i++) {
    output[offset++] = bytes[i];
    if (needsZero(i)) output[offset++] = 0;
  }
  return output;
}

function deunsynchronize(bytes) {
  const output = new Uint8Array(bytes.length);
  let offset = 0;
  for (let i = 0; i < bytes.length; i++) {
    output[offset++] = bytes[i];
    if (bytes[i] === 255 && bytes[i + 1] === 0) i++;
  }
  return output.subarray(0, offset);
}

function readId3(audio) {
  let offset = 0;
  let version = null;
  const frames = [];
  while (startsWith(audio.subarray(offset), ascii('ID3'))) {
    if (offset + 10 > audio.length) fail('Truncated ID3 header');
    const major = audio[offset + 3];
    const flags = audio[offset + 5];
    if (major !== 3 && major !== 4) fail('Only ID3v2.3/v2.4 tags can be updated; use raw mode for this file');
    if (version !== null && version !== major) fail('Mixed ID3 tag versions; use raw mode for this file');
    version = major;
    if ((flags & (major === 3 ? 0x1f : 0x0f)) || audio[offset + 4] === 255) fail('Invalid ID3 header flags/version');
    const size = readSyncSafe(audio, offset + 6);
    const footer = major === 4 && (flags & 0x10) ? 10 : 0;
    const end = offset + 10 + size;
    if (end + footer > audio.length) fail('Truncated ID3 tag');
    if (footer && (!startsWith(audio.subarray(end), ascii('3DI'))
      || audio[end + 3] !== major || readSyncSafe(audio, end + 6) !== size)) fail('Invalid ID3 footer');
    let body = audio.subarray(offset + 10, end);
    if (major === 3 && (flags & 0x80)) body = deunsynchronize(body);
    let cursor = 0;
    if (flags & 0x40) {
      cursor = major === 3 ? read32(body, 0) + 4 : readSyncSafe(body, 0);
      if (cursor < (major === 3 ? 10 : 6) || cursor > body.length) fail('Invalid ID3 extended header');
    }
    while (cursor < body.length) {
      if (body[cursor] === 0) {
        if (body.subarray(cursor).some((byte) => byte !== 0)) fail('Invalid ID3 padding');
        break;
      }
      if (cursor + 10 > body.length) fail('Truncated ID3 frame header');
      const id = decoder.decode(body.subarray(cursor, cursor + 4));
      if (!/^[A-Z0-9]{4}$/.test(id)) fail('Invalid ID3 frame identifier');
      const length = major === 3 ? read32(body, cursor + 4) : readSyncSafe(body, cursor + 4);
      if (!length || length > body.length - cursor - 10) fail('Invalid ID3 frame size');
      const frameFlags = body.slice(cursor + 8, cursor + 10);
      // Convert v2.4 tag-wide unsynchronisation into per-frame flags.
      if (major === 4 && (flags & 0x80)) frameFlags[1] |= 0x02;
      if (!(frameFlags[0] & (major === 3 ? 0x80 : 0x40))) {
        frames.push({ id, flags: frameFlags, body: body.subarray(cursor + 10, cursor + 10 + length) });
      }
      cursor += 10 + length;
    }
    offset = end + footer;
  }
  return { version: version ?? 3, frames, offset };
}

function textBody(text, version) {
  if (version === 4) return concat([new Uint8Array([3]), encoder.encode(text)]);
  // ID3v2.3 Unicode requires UTF-16 plus BOM, not UTF-8.
  const output = new Uint8Array(3 + text.length * 2);
  output.set([1, 255, 254]);
  const view = new DataView(output.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(3 + i * 2, text.charCodeAt(i), true);
  return output;
}

function writeMp3(audio, fields, cover, mimeType) {
  const parsed = readId3(audio);
  const replacements = new Map(fields.map(([key, value]) => [key, {
    id: key, flags: new Uint8Array(2), body: textBody(value, parsed.version),
  }]));
  if (cover.length) replacements.set('APIC', {
    id: 'APIC', flags: new Uint8Array(2),
    body: concat([new Uint8Array([0]), ascii(mimeType), new Uint8Array([0, 3, 0]), cover]),
  });
  const frames = [...parsed.frames.filter((frame) => !replacements.has(frame.id)), ...replacements.values()];
  const encoded = frames.map((frame) => {
    let body = frame.body;
    const flags = frame.flags.slice();
    if (parsed.version === 4 && replacements.has(frame.id)) {
      body = unsynchronize(body);
      if (body !== frame.body) flags[1] |= 0x02;
    }
    return concat([ascii(frame.id), parsed.version === 4 ? syncSafe(body.length) : uint32(body.length), flags, body]);
  });
  // Write v2.3 without optional tag-wide unsynchronisation. Several mainstream
  // readers advance by physical frame sizes before undoing it, losing later
  // frames when e.g. a UTF-16 BOM inserts an extra byte. Existing tags are still
  // deunsynchronised on read; v2.4 uses its unambiguous per-frame mechanism.
  const body = concat(encoded);
  return concat([
    ascii('ID3'), new Uint8Array([parsed.version, 0, 0]), syncSafe(body.length), body,
    audio.subarray(parsed.offset),
  ]);
}

function readFlac(audio) {
  if (!startsWith(audio, ascii('fLaC'))) fail('Invalid FLAC signature');
  const blocks = [];
  let offset = 4;
  let last = false;
  while (!last) {
    if (offset + 4 > audio.length) fail('Truncated FLAC metadata header');
    last = Boolean(audio[offset] & 0x80);
    const type = audio[offset] & 127;
    const length = audio[offset + 1] * 65536 + audio[offset + 2] * 256 + audio[offset + 3];
    if (type === 127 || offset + 4 + length > audio.length) fail('Invalid FLAC metadata block');
    if ((!blocks.length && (type !== 0 || length !== 34)) || (blocks.length && type === 0)) {
      fail('FLAC must begin with exactly one 34-byte STREAMINFO block');
    }
    blocks.push({ type, body: audio.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  }
  return { blocks, offset };
}

function readComments(body) {
  let cursor = 0;
  const take = () => {
    const length = read32(body, cursor, true);
    cursor += 4;
    if (length > body.length - cursor) fail('Truncated FLAC Vorbis comment');
    const value = body.subarray(cursor, cursor + length);
    cursor += length;
    return value;
  };
  const vendor = take();
  const count = read32(body, cursor, true);
  cursor += 4;
  if (count > Math.floor((body.length - cursor) / 4)) fail('Invalid FLAC Vorbis comment count');
  const comments = [];
  for (let i = 0; i < count; i++) comments.push(take());
  if (cursor !== body.length) fail('Unexpected trailing FLAC Vorbis comment data');
  return { vendor, comments };
}

function pictureDimensions(cover, mimeType) {
  if (mimeType === 'image/png' && cover.length >= 26 && startsWith(cover.subarray(12), ascii('IHDR'))) {
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[cover[25]] ?? 0;
    return [read32(cover, 16), read32(cover, 20), cover[24] * channels, 0];
  }
  if (mimeType === 'image/jpeg') {
    for (let i = 2; i + 3 < cover.length;) {
      if (cover[i++] !== 255) break;
      while (cover[i] === 255) i++;
      const marker = cover[i++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = cover[i] * 256 + cover[i + 1];
      if (length < 2 || i + length > cover.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return [cover[i + 5] * 256 + cover[i + 6], cover[i + 3] * 256 + cover[i + 4], cover[i + 2] * cover[i + 7], 0];
      }
      i += length;
    }
  }
  return [0, 0, 0, 0]; // RFC 9639 permits zero for unknown informational dimensions.
}

function writeFlac(audio, fields, artists, cover, mimeType) {
  const parsed = readFlac(audio);
  const oldComments = parsed.blocks.filter((block) => block.type === 4);
  if (oldComments.length > 1) fail('FLAC contains multiple Vorbis comment blocks');
  const comments = oldComments.length ? readComments(oldComments[0].body)
    : { vendor: encoder.encode('ncmdump-js'), comments: [] };
  const keyMap = { TIT2: 'TITLE', TALB: 'ALBUM', TPE1: 'ARTIST' };
  const replacements = new Map(fields.map(([key, value]) => [keyMap[key], [value]]));
  if (replacements.has('ARTIST') && artists?.length) replacements.set('ARTIST', artists);
  const entries = comments.comments.filter((entry) => {
    const text = decoder.decode(entry);
    return !replacements.has(text.slice(0, text.indexOf('=')).toUpperCase());
  });
  for (const [key, values] of replacements) {
    for (const value of values) entries.push(encoder.encode(`${key}=${value}`));
  }
  const blocks = parsed.blocks.filter((block) => block.type !== 4
    && !(cover.length && block.type === 6 && read32(block.body, 0) === 3));
  blocks.push({ type: 4, body: concat([
    uint32(comments.vendor.length, true), comments.vendor, uint32(entries.length, true),
    ...entries.flatMap((entry) => [uint32(entry.length, true), entry]),
  ]) });
  if (cover.length) {
    const mime = ascii(mimeType);
    blocks.push({ type: 6, body: concat([
      uint32(3), uint32(mime.length), mime, uint32(0),
      ...pictureDimensions(cover, mimeType).map((value) => uint32(value)), uint32(cover.length), cover,
    ]) });
  }
  return concat([ascii('fLaC'), ...blocks.flatMap((block, i) => {
    const length = block.body.length;
    if (length > 0xffffff) fail('FLAC metadata block exceeds the 16 MiB limit');
    return [new Uint8Array([block.type | (i === blocks.length - 1 ? 0x80 : 0), length >>> 16, (length >>> 8) & 255, length & 255]), block.body];
  }), audio.subarray(parsed.offset)]);
}

/** Build a playable file with available title/artist/album and embedded cover. */
export function createCompleteAudio(result) {
  const audio = asBytes(result.audio);
  const cover = result.cover ? asBytes(result.cover) : new Uint8Array(0);
  const metadata = result.metadata;
  const fields = [['TIT2', metadata?.name], ['TPE1', metadata?.artist], ['TALB', metadata?.album]]
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key, value]) => [key, value.replace(/\0/g, '')]);
  if (!fields.length && !cover.length) return audio.slice();
  const mimeType = cover.length ? detectImageMimeType(cover) : null;
  if (cover.length && !mimeType) fail('Unsupported cover image type; use raw mode to keep the original audio');
  if (result.format === 'mp3') return writeMp3(audio, fields, cover, mimeType);
  if (result.format === 'flac') return writeFlac(audio, fields, metadata?.artists, cover, mimeType);
  fail('Cannot embed tags into an unknown audio format; use raw mode');
}
