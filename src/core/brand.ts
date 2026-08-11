/**
 * StegoShard brand primitives, kept in the environment-neutral core so the
 * browser and the CLI stamp *identical* pixels onto the images they generate.
 *
 * Two things live here that have nowhere else to go:
 *
 *  - The stegosaurus mark. It is a straight-segment polygon (the exact path from
 *    public/icons/icon.svg), so it can be point-tested directly and rasterized
 *    with no font, no canvas and no image asset. `scripts/gen-icons.ts` imports
 *    it from here too, so the path has a single owner.
 *  - A 5x7 bitmap font. The CLI has no rasterizer at all; `NodeTextEngine`
 *    emits PDF vector draw commands, not pixels, so drawing a caption onto a
 *    PNG needs glyph data, and the repo had none.
 *
 * The font covers ASCII 32..90 (space through 'Z'); lowercase is folded to
 * uppercase, and anything else becomes a space. That is a deliberate limit: the
 * brand strip is fixed ASCII, and a user-supplied title in a script this cannot
 * render is skipped by the caller rather than mangled here.
 */

import type { ImageDataLike } from './codec/types';

/** Accent gradient, matching `--accent` / `--accent-hover` in the UI. */
export const ACCENT_TOP: readonly [number, number, number] = [0x3b, 0x5b, 0xdb];
export const ACCENT_BOT: readonly [number, number, number] = [0x2f, 0x49, 0xb8];

/**
 * Stegosaurus silhouette, traced in the 128x128 design space. Straight segments
 * only, so it is a plain polygon we can point-test. Keep identical to the
 * `<path>` in public/icons/icon.svg.
 */
export const STEGO_PATH =
  'M66.8 35.1L72 38.6L75 41.5L78.1 46L77.8 50.9L80.1 52.1L81.3 49.1L85.7 46.2L87.7 42.9L90.1 47.6L91 51.6L90.9 54.2L89.1 56.7L89.5 57.6L91.3 59.2L92.6 56.7L94.8 55.8L97.6 53.4L98.1 53.3L98.4 53.8L99.4 57.2L99.7 59.9L99.4 61.4L96.9 64.3L96.7 65L97.5 65.7L99.4 66.7L99.5 64.8L102.2 62L103 65.7L102.3 67.9L104.4 68L103.9 66.3L105 64.3L106.4 66.2L106.4 68L107.5 67.9L107.4 66.5L108.7 65.2L109.2 66.6L108.8 68L109.6 68.1L110.6 66.2L111.1 67.1L110.8 68.1L113.5 68.8L115.9 70L117.2 71.3L120.5 72.4L121.7 74L121.9 75.4L119.3 75.6L117.1 75.1L113.4 75.1L111.3 74.1L108.7 74L105.9 74.5L98.9 77L96.5 82.6L97.5 87.4L100 91.9L99.9 92.4L98.8 92.7L95.5 92.9L94.3 92.4L94.1 90.3L92.6 86L90.9 83.2L88.4 87.7L88.5 89.6L90 91.6L87 92.4L86 92.1L83.8 90L83.7 88.8L84.8 86.4L86.3 80.6L83.7 79.4L80.8 79.4L76.7 80.3L73.1 79.9L72.5 81.2L72.2 83.7L72.4 87.9L74.5 90.5L74.7 91L73.9 91.7L70 91.9L68.4 91.4L67.4 85.9L65.6 81.8L64.9 79L63 80.4L61.2 83.1L58 86.4L57.7 88.8L59.4 90.8L59.6 91.6L58.9 92.1L56.6 92.6L52.8 91.6L52.6 85.9L53.8 82.8L54.6 79.4L55.8 77.4L57.7 75.6L57.9 74.7L54.1 72.9L51.2 72.9L47.5 74.3L39.8 78.2L34.2 81.5L26.4 84.8L21.5 86.4L15.3 87.9L8.5 87.8L6 86.9L11.7 86L8.5 83.7L7.3 82.3L6.6 81.3L10.3 83.7L8.2 80.7L11.2 83.2L14.1 85L15 85.1L17 84.5L12.5 81.8L10.6 79.9L12.3 81.1L17 82.7L13 78L19.1 82.3L20.7 82.6L23.3 81.1L29.5 76.1L28.2 75.2L26.8 72.3L30.5 72.1L32 73.8L34.3 71.6L33.9 70.9L31.9 70.3L30.5 65.7L35.3 65.1L36.7 65.3L38 66.5L41.4 63.6L42 62.7L41 61.9L38.9 61.4L36 57L33.8 54.5L37.9 53L41.5 52.5L45.9 53.3L48.5 57L51.3 55.2L50.4 53.1L48.1 50.7L47.8 47.7L46.7 44.8L42.9 40.8L45.3 40.7L51.3 41.3L59.1 43.6L61.7 45.4L62.4 47.3L62.5 50.1L62.9 50.5L64.4 50.4L66 49.8L66.3 49.2L65.1 46.2L66.8 41.6L66.8 35.3Z';

export const STEGO_POLY: readonly (readonly [number, number])[] = (() => {
  const nums = STEGO_PATH.match(/-?\d*\.?\d+/g)!.map(Number);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!]);
  return pts;
})();

/** Rounded-square mask used for the app mark's tile. */
export function insideRoundedRect(x: number, y: number, size: number, r: number): boolean {
  const min = r;
  const max = size - 1 - r;
  const cx = x < min ? min : x > max ? max : x;
  const cy = y < min ? min : y > max ? max : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Ray-cast point-in-polygon against the traced silhouette, in a `size` box. */
export function insideStegosaurus(x: number, y: number, size: number): boolean {
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

// --- 5x7 bitmap font ------------------------------------------------------

/**
 * Five column bitmaps per glyph, for ASCII 32..90 in order. Bit 0 of a column is
 * the top row, bit 6 the bottom.
 */
const GLYPHS: readonly (readonly [number, number, number, number, number])[] = [
  [0x00, 0x00, 0x00, 0x00, 0x00], // (space)
  [0x00, 0x00, 0x5f, 0x00, 0x00], // !
  [0x00, 0x07, 0x00, 0x07, 0x00], // "
  [0x14, 0x7f, 0x14, 0x7f, 0x14], // #
  [0x24, 0x2a, 0x7f, 0x2a, 0x12], // $
  [0x23, 0x13, 0x08, 0x64, 0x62], // %
  [0x36, 0x49, 0x55, 0x22, 0x50], // &
  [0x00, 0x05, 0x03, 0x00, 0x00], // '
  [0x00, 0x1c, 0x22, 0x41, 0x00], // (
  [0x00, 0x41, 0x22, 0x1c, 0x00], // )
  [0x14, 0x08, 0x3e, 0x08, 0x14], // *
  [0x08, 0x08, 0x3e, 0x08, 0x08], // +
  [0x00, 0x50, 0x30, 0x00, 0x00], // ,
  [0x08, 0x08, 0x08, 0x08, 0x08], // -
  [0x00, 0x60, 0x60, 0x00, 0x00], // .
  [0x20, 0x10, 0x08, 0x04, 0x02], // /
  [0x3e, 0x51, 0x49, 0x45, 0x3e], // 0
  [0x00, 0x42, 0x7f, 0x40, 0x00], // 1
  [0x42, 0x61, 0x51, 0x49, 0x46], // 2
  [0x21, 0x41, 0x45, 0x4b, 0x31], // 3
  [0x18, 0x14, 0x12, 0x7f, 0x10], // 4
  [0x27, 0x45, 0x45, 0x45, 0x39], // 5
  [0x3c, 0x4a, 0x49, 0x49, 0x30], // 6
  [0x01, 0x71, 0x09, 0x05, 0x03], // 7
  [0x36, 0x49, 0x49, 0x49, 0x36], // 8
  [0x06, 0x49, 0x49, 0x29, 0x1e], // 9
  [0x00, 0x36, 0x36, 0x00, 0x00], // :
  [0x00, 0x56, 0x36, 0x00, 0x00], // ;
  [0x08, 0x14, 0x22, 0x41, 0x00], // <
  [0x14, 0x14, 0x14, 0x14, 0x14], // =
  [0x00, 0x41, 0x22, 0x14, 0x08], // >
  [0x02, 0x01, 0x51, 0x09, 0x06], // ?
  [0x32, 0x49, 0x79, 0x41, 0x3e], // @
  [0x7e, 0x11, 0x11, 0x11, 0x7e], // A
  [0x7f, 0x49, 0x49, 0x49, 0x36], // B
  [0x3e, 0x41, 0x41, 0x41, 0x22], // C
  [0x7f, 0x41, 0x41, 0x22, 0x1c], // D
  [0x7f, 0x49, 0x49, 0x49, 0x41], // E
  [0x7f, 0x09, 0x09, 0x01, 0x01], // F
  [0x3e, 0x41, 0x41, 0x51, 0x32], // G
  [0x7f, 0x08, 0x08, 0x08, 0x7f], // H
  [0x00, 0x41, 0x7f, 0x41, 0x00], // I
  [0x20, 0x40, 0x41, 0x3f, 0x01], // J
  [0x7f, 0x08, 0x14, 0x22, 0x41], // K
  [0x7f, 0x40, 0x40, 0x40, 0x40], // L
  [0x7f, 0x02, 0x04, 0x02, 0x7f], // M
  [0x7f, 0x04, 0x08, 0x10, 0x7f], // N
  [0x3e, 0x41, 0x41, 0x41, 0x3e], // O
  [0x7f, 0x09, 0x09, 0x09, 0x06], // P
  [0x3e, 0x41, 0x51, 0x21, 0x5e], // Q
  [0x7f, 0x09, 0x19, 0x29, 0x46], // R
  [0x46, 0x49, 0x49, 0x49, 0x31], // S
  [0x01, 0x01, 0x7f, 0x01, 0x01], // T
  [0x3f, 0x40, 0x40, 0x40, 0x3f], // U
  [0x1f, 0x20, 0x40, 0x20, 0x1f], // V
  [0x7f, 0x20, 0x18, 0x20, 0x7f], // W
  [0x63, 0x14, 0x08, 0x14, 0x63], // X
  [0x03, 0x04, 0x78, 0x04, 0x03], // Y
  [0x61, 0x51, 0x49, 0x45, 0x43], // Z
];

const GLYPH_W = 5;
const GLYPH_H = 7;
/** One blank column between glyphs. */
const GLYPH_ADVANCE = GLYPH_W + 1;

function glyphFor(ch: string): readonly [number, number, number, number, number] {
  let code = ch.charCodeAt(0);
  if (code >= 97 && code <= 122) code -= 32; // fold lowercase to uppercase
  const i = code - 32;
  return GLYPHS[i] ?? GLYPHS[0]!;
}

/** True when every character can be drawn (after folding case). */
export function isRenderableAscii(text: string): boolean {
  for (const ch of text) {
    let code = ch.charCodeAt(0);
    if (code >= 97 && code <= 122) code -= 32;
    if (code < 32 || code > 90) return false;
  }
  return true;
}

/** Width in pixels of `text` at the given integer scale. */
export function textWidth(text: string, scale: number): number {
  if (text.length === 0) return 0;
  return (text.length * GLYPH_ADVANCE - 1) * scale;
}

/** Height in pixels of a single line at the given integer scale. */
export function textHeight(scale: number): number {
  return GLYPH_H * scale;
}

interface Canvas {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function fillRect(
  c: Canvas,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: readonly [number, number, number],
): void {
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= c.height) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= c.width) continue;
      const i = (y * c.width + x) * 4;
      c.data[i] = rgb[0];
      c.data[i + 1] = rgb[1];
      c.data[i + 2] = rgb[2];
      c.data[i + 3] = 255;
    }
  }
}

/** Draw `text` with its top-left at (x, y). Returns the width drawn. */
export function drawText(
  c: Canvas,
  text: string,
  x: number,
  y: number,
  scale: number,
  rgb: readonly [number, number, number],
): number {
  let cx = x;
  for (const ch of text) {
    const glyph = glyphFor(ch);
    for (let col = 0; col < GLYPH_W; col++) {
      const bits = glyph[col]!;
      for (let row = 0; row < GLYPH_H; row++) {
        if (bits & (1 << row)) {
          fillRect(c, cx + col * scale, y + row * scale, scale, scale, rgb);
        }
      }
    }
    cx += GLYPH_ADVANCE * scale;
  }
  return cx - x;
}

/** Rasterize the app mark (accent tile + white silhouette) at (x, y). */
export function drawMark(c: Canvas, x: number, y: number, size: number): void {
  const SS = 3; // supersample, for a clean rounded edge
  const big = size * SS;
  const r = big * 0.22;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const bx = px * SS + sx;
          const by = py * SS + sy;
          if (!insideRoundedRect(bx, by, big, r)) continue;
          if (insideStegosaurus(bx, by, big)) {
            rSum += 255;
            gSum += 255;
            bSum += 255;
          } else {
            const t = by / (big - 1);
            rSum += ACCENT_TOP[0] + (ACCENT_BOT[0] - ACCENT_TOP[0]) * t;
            gSum += ACCENT_TOP[1] + (ACCENT_BOT[1] - ACCENT_TOP[1]) * t;
            bSum += ACCENT_TOP[2] + (ACCENT_BOT[2] - ACCENT_TOP[2]) * t;
          }
          covered++;
        }
      }
      if (covered === 0) continue; // outside the tile: leave the background
      const dx = x + px;
      const dy = y + py;
      if (dx < 0 || dy < 0 || dx >= c.width || dy >= c.height) continue;
      // Blend the tile against white by coverage, so the corners stay smooth.
      const cov = covered / (SS * SS);
      const i = (dy * c.width + dx) * 4;
      const mix = (sum: number, bg: number): number =>
        Math.round((sum / covered) * cov + bg * (1 - cov));
      c.data[i] = mix(rSum, c.data[i]!);
      c.data[i + 1] = mix(gSum, c.data[i + 1]!);
      c.data[i + 2] = mix(bSum, c.data[i + 2]!);
      c.data[i + 3] = 255;
    }
  }
}

// --- the brand band -------------------------------------------------------

const WORDMARK = 'STEGOSHARD';
const MUTED: readonly [number, number, number] = [0x62, 0x6c, 0x78];

/** Where someone holding one of these images can find the format spec. */
export const RECOVERY_HOST = 'GITHUB.COM/DLAMARRE-DEV/STEGOSHARD';

/**
 * The lines stamped under the wordmark. They name the format version and the
 * image codec, then point at the specification, so a file found long after the
 * fact says what it is and where to go to read it.
 */
export function recoveryLines(codecName: string): string[] {
  return [`FORMAT V1 ${codecName.toUpperCase()}`, RECOVERY_HOST];
}

export interface BrandBandInput {
  /**
   * Recovery hint printed under the wordmark: what this file is and where the
   * format is specified, so an image found years from now leads somewhere.
   */
  recovery: readonly string[];
  /** Extra caption lines (title, date, "3 / 12"). Non-ASCII lines are skipped. */
  lines?: readonly string[];
}

/** Text scale that keeps the strip proportional across profiles. */
function scaleFor(width: number): number {
  return Math.max(2, Math.round(width / 260));
}

/**
 * Fit a line to the available width: shrink it as far as scale 1, then truncate.
 *
 * Shrinking is preferred because the recovery URL is only worth printing whole.
 * Truncation is the backstop for an over-long user caption, clipping at the
 * canvas edge would look like a rendering bug rather than a deliberate cut.
 */
export function fitLine(text: string, avail: number, max: number): { text: string; scale: number } {
  if (text.length === 0) return { text, scale: max };
  const scale = Math.max(1, Math.min(max, Math.floor((avail + 1) / (text.length * GLYPH_ADVANCE))));
  const maxChars = Math.max(0, Math.floor((avail + scale) / (GLYPH_ADVANCE * scale)));
  return { text: text.slice(0, maxChars), scale };
}

/** Every caption line the band will actually draw, in order. */
function bodyLines(band: BrandBandInput): string[] {
  return [...band.recovery, ...(band.lines ?? [])].filter(isRenderableAscii);
}

/** Height in pixels the band will occupy above an image of this width. */
export function brandBandHeight(width: number, band: BrandBandInput): number {
  const s = scaleFor(width);
  const pad = 4 * s;
  const gap = 2 * s;
  const head = Math.max(12 * s, textHeight(2 * s));
  const lines = bodyLines(band).length;
  return pad + head + (lines > 0 ? gap + lines * textHeight(s) + (lines - 1) * gap : 0) + pad;
}

/**
 * Return a new image with a white brand strip above the original pixels.
 *
 * The strip goes *above* the symbol and the symbol is copied verbatim, so the
 * quiet zone is never touched and the payload is unaffected. Callers that must
 * stay unbranded for deniability (gallery covers, stego key covers, disguised
 * binaries) simply never call this.
 */
export function drawBrandBand(img: ImageDataLike, band: BrandBandInput): ImageDataLike {
  const s = scaleFor(img.width);
  const pad = 4 * s;
  const gap = 2 * s;
  const markSize = 12 * s;
  const head = Math.max(markSize, textHeight(2 * s));
  const bandH = brandBandHeight(img.width, band);

  const width = img.width;
  const height = img.height + bandH;
  const data = new Uint8ClampedArray(width * height * 4).fill(255); // white RGBA
  const canvas: Canvas = { data, width, height };
  const avail = width - pad * 2;

  drawMark(canvas, pad, pad + Math.floor((head - markSize) / 2), markSize);
  const word = fitLine(WORDMARK, avail - markSize - gap, 2 * s);
  drawText(
    canvas,
    word.text,
    pad + markSize + gap,
    pad + Math.floor((head - textHeight(word.scale)) / 2),
    word.scale,
    ACCENT_TOP,
  );

  let y = pad + head + gap;
  for (const line of bodyLines(band)) {
    const fitted = fitLine(line, avail, s);
    drawText(canvas, fitted.text, pad, y, fitted.scale, MUTED);
    y += textHeight(s) + gap;
  }

  // Blit the symbol underneath, untouched.
  data.set(img.data, bandH * width * 4);
  return { data, width, height };
}
