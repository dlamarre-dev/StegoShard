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
import {
  ACCENT_BOT,
  ACCENT_TOP,
  drawMark,
  drawText,
  foldToBrandText,
  textHeight,
  textWidth,
} from '../src/core/brand';
import { wrapText } from '../src/ui/text-wrap';

const W = 1200;
const H = 630;
const OUT = resolve(process.cwd(), 'src/web/site-root/og.png');

const WHITE: readonly [number, number, number] = [0xff, 0xff, 0xff];
/** The tagline, dimmed against the accent so the wordmark stays dominant. */
const MUTED: readonly [number, number, number] = [0xc7, 0xd2, 0xfe];

const WORDMARK = 'STEGOSHARD';

/**
 * The repository's About text, verbatim.
 *
 * One sentence describes this project in the places people meet it, so the card
 * says what GitHub says. `foldToBrandText` maps it onto the font's ASCII 32..90
 * glyph set at render time, rather than a second copy being kept in capitals.
 */
const ABOUT =
  'Encrypt a file and save it as error-corrected QR images, hidden inside ordinary ' +
  'photos, or disguised as a real SQLite database, deniable by design. ' +
  'Browser extension, web app & CLI.';

const MARGIN_X = 90;
const MAX_TEXT_W = W - MARGIN_X * 2;
const MARK = 168;
const WORD_SCALE = 10;
const GAP_MARK = 46;
const GAP_WORD = 42;
/** Smallest breathing room above and below the whole block. */
const MARGIN_Y = 44;

/** Line spacing scales with the type, so the block stays proportionate. */
const lineGap = (scale: number): number => scale * 4;

function layout(scale: number): { lines: string[]; height: number } {
  const lines = wrapText(ABOUT, MAX_TEXT_W, (s) => textWidth(foldToBrandText(s), scale));
  const body = lines.length * textHeight(scale) + (lines.length - 1) * lineGap(scale);
  return { lines, height: MARK + GAP_MARK + textHeight(WORD_SCALE) + GAP_WORD + body };
}

/**
 * Largest type the description fits in at. Chosen rather than fixed because the
 * About text is the kind of thing that gets rewritten, and a hardcoded scale
 * would silently overflow the card the next time it grows.
 */
const scale = [6, 5, 4, 3, 2].find((s) => layout(s).height <= H - MARGIN_Y * 2) ?? 2;
const { lines, height } = layout(scale);
if (height > H - MARGIN_Y * 2) {
  throw new Error(`the description does not fit the card even at scale 2 (${height}px)`);
}

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

const centred = (text: string, s: number): number => Math.round((W - textWidth(text, s)) / 2);

let y = Math.round((H - height) / 2);

drawMark(canvas, Math.round((W - MARK) / 2), y, MARK);
y += MARK + GAP_MARK;

drawText(canvas, WORDMARK, centred(WORDMARK, WORD_SCALE), y, WORD_SCALE, WHITE);
y += textHeight(WORD_SCALE) + GAP_WORD;

for (const line of lines) {
  const folded = foldToBrandText(line);
  drawText(canvas, folded, centred(folded, scale), y, scale, MUTED);
  y += textHeight(scale) + lineGap(scale);
}

writeFileSync(OUT, PNG.sync.write(png));
console.log(`og.png  ${W}x${H}  ${lines.length} lines at scale ${scale}  ->  ${OUT}`);
