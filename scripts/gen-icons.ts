/**
 * Generate the extension icons (16/32/48/128 px) as PNGs — a rounded accent
 * square with a white stegosaurus silhouette (kept in sync with the master
 * public/icons/icon.svg). Rendered at 4× and box-downscaled for antialiasing.
 * Run with: npm run icons
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

// Stegosaurus silhouette, traced in the 128×128 design space — the exact path
// from the master icon.svg. Straight segments only, so it is a plain polygon we
// can point-test directly. Keep this identical to the <path> in icon.svg.
const STEGO_PATH =
  'M66.8 35.1L72 38.6L75 41.5L78.1 46L77.8 50.9L80.1 52.1L81.3 49.1L85.7 46.2L87.7 42.9L90.1 47.6L91 51.6L90.9 54.2L89.1 56.7L89.5 57.6L91.3 59.2L92.6 56.7L94.8 55.8L97.6 53.4L98.1 53.3L98.4 53.8L99.4 57.2L99.7 59.9L99.4 61.4L96.9 64.3L96.7 65L97.5 65.7L99.4 66.7L99.5 64.8L102.2 62L103 65.7L102.3 67.9L104.4 68L103.9 66.3L105 64.3L106.4 66.2L106.4 68L107.5 67.9L107.4 66.5L108.7 65.2L109.2 66.6L108.8 68L109.6 68.1L110.6 66.2L111.1 67.1L110.8 68.1L113.5 68.8L115.9 70L117.2 71.3L120.5 72.4L121.7 74L121.9 75.4L119.3 75.6L117.1 75.1L113.4 75.1L111.3 74.1L108.7 74L105.9 74.5L98.9 77L96.5 82.6L97.5 87.4L100 91.9L99.9 92.4L98.8 92.7L95.5 92.9L94.3 92.4L94.1 90.3L92.6 86L90.9 83.2L88.4 87.7L88.5 89.6L90 91.6L87 92.4L86 92.1L83.8 90L83.7 88.8L84.8 86.4L86.3 80.6L83.7 79.4L80.8 79.4L76.7 80.3L73.1 79.9L72.5 81.2L72.2 83.7L72.4 87.9L74.5 90.5L74.7 91L73.9 91.7L70 91.9L68.4 91.4L67.4 85.9L65.6 81.8L64.9 79L63 80.4L61.2 83.1L58 86.4L57.7 88.8L59.4 90.8L59.6 91.6L58.9 92.1L56.6 92.6L52.8 91.6L52.6 85.9L53.8 82.8L54.6 79.4L55.8 77.4L57.7 75.6L57.9 74.7L54.1 72.9L51.2 72.9L47.5 74.3L39.8 78.2L34.2 81.5L26.4 84.8L21.5 86.4L15.3 87.9L8.5 87.8L6 86.9L11.7 86L8.5 83.7L7.3 82.3L6.6 81.3L10.3 83.7L8.2 80.7L11.2 83.2L14.1 85L15 85.1L17 84.5L12.5 81.8L10.6 79.9L12.3 81.1L17 82.7L13 78L19.1 82.3L20.7 82.6L23.3 81.1L29.5 76.1L28.2 75.2L26.8 72.3L30.5 72.1L32 73.8L34.3 71.6L33.9 70.9L31.9 70.3L30.5 65.7L35.3 65.1L36.7 65.3L38 66.5L41.4 63.6L42 62.7L41 61.9L38.9 61.4L36 57L33.8 54.5L37.9 53L41.5 52.5L45.9 53.3L48.5 57L51.3 55.2L50.4 53.1L48.1 50.7L47.8 47.7L46.7 44.8L42.9 40.8L45.3 40.7L51.3 41.3L59.1 43.6L61.7 45.4L62.4 47.3L62.5 50.1L62.9 50.5L64.4 50.4L66 49.8L66.3 49.2L65.1 46.2L66.8 41.6L66.8 35.3Z';

const STEGO_POLY: Array<[number, number]> = (() => {
  const nums = STEGO_PATH.match(/-?\d*\.?\d+/g)!.map(Number);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!]);
  return pts;
})();

function insideRoundedRect(x: number, y: number, size: number, r: number): boolean {
  const min = r;
  const max = size - 1 - r;
  const cx = x < min ? min : x > max ? max : x;
  const cy = y < min ? min : y > max ? max : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** White stegosaurus: ray-cast point-in-polygon against the traced silhouette. */
function insideStegosaurus(x: number, y: number, size: number): boolean {
  // Map the pixel (0..size) back into the 128-unit design space of the path.
  const u = (x * 128) / size;
  const v = (y * 128) / size;
  let inside = false;
  for (let i = 0, j = STEGO_POLY.length - 1; i < STEGO_POLY.length; j = i++) {
    const [xi, yi] = STEGO_POLY[i]!;
    const [xj, yj] = STEGO_POLY[j]!;
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
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
          if (insideStegosaurus(bx, by, big)) {
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
