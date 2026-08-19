/**
 * Generate the social preview card (`og:image` / `twitter:image`) as a
 * 1200x630 PNG. Run with: npm run og
 *
 * Same approach as `gen-icons.ts`, and for the same reason: the mark, the
 * gradient and the 5x7 font all live in `src/core/brand.ts`, so the preview
 * card, the extension icons and the strip stamped on exported images are drawn
 * by one piece of code rather than three. No headless browser, no rasterizer,
 * no new dependency.
 *
 * 1200x630 is what the scrapers want: it is the size Open Graph documents for a
 * large summary card, and it is comfortably above Twitter's 144px floor.
 *
 * The type is blocky because the font is a 5x7 bitmap. That is deliberate
 * continuity with the strip already stamped on every exported image, not a
 * missing font.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { ACCENT_BOT, ACCENT_TOP, drawMark, drawText, textWidth } from '../src/core/brand';

const W = 1200;
const H = 630;
const OUT = resolve(process.cwd(), 'src/web/site-root/og.png');

const WHITE: readonly [number, number, number] = [0xff, 0xff, 0xff];
/** The tagline, dimmed against the accent so the wordmark stays dominant. */
const MUTED: readonly [number, number, number] = [0xc7, 0xd2, 0xfe];

const WORDMARK = 'STEGOSHARD';
// Folded to the glyph set (ASCII 32..90, uppercase) the bitmap font covers.
const TAGLINE = 'ENCRYPT FILES INTO RESILIENT IMAGES';
const SUBLINE = 'OR HIDE THEM IN ORDINARY PHOTOS';

const png = new PNG({ width: W, height: H });
const canvas = { data: new Uint8ClampedArray(png.data.buffer, 0, W * H * 4), width: W, height: H };

// Vertical accent gradient, the same two stops as the icon and the PDF tile.
for (let y = 0; y < H; y++) {
  const t = y / (H - 1);
  const r = ACCENT_TOP[0] + (ACCENT_BOT[0] - ACCENT_TOP[0]) * t;
  const g = ACCENT_TOP[1] + (ACCENT_BOT[1] - ACCENT_TOP[1]) * t;
  const b = ACCENT_TOP[2] + (ACCENT_BOT[2] - ACCENT_TOP[2]) * t;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    canvas.data[i] = r;
    canvas.data[i + 1] = g;
    canvas.data[i + 2] = b;
    canvas.data[i + 3] = 255;
  }
}

const MARK = 200;
const WORD_SCALE = 11;
const TAG_SCALE = 4;

// Centred as one block: mark, wordmark, then the two tagline rows.
const wordW = textWidth(WORDMARK, WORD_SCALE);
const blockH = MARK + 56 + 7 * WORD_SCALE + 48 + 7 * TAG_SCALE + 20 + 7 * TAG_SCALE;
let y = Math.round((H - blockH) / 2);

drawMark(canvas, Math.round((W - MARK) / 2), y, MARK);
y += MARK + 56;

drawText(canvas, WORDMARK, Math.round((W - wordW) / 2), y, WORD_SCALE, WHITE);
y += 7 * WORD_SCALE + 48;

drawText(canvas, TAGLINE, Math.round((W - textWidth(TAGLINE, TAG_SCALE)) / 2), y, TAG_SCALE, MUTED);
y += 7 * TAG_SCALE + 20;

drawText(canvas, SUBLINE, Math.round((W - textWidth(SUBLINE, TAG_SCALE)) / 2), y, TAG_SCALE, MUTED);

writeFileSync(OUT, PNG.sync.write(png));
console.log(`og.png  ${W}x${H}  ->  ${OUT}`);
