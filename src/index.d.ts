export type ByteInput = ArrayBuffer | ArrayBufferView;
export type AudioFormat = 'mp3' | 'flac';
export interface NcmOptions {
  /** Default true. False recovers audio when metadata decoding fails. */
  strictMetadata?: boolean;
}
export interface ConvertNcmOptions extends NcmOptions {
  /** Default true: embed available title, artist, album and cover without re-encoding audio. */
  embedMetadata?: boolean;
}
export interface MusicMetadata {
  name: string;
  album: string;
  artist: string;
  artists: string[];
  format: string;
  /** Milliseconds, as stored in the NCM metadata. */
  duration: number;
  bitrate: number;
}
export class NcmError extends Error {
  constructor(code: string, message: string, offset?: number);
  code: string;
  offset: number | undefined;
}
export interface NcmHeader {
  metadata: MusicMetadata | null;
  rawMetadata: Record<string, unknown> | null;
  cover: Uint8Array;
  coverMimeType: 'image/png' | 'image/jpeg' | null;
  /** Stored value only; not verified. */
  crc32: number;
  audioOffset: number;
  audioLength: number;
  warnings: string[];
}
export interface ParsedNcm extends NcmHeader {
  /** Offset relative to the first audio byte, NOT the NCM file start. Copies input. */
  decryptAudioChunk(chunk: ByteInput, offset?: number): Uint8Array;
}
export interface DecryptedNcm extends NcmHeader {
  audio: Uint8Array;
  format: AudioFormat | null;
  mimeType: 'audio/mpeg' | 'audio/flac' | 'application/octet-stream';
}
export function parseNcm(input: ByteInput, options?: NcmOptions): ParsedNcm;
export function decryptNcm(input: ByteInput, options?: NcmOptions): DecryptedNcm;
export function convertNcm(input: ByteInput, options?: ConvertNcmOptions): DecryptedNcm;
export function createCompleteAudio(result: Pick<DecryptedNcm, 'audio' | 'format' | 'metadata' | 'cover'>): Uint8Array;
export function detectAudioFormat(input: ByteInput): AudioFormat | null;
export function detectImageMimeType(input: ByteInput): 'image/png' | 'image/jpeg' | null;
