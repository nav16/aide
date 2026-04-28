// Run: node tools/create-icons.js
// Generates icons/icon16.png, icons/icon48.png, icons/icon128.png
// No external dependencies — pure Node.js with built-in zlib.

'use strict';

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// CRC32 table
const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC[i] = c;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeB = Buffer.from(type, 'ascii');
  const lenB  = Buffer.allocUnsafe(4); lenB.writeUInt32BE(data.length);
  const crcB  = Buffer.allocUnsafe(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([lenB, typeB, data, crcB]);
}

function makePNG(size, pixelFn) {
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 2; // color type: RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0]; // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelFn(x, y, size);
      row.push(clamp(r), clamp(g), clamp(b));
    }
    rows.push(Buffer.from(row));
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG sig
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }

// Purple 4-pointed star on white background
function pixel(x, y, size) {
  const cx  = (size - 1) / 2;
  const cy  = (size - 1) / 2;
  const dx  = x - cx;
  const dy  = y - cy;
  const r   = Math.sqrt(dx * dx + dy * dy);
  const maxR = size * 0.44;

  if (r > maxR) return [255, 255, 255]; // white background

  const angle = Math.atan2(dy, dx);
  // 4-point star: radius oscillates between innerR and outerR
  const outerR = maxR;
  const innerR = maxR * 0.38;
  const starR  = innerR + (outerR - innerR) * Math.pow(Math.abs(Math.cos(2 * angle)), 1.8);

  if (r > starR) return [255, 255, 255]; // outside star points

  // Purple fill, lighter toward center
  const t  = r / starR;
  const rr = 120 - t * 25;
  const g  = 70  - t * 15;
  const b  = 210 - t * 40;
  return [rr, g, b];
}

const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const out = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(out, makePNG(size, pixel));
  console.log(`Created ${out}`);
}
