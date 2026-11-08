import { decryptNcm } from '../src/index.js';

self.onmessage = ({ data }) => {
  try {
    const result = decryptNcm(data.buffer, { strictMetadata: !data.recoverMetadata });
    self.postMessage({ result }, [result.audio.buffer, result.cover.buffer]);
  } catch (error) {
    self.postMessage({ error: { message: error.message, code: error.code, offset: error.offset } });
  }
};
