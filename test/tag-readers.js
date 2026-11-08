// Independent test-side readers use Node Buffer; production uses only web APIs.
const syncSize = (data, offset) => [...data.subarray(offset, offset + 4)].reduce((sum, byte) => sum * 128 + byte, 0);
const removeUnsync = (data) => Buffer.from([...data].filter((byte, i, all) => !(byte === 0 && all[i - 1] === 255)));

export function readMp3(input) {
  const bytes = Buffer.from(input);
  const version = bytes[3];
  const size = syncSize(bytes, 6);
  let body = bytes.subarray(10, 10 + size);
  if (version === 3 && (bytes[5] & 128)) body = removeUnsync(body);
  const frames = [];
  for (let offset = 0; offset + 10 <= body.length && body[offset];) {
    const id = body.toString('ascii', offset, offset + 4);
    const length = version === 4 ? syncSize(body, offset + 4) : body.readUInt32BE(offset + 4);
    let value = body.subarray(offset + 10, offset + 10 + length);
    if (version === 4 && (body[offset + 9] & 2)) value = removeUnsync(value);
    frames.push({ id, value });
    offset += 10 + length;
  }
  return {
    version, frames, payload: bytes.subarray(10 + size),
    text(id) {
      const value = frames.find((frame) => frame.id === id)?.value;
      if (!value) return null;
      if (value[0] === 1) return value.subarray(3).toString('utf16le').replace(/\0+$/, '');
      return value.subarray(1).toString(value[0] === 3 ? 'utf8' : 'latin1').replace(/\0+$/, '');
    },
    picture() {
      const value = frames.find((frame) => frame.id === 'APIC')?.value;
      if (!value) return null;
      const mimeEnd = value.indexOf(0, 1);
      const descriptionEnd = value.indexOf(0, mimeEnd + 2);
      return { mime: value.toString('ascii', 1, mimeEnd), type: value[mimeEnd + 1], data: value.subarray(descriptionEnd + 1) };
    },
  };
}

export function readFlac(input) {
  const bytes = Buffer.from(input);
  const blocks = [];
  let offset = 4;
  let last;
  do {
    last = bytes[offset] >> 7;
    const length = bytes.readUIntBE(offset + 1, 3);
    blocks.push({ type: bytes[offset] & 127, body: bytes.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  } while (!last);
  const result = { blocks, payload: bytes.subarray(offset), comments: [], vendor: null, pictures: [] };
  for (const { type, body } of blocks) {
    if (type === 4) {
      const vendorLength = body.readUInt32LE(0);
      result.vendor = body.toString('utf8', 4, 4 + vendorLength);
      const count = body.readUInt32LE(4 + vendorLength);
      let cursor = 8 + vendorLength;
      for (let i = 0; i < count; i++) {
        const length = body.readUInt32LE(cursor);
        result.comments.push(body.toString('utf8', cursor + 4, cursor + 4 + length));
        cursor += 4 + length;
      }
    }
    if (type === 6) {
      const mimeLength = body.readUInt32BE(4);
      const descriptionLength = body.readUInt32BE(8 + mimeLength);
      const dimensionsOffset = 12 + mimeLength + descriptionLength;
      const imageLength = body.readUInt32BE(dimensionsOffset + 16);
      result.pictures.push({
        type: body.readUInt32BE(0), mime: body.toString('ascii', 8, 8 + mimeLength),
        width: body.readUInt32BE(dimensionsOffset), height: body.readUInt32BE(dimensionsOffset + 4),
        data: body.subarray(dimensionsOffset + 20, dimensionsOffset + 20 + imageLength),
      });
    }
  }
  return result;
}
