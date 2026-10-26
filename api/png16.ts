import { deflateSync } from 'node:zlib';
import * as zlib from 'node:zlib';

const zlibCrc32 = (zlib as unknown as { crc32?: (data: Buffer) => number }).crc32;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc(buf: Buffer): number {
  if (typeof zlibCrc32 === 'function') return zlibCrc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/**
 * Minimal 16-bit RGBA PNG encoder. libvips/sharp raw input is 8-bit only, so
 * 16-bit masters are encoded here to preserve the source depth (audit C9).
 * Colour tagging is sRGB gAMA + cHRM (not a full ICC profile).
 */
export function encodePng16(width: number, height: number, rgba: Uint16Array): Buffer {
  const channels = 4;
  const rowBytes = width * channels * 2;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter: none
    const rowStart = y * width * channels;
    for (let x = 0; x < width * channels; x++) {
      raw.writeUInt16BE(rgba[rowStart + x] ?? 0, offset);
      offset += 2;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const gamma = Buffer.alloc(4);
  gamma.writeUInt32BE(45455, 0); // 1/2.2 * 100000 (sRGB)

  // sRGB primaries/white point, scaled by 100000.
  const chrm = Buffer.alloc(32);
  const values = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
  values.forEach((value, index) => chrm.writeUInt32BE(value, index * 4));

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('gAMA', gamma),
    chunk('cHRM', chrm),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
