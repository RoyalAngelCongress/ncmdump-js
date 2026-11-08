import { decryptNcm } from './ncm.js';
import { createCompleteAudio } from './tags.js';

/** Full conversion by default. decryptNcm remains the raw decryption API. */
export function convertNcm(input, { embedMetadata = true, ...options } = {}) {
  const result = decryptNcm(input, options);
  if (embedMetadata) result.audio = createCompleteAudio(result);
  return result;
}
