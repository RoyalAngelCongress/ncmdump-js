// No Buffer, atob, filesystem, or runtime-specific imports in the core.
export function asBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('Expected an ArrayBuffer or ArrayBuffer view');
}

export function ascii(text) {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

export function startsWith(bytes, prefix) {
  return bytes.length >= prefix.length && prefix.every((value, i) => bytes[i] === value);
}

export function decodeBase64(text) {
  const value = text.replace(/[\t\n\r ]/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid Base64 data');
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const output = new Uint8Array(value.length / 4 * 3 - padding);
  let position = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = alphabet.indexOf(value[i]);
    const b = alphabet.indexOf(value[i + 1]);
    const c = value[i + 2] === '=' ? 0 : alphabet.indexOf(value[i + 2]);
    const d = value[i + 3] === '=' ? 0 : alphabet.indexOf(value[i + 3]);
    const word = (a << 18) | (b << 12) | (c << 6) | d;
    output[position++] = word >>> 16;
    if (position < output.length) output[position++] = word >>> 8;
    if (position < output.length) output[position++] = word;
  }
  return output;
}
