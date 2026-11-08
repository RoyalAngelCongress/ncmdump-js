// Independent fixture encoder: Node/OpenSSL AES + a direct transcription of
// NeteaseCrypt.BuildKeyBox/Rc4Xor. Never calls the JS decoder to create expectations.
import { createCipheriv } from 'node:crypto';

export const defaultMetadata = {
  musicName: '测试歌曲 · JS 迁移',
  album: '专辑',
  artist: [['歌手甲', 1], ['Artist B', 2]],
  format: 'flac',
  duration: 123456,
  bitrate: 998000,
  musicId: 123456789,
};
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');

export function encryptAes(data, key, padding = true) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(padding);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function pattern(length) {
  return Buffer.from(Array.from({ length }, (_, i) => (i * 73 + (i >>> 3) * 19 + 41) & 255));
}

export function referenceCrypt(data, key) {
  const box = Array.from({ length: 256 }, (_, i) => i);
  let lastByte = 0;
  let keyOffset = 0;
  for (let i = 0; i < 256; i++) {
    const swap = box[i];
    const c = (swap + lastByte + key[keyOffset]) & 255;
    if (++keyOffset >= key.length) keyOffset = 0;
    box[i] = box[c];
    box[c] = swap;
    lastByte = c;
  }
  return Buffer.from(data.map((byte, position) => {
    const j = (position + 1) & 255;
    return byte ^ box[(box[j] + box[(box[j] + j) & 255]) & 255];
  }));
}

function uint32(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

export function makeFixture(options = {}) {
  const key = options.key ?? pattern(144);
  const audio = options.audio ?? Buffer.concat([Buffer.from('fLaC'), pattern(70003)]);
  const metadata = options.metadata === undefined ? defaultMetadata : options.metadata;
  const cover = options.cover ?? png;
  const padding = options.coverPadding ?? Buffer.from([0xee, 0x00, 0x81, 0xff, 0x25]);
  const encryptedKey = encryptAes(options.keyPlaintext ?? Buffer.concat([Buffer.from('neteasecloudmusic'), key]), Buffer.from('hzHRAmso5kInbaxW'));
  const keyBytes = encryptedKey.map((value) => value ^ 0x64);
  let metadataBytes = Buffer.alloc(0);
  if (options.metadataBytes !== undefined) metadataBytes = options.metadataBytes;
  else if (metadata !== null) {
    const plaintext = options.metadataPlaintext ?? Buffer.from('music:' + JSON.stringify(metadata));
    const encrypted = encryptAes(plaintext, Buffer.from("#14ljk_!\\]&0U<'("));
    metadataBytes = Buffer.from("163 key(Don't modify):" + encrypted.toString('base64')).map((value) => value ^ 0x63);
  }
  const metadataLengthOffset = 14 + keyBytes.length;
  const metadataOffset = metadataLengthOffset + 4;
  const coverFrameLengthOffset = metadataOffset + metadataBytes.length + 5;
  const imageLengthOffset = coverFrameLengthOffset + 4;
  const audioOffset = imageLengthOffset + 4 + cover.length + padding.length;
  const bytes = Buffer.concat([
    Buffer.from('CTENFDAM'), Buffer.alloc(2), uint32(keyBytes.length), keyBytes,
    uint32(metadataBytes.length), metadataBytes, uint32(0x81234567), Buffer.from([1]),
    uint32(cover.length + padding.length), uint32(cover.length), cover, padding,
    referenceCrypt(audio, key),
  ]);
  return { bytes, audio, metadata, cover, key, audioOffset, metadataLengthOffset, metadataOffset, coverFrameLengthOffset, imageLengthOffset };
}
