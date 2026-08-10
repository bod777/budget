/**
 * Generates the PWA icons without an image toolchain.
 *
 * The mark is three ascending bars on a rounded dark square -- legible at
 * 32px on a home screen, which a "€" glyph would not be without a rasteriser.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');
mkdirSync(out, { recursive: true });

const BG = [15, 17, 21];
const BAR = [91, 140, 255];
const BAR_DIM = [70, 100, 190];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, { maskable }) {
  // Maskable icons must survive a circular crop, so the mark shrinks and the
  // background bleeds to the edges.
  const radius = maskable ? 0 : Math.round(size * 0.22);
  const inset = maskable ? size * 0.28 : size * 0.2;
  const rows = [];

  const barCount = 3;
  const gap = size * 0.055;
  const usable = size - inset * 2;
  const barWidth = (usable - gap * (barCount - 1)) / barCount;
  const heights = [0.42, 0.68, 1.0];

  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let colour = BG;
      let alpha = 255;

      if (radius > 0) {
        // Rounded-corner mask.
        const cx = x < radius ? radius : x >= size - radius ? size - radius - 1 : x;
        const cy = y < radius ? radius : y >= size - radius ? size - radius - 1 : y;
        const dist = Math.hypot(x - cx, y - cy);
        if (dist > radius) alpha = 0;
        else if (dist > radius - 1.2) alpha = Math.round(255 * (radius - dist) / 1.2);
      }

      for (let b = 0; b < barCount; b++) {
        const left = inset + b * (barWidth + gap);
        const right = left + barWidth;
        const height = usable * heights[b];
        const top = size - inset - height;
        if (x >= left && x < right && y >= top && y < size - inset) {
          colour = b === barCount - 1 ? BAR : BAR_DIM;
        }
      }

      const offset = 1 + x * 4;
      row[offset] = colour[0];
      row[offset + 1] = colour[1];
      row[offset + 2] = colour[2];
      row[offset + 3] = alpha;
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size, maskable] of [
  ['icon-192.png', 192, true],
  ['icon-512.png', 512, true],
  ['icon-180.png', 180, false],
]) {
  writeFileSync(join(out, name), png(size, { maskable }));
  console.log(`wrote ${name}`);
}

// Crisp vector favicon for desktop tabs.
writeFileSync(
  join(out, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0f1115"/>
  <rect x="13" y="35" width="11" height="16" rx="2" fill="#4664be"/>
  <rect x="26.5" y="26" width="11" height="25" rx="2" fill="#4664be"/>
  <rect x="40" y="13" width="11" height="38" rx="2" fill="#5b8cff"/>
</svg>
`,
);
console.log('wrote icon.svg');
