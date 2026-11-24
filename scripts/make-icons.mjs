// Generates crisp ZX Spectrum 48K Sabre Wulf PWA icons (PNG) with zero external dependencies: `npm run icons`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "icons",
);
mkdirSync(outDir, { recursive: true });

// ---- Tiny dependency-free PNG encoder ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// High-detail 96x64 Sabre Wulf Medallion from the 1984 ROM ($E3A0, $E494, $E588, $E67C; 4 x 48x32 quadrants)
const MEDALLION_QUADRANTS = [
  {
    ox: 0,
    oy: 0,
    pixels: [
      0,0,0,0,0,3,0,0,0,0,0,15,0,0,0,0,0,12,0,0,0,0,0,12,0,0,0,0,0,12,0,31,255,248,0,7,0,127,255,254,0,15,0,127,255,255,240,127,0,248,0,127,255,255,0,224,0,7,255,254,0,224,0,0,127,240,0,224,0,0,0,0,0,224,0,0,0,0,0,224,0,0,0,0,0,224,0,0,0,0,0,224,0,0,0,1,0,224,1,192,0,7,0,224,14,60,0,31,0,224,25,199,0,255,0,224,0,120,231,255,0,224,0,62,127,255,0,224,0,31,223,255,0,224,0,15,63,255,1,224,0,6,254,71,1,224,0,5,248,123,1,192,0,11,132,251,3,192,0,7,124,251,3,192,0,15,158,119,7,128,0,255,231,15,31,129,255,255,248,127,255,7,255,255,255,255,
    ],
  },
  {
    ox: 48,
    oy: 0,
    pixels: [
      192,255,127,255,0,0,224,255,255,255,192,0,97,255,255,255,240,0,99,252,0,14,248,0,103,224,0,1,252,0,207,128,0,0,252,0,223,128,0,0,254,0,255,0,224,0,254,0,255,7,192,1,31,0,127,24,128,0,15,0,0,118,128,0,15,0,1,205,0,0,7,0,3,61,0,0,7,0,54,250,0,0,7,0,109,250,0,0,7,0,219,246,0,0,7,0,190,244,0,0,7,0,175,236,0,0,7,0,255,12,0,0,7,0,255,250,0,0,7,0,255,103,0,0,7,0,255,159,0,0,7,0,255,255,128,0,7,0,255,255,192,0,7,0,255,255,224,0,7,0,254,255,240,0,7,128,254,255,252,0,7,128,254,252,255,0,7,192,253,254,255,224,7,224,253,207,255,248,3,240,253,191,255,254,1,248,252,0,255,255,0,124,
    ],
  },
  {
    ox: 0,
    oy: 32,
    pixels: [
      254,15,255,255,255,255,254,24,15,239,127,240,224,32,3,255,255,199,224,0,96,187,255,28,224,76,224,255,188,216,224,76,195,215,249,145,225,224,7,255,224,177,225,112,31,127,144,33,225,220,121,252,96,97,225,255,255,131,167,197,224,255,252,71,5,134,224,135,243,195,5,133,224,176,205,193,59,5,224,176,12,192,54,3,224,160,6,192,44,3,224,160,3,96,44,3,224,96,1,96,48,7,224,96,0,209,32,15,224,48,0,49,192,15,224,0,0,9,80,31,224,0,0,64,152,31,240,0,0,97,28,63,240,0,0,50,78,63,248,128,0,61,103,190,127,0,0,0,3,126,127,0,0,63,252,252,63,0,0,63,255,252,63,128,0,31,128,240,31,224,0,0,0,0,15,255,255,255,255,255,3,255,255,255,255,255,0,255,255,255,255,255,
    ],
  },
  {
    ox: 48,
    oy: 32,
    pixels: [
      255,255,3,255,192,63,63,255,252,63,224,31,195,255,255,255,240,15,0,63,255,255,252,15,35,207,255,255,254,15,63,239,255,225,254,15,175,240,127,224,31,7,223,255,143,240,1,7,191,255,243,248,0,7,127,223,255,252,0,7,255,191,255,252,0,7,255,63,253,254,0,7,254,63,188,126,0,7,252,63,24,31,0,7,252,62,8,3,0,7,248,28,0,0,0,7,240,24,0,0,0,7,224,0,0,0,0,15,224,0,0,0,0,15,192,0,0,0,0,15,128,0,0,0,0,159,128,0,0,0,0,127,0,0,0,0,0,127,1,255,255,240,0,255,1,255,255,255,255,254,1,255,255,255,255,252,3,252,0,255,255,248,3,224,0,7,255,224,7,192,0,0,0,0,255,128,0,0,0,0,255,0,0,0,0,0,255,0,0,0,0,0,
    ],
  },
];

// Decode the 96x64 medallion bitmap and flood-fill exterior from a 1px padded frame so the
// medallion body is opaque (preventing background stripes from showing inside the plaque).
const MED_W = 96;
const MED_H = 64;
const medInk = new Uint8Array(MED_W * MED_H);
for (const q of MEDALLION_QUADRANTS) {
  let pIdx = 0;
  for (let py = 0; py < 32; py++) {
    for (let bx = 0; bx < 6; bx++) {
      const byte = q.pixels[pIdx++];
      for (let bit = 0; bit < 8; bit++) {
        if ((byte & (0x80 >> bit)) !== 0) {
          medInk[(q.oy + py) * MED_W + (q.ox + bx * 8 + bit)] = 1;
        }
      }
    }
  }
}
// Stitch the missing bottom row (y=31, x=0..47) of the top-left stamp so the rim and snout are seamless
for (let x = 0; x < 48; x++) {
  medInk[31 * MED_W + x] = medInk[30 * MED_W + x] | medInk[32 * MED_W + x];
}

const PAD_W = MED_W + 2;
const PAD_H = MED_H + 2;
const exterior = new Uint8Array(PAD_W * PAD_H);
const queue = [0];
exterior[0] = 1;
while (queue.length > 0) {
  const cur = queue.pop();
  const cx = cur % PAD_W;
  const cy = (cur / PAD_W) | 0;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = cx + dx;
    const ny = cy + dy;
    if (nx < 0 || nx >= PAD_W || ny < 0 || ny >= PAD_H) continue;
    const nIdx = ny * PAD_W + nx;
    if (exterior[nIdx]) continue;
    const mx = nx - 1;
    const my = ny - 1;
    if (mx >= 0 && mx < MED_W && my >= 0 && my < MED_H && medInk[my * MED_W + mx]) {
      continue;
    }
    exterior[nIdx] = 1;
    queue.push(nIdx);
  }
}

function buildPixelCanvas(maskable) {
  // 102x102 logical grid for standard icons (96px-wide medallion fills 94% of icon width!);
  // 128x128 for maskable so the entire 96x64 medallion sits inside Android's 80% safe zone.
  const G = maskable ? 128 : 102;
  const medX = Math.floor((G - MED_W) / 2);
  const medY = Math.floor((G - MED_H) / 2) - 2;
  const grid = Array.from({ length: G * G }, () => [0x00, 0x00, 0x00]);

  const BLACK = [0x00, 0x00, 0x00];
  const ZX_RED = [0xff, 0x00, 0x00];
  const ZX_YELLOW = [0xff, 0xff, 0x00];
  const ZX_GREEN = [0x00, 0xff, 0x00];
  const ZX_CYAN = [0x00, 0xff, 0xff];

  // Classic 4-colour Sinclair ZX Spectrum diagonal rainbow stripes in the bottom-right corner
  const stripeStart = maskable ? 176 : 150;
  const bandW = 7;
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      const d = x + y;
      if (d >= stripeStart && d < stripeStart + bandW) grid[y * G + x] = ZX_RED;
      else if (d >= stripeStart + bandW && d < stripeStart + bandW * 2)
        grid[y * G + x] = ZX_YELLOW;
      else if (d >= stripeStart + bandW * 2 && d < stripeStart + bandW * 3)
        grid[y * G + x] = ZX_GREEN;
      else if (d >= stripeStart + bandW * 3 && d < stripeStart + bandW * 4)
        grid[y * G + x] = ZX_CYAN;
    }
  }

  // Crisp 2px black outer halo around the medallion silhouette so it pops cleanly over the rainbow
  for (let my = 0; my < MED_H; my++) {
    for (let mx = 0; mx < MED_W; mx++) {
      if (exterior[(my + 1) * PAD_W + (mx + 1)]) continue;
      for (let hy = -2; hy <= 2; hy++) {
        for (let hx = -2; hx <= 2; hx++) {
          const px = medX + mx + hx;
          const py = medY + my + hy;
          if (px >= 0 && px < G && py >= 0 && py < G) {
            grid[py * G + px] = BLACK;
          }
        }
      }
    }
  }

  // Render the opaque high-detail 96x64 Cyan Sabre Wulf Medallion
  for (let my = 0; my < MED_H; my++) {
    for (let mx = 0; mx < MED_W; mx++) {
      if (exterior[(my + 1) * PAD_W + (mx + 1)]) continue;
      const px = medX + mx;
      const py = medY + my;
      if (px >= 0 && px < G && py >= 0 && py < G) {
        grid[py * G + px] = medInk[my * MED_W + mx] ? ZX_CYAN : BLACK;
      }
    }
  }

  return { grid, G };
}

function renderIcon(size, maskable = false) {
  const { grid, G } = buildPixelCanvas(maskable);
  const rgb = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    const gy = Math.min(G - 1, Math.floor((y * G) / size));
    for (let x = 0; x < size; x++) {
      const gx = Math.min(G - 1, Math.floor((x * G) / size));
      const [r, g, b] = grid[gy * G + gx];
      const idx = (y * size + x) * 3;
      rgb[idx] = r;
      rgb[idx + 1] = g;
      rgb[idx + 2] = b;
    }
  }
  return encodePng(size, rgb);
}

for (const [name, size, maskable] of [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, false],
]) {
  writeFileSync(join(outDir, name), renderIcon(size, maskable));
  console.log(`wrote public/icons/${name}`);
}
