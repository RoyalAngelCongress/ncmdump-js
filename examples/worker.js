import { decryptNcm, createCompleteAudio } from '../src/index.js';

self.onmessage = ({ data }) => {
  try {
    const result = decryptNcm(data.buffer, { strictMetadata: !data.recoverMetadata });
    let completeAudio = null;
    let completeError = null;
    try { completeAudio = createCompleteAudio(result); }
    catch (error) { completeError = error.message; }
    const transfers = [result.audio.buffer, result.cover.buffer];
    if (completeAudio) transfers.push(completeAudio.buffer);
    self.postMessage({ result, completeAudio, completeError }, transfers);
  } catch (error) {
    self.postMessage({ error: { message: error.message, code: error.code, offset: error.offset } });
  }
};
