import { decryptAes128Ecb } from './aes.js';
import { ascii, asBytes, decodeBase64, startsWith } from './bytes.js';

const MAGIC = ascii('CTENFDAM');
const CORE_KEY = ascii('hzHRAmso5kInbaxW');
const META_KEY = ascii("#14ljk_!\\]&0U<'(");
const KEY_PREFIX = ascii('neteasecloudmusic');
const META_PREFIX = ascii("163 key(Don't modify):");
const JSON_PREFIX = ascii('music:');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class NcmError extends Error {
  constructor(code, message, offset) {
    super(message);
    this.name = 'NcmError';
    this.code = code;
    this.offset = offset;
  }
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.position = 0;
  }

  take(length, label) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.position) {
      throw new NcmError('ERR_TRUNCATED', `Truncated NCM ${label}`, this.position);
    }
    const result = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return result;
  }

  uint32(label) {
    this.take(4, label);
    return this.view.getUint32(this.position - 4, true);
  }
}

function xorCopy(bytes, mask) {
  return bytes.map((value) => value ^ mask);
}

function createMask(key) {
  const box = Uint8Array.from({ length: 256 }, (_, i) => i);
  let previous = 0;
  for (let i = 0; i < 256; i++) {
    const index = (box[i] + previous + key[i % key.length]) & 0xff;
    [box[i], box[index]] = [box[index], box[i]];
    previous = index;
  }
  // Unlike ordinary RC4, the box never changes while processing audio.
  const mask = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const j = (i + 1) & 0xff;
    mask[i] = box[(box[j] + box[(box[j] + j) & 0xff]) & 0xff];
  }
  return mask;
}

function normalizeMetadata(raw) {
  const artists = Array.isArray(raw.artist)
    ? raw.artist.filter((item) => Array.isArray(item) && typeof item[0] === 'string')
      .map((item) => item[0])
    : [];
  return {
    name: typeof raw.musicName === 'string' ? raw.musicName : '',
    album: typeof raw.album === 'string' ? raw.album : '',
    artist: artists.join('/'),
    artists,
    format: typeof raw.format === 'string' ? raw.format : '',
    duration: typeof raw.duration === 'number' ? raw.duration : 0,
    bitrate: typeof raw.bitrate === 'number' ? raw.bitrate : 0,
  };
}

function readMetadata(bytes) {
  const decoded = xorCopy(bytes, 0x63);
  if (!startsWith(decoded, META_PREFIX)) throw new Error('Invalid metadata prefix');
  const base64 = new TextDecoder('utf-8', { fatal: true }).decode(decoded.subarray(META_PREFIX.length));
  const decrypted = decryptAes128Ecb(decodeBase64(base64), META_KEY);
  if (!startsWith(decrypted, JSON_PREFIX)) throw new Error('Invalid metadata JSON prefix');
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decrypted.subarray(JSON_PREFIX.length)));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Metadata must be a JSON object');
  }
  return { metadata: normalizeMetadata(raw), rawMetadata: raw };
}

/** Detect a signature, returning null for unknown data. */
export function detectAudioFormat(input) {
  const bytes = asBytes(input);
  if (startsWith(bytes, ascii('fLaC'))) return 'flac';
  if (startsWith(bytes, ascii('ID3'))) return 'mp3';
  // MPEG Layer III frame sync: require a valid version, bitrate, sample rate.
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
    && (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) === 0x02
    && (bytes[2] & 0xf0) !== 0 && (bytes[2] & 0xf0) !== 0xf0
    && (bytes[2] & 0x0c) !== 0x0c) return 'mp3';
  return null;
}

export function detectImageMimeType(input) {
  const bytes = asBytes(input);
  if (startsWith(bytes, PNG)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

/** Parse headers and create a stateless chunk decoder. Input is never modified. */
export function parseNcm(input, { strictMetadata = true } = {}) {
  const bytes = asBytes(input);
  const reader = new Reader(bytes);
  if (!startsWith(reader.take(8, 'magic'), MAGIC)) {
    throw new NcmError('ERR_INVALID_NCM', 'Invalid NCM magic: expected CTENFDAM', 0);
  }
  reader.take(2, 'reserved header');
  const keyLength = reader.uint32('key length');
  if (!keyLength || keyLength % 16 !== 0) {
    throw new NcmError('ERR_KEY', 'Invalid encrypted key length', reader.position - 4);
  }
  const keyOffset = reader.position;
  const encryptedKey = reader.take(keyLength, 'key data');
  let mask;
  try {
    const key = decryptAes128Ecb(xorCopy(encryptedKey, 0x64), CORE_KEY);
    if (!startsWith(key, KEY_PREFIX) || key.length <= KEY_PREFIX.length) {
      throw new Error('Invalid or empty neteasecloudmusic key');
    }
    mask = createMask(key.subarray(KEY_PREFIX.length));
  } catch (error) {
    throw new NcmError('ERR_KEY', `Cannot decrypt NCM key: ${error.message}`, keyOffset);
  }

  const metadataLength = reader.uint32('metadata length');
  const metadataOffset = reader.position;
  const metadataBytes = reader.take(metadataLength, 'metadata');
  let metadata = null;
  let rawMetadata = null;
  const warnings = [];
  if (metadataLength) {
    try {
      ({ metadata, rawMetadata } = readMetadata(metadataBytes));
    } catch (error) {
      const failure = new NcmError('ERR_METADATA', `Cannot decode NCM metadata: ${error.message}`, metadataOffset);
      if (strictMetadata) throw failure;
      warnings.push(failure.message);
    }
  }

  const crc32 = reader.uint32('CRC32');
  reader.take(1, 'image version');
  const coverFrameLength = reader.uint32('cover frame length');
  const imageLength = reader.uint32('image length');
  if (imageLength > coverFrameLength) {
    throw new NcmError('ERR_COVER', 'Image length exceeds the cover frame length', reader.position - 4);
  }
  const coverFrame = reader.take(coverFrameLength, 'cover frame');
  const cover = coverFrame.slice(0, imageLength);

  return {
    metadata,
    rawMetadata,
    cover,
    coverMimeType: detectImageMimeType(cover),
    crc32,
    audioOffset: reader.position,
    audioLength: bytes.length - reader.position,
    warnings,
    decryptAudioChunk(inputChunk, offset = 0) {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new RangeError('Audio offset must be a nonnegative safe integer');
      }
      const output = asBytes(inputChunk).slice();
      // Reduce before adding i, so offsets larger than 2^32 stay correct.
      const start = offset % 256;
      for (let i = 0; i < output.length; i++) output[i] ^= mask[(start + i) & 0xff];
      return output;
    },
  };
}

/** Decrypt a complete container, returning audio, cover, and metadata separately. */
export function decryptNcm(input, options) {
  const bytes = asBytes(input);
  const parsed = parseNcm(bytes, options);
  if (!parsed.audioLength) {
    throw new NcmError('ERR_EMPTY_AUDIO', 'NCM contains no audio payload', parsed.audioOffset);
  }
  const audio = parsed.decryptAudioChunk(bytes.subarray(parsed.audioOffset));
  const detected = detectAudioFormat(audio);
  const hint = parsed.metadata?.format.toLowerCase();
  const format = detected ?? (hint === 'mp3' || hint === 'flac' ? hint : null);
  const warnings = [...parsed.warnings];
  if (detected && hint && detected !== hint) warnings.push(`Audio signature ${detected} overrides metadata format ${hint}`);
  if (!format) warnings.push('Unknown audio format; use the .bin extension');
  const { decryptAudioChunk, ...header } = parsed;
  return {
    ...header,
    warnings,
    audio,
    format,
    mimeType: format === 'mp3' ? 'audio/mpeg' : format === 'flac' ? 'audio/flac' : 'application/octet-stream',
  };
}
