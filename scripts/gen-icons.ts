/**
 * Generate the extension icons (16/32/48/128 px) as PNGs — a rounded accent
 * square with a white keyhole "vault" mark. Rendered at 4× and box-downscaled
 * for antialiasing. Run with: npm run icons
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';

const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor
const OUT = resolve(process.cwd(), 'public/icons');

// Accent gradient (matches the UI accent).
const TOP = [0x3b, 0x5b, 0xdb];
const BOT = [0x2f, 0x49, 0xb8];

function insideRoundedRect(x: number, y: number, size: number, r: number): boolean {
  const min = r;
  const max = size - 1 - r;
  const cx = x < min ? min : x > max ? max : x;
  const cy = y < min ? min : y > max ? max : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** White keyhole: a circle over a tapered stem, centered. */
function insideKeyhole(x: number, y: number, size: number): boolean {
  const cx = size / 2;
  const holeY = size * 0.42;
  const holeR = size * 0.15;
  const dx = x - cx;
  const dy = y - holeY;
  if (dx * dx + dy * dy <= holeR * holeR) return true;

  const stemTop = holeY;
  const stemBot = size * 0.72;
  if (y >= stemTop && y <= stemBot) {
    const t = (y - stemTop) / (stemBot - stemTop);
    const halfW = (holeR * 0.55 + (holeR * 1.15 - holeR * 0.55) * t) / 1;
    if (Math.abs(dx) <= halfW) return true;
  }
  return false;
}

function renderSize(size: number): Buffer {
  const big = size * SS;
  const r = big * 0.22;
  const png = new PNG({ width: size, height: size });

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const bx = x * SS + sx;
          const by = y * SS + sy;
          if (!insideRoundedRect(bx, by, big, r)) continue; // transparent outside
          if (insideKeyhole(bx, by, big)) {
            rSum += 255;
            gSum += 255;
            bSum += 255;
          } else {
            const t = by / (big - 1);
            rSum += TOP[0]! + (BOT[0]! - TOP[0]!) * t;
            gSum += TOP[1]! + (BOT[1]! - TOP[1]!) * t;
            bSum += TOP[2]! + (BOT[2]! - TOP[2]!) * t;
          }
          aSum += 255;
        }
      }
      const n = SS * SS;
      const idx = (y * size + x) * 4;
      const cov = aSum / (n * 255); // 0..1 coverage
      // Average color over covered subpixels; alpha from coverage.
      const covered = aSum / 255;
      png.data[idx] = covered ? Math.round(rSum / covered) : 0;
      png.data[idx + 1] = covered ? Math.round(gSum / covered) : 0;
      png.data[idx + 2] = covered ? Math.round(bSum / covered) : 0;
      png.data[idx + 3] = Math.round(cov * 255);
    }
  }
  return PNG.sync.write(png);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  writeFileSync(resolve(OUT, `icon-${size}.png`), renderSize(size));
  console.log(`icon-${size}.png`);
}
console.log(`icons written to ${OUT}`);
