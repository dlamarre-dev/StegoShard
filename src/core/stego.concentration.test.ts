/**
 * Where the modifications land, on real photographs.
 *
 * `GALLERY_EMBED_MARGIN` bounds the modification rate averaged over a whole
 * photo. The obvious worry an average cannot answer is concentration: a cover
 * whose carriers are massed into one small textured patch would take its changes
 * there, and a detector working region by region would see a rate far above the
 * one the margin promises.
 *
 * It cannot happen, and the reason is structural rather than lucky. Positions are
 * drawn uniformly over the eligible carriers, so every region carries the same
 * rate as the whole: a tile holding 1% of the carriers takes 1% of the changes.
 * The per-tile rate is therefore the global rate plus sampling noise, and a
 * per-tile threshold would be a constant dressed up as a check.
 *
 * That is a claim about the position draw, not about these photographs, so this
 * test exists to fail if the draw ever stops being uniform — a bias toward
 * high-magnitude coefficients, say, or a locality optimization. It measures what
 * SPEC §9.8 reports, on the corpus §9.8 names.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { decode as decodeCoeff } from './jpeg-coeff';
import { reencodeCover } from './jpeg-encode';
import { GALLERY_EMBED_MARGIN } from './gallery';
import { embedBytesStegoJpeg, jpegStegoCapacityBits } from './stego';
import { resetStegoCoverGuard } from './stego-guard';

/** Camera originals, single-compressed, CC0. See covers-jpeg/PROVENANCE.md. */
const CORPUS = join(import.meta.dirname, '../../tests/steganalysis/covers-jpeg');

/** 8 blocks a side: 64x64 px tiles, 16x12 of them on a 1024x768 photo. */
const TILE = 8;

/** Tiles with fewer carriers than this say more about sampling than about the photo. */
const MIN_TILE_CARRIERS = 200;

/**
 * Luma blocks placed back on the image grid.
 *
 * `blocks` is in interleaved MCU decode order, so an index says nothing about
 * where the block sits until the MCU geometry is undone: each MCU carries `h*v`
 * luma blocks, raster order within it.
 */
function lumaGrid(bytes: Uint8Array): {
  blocks: Int16Array[];
  at: (i: number) => [number, number];
} {
  const model = decodeCoeff(bytes);
  const y = model.components[0]!;
  const per = y.h * y.v;
  return {
    blocks: y.blocks,
    at: (i: number): [number, number] => {
      const mcu = (i / per) | 0;
      const sub = i % per;
      return [
        (mcu % model.mcusPerLine) * y.h + (sub % y.h),
        ((mcu / model.mcusPerLine) | 0) * y.v + ((sub / y.h) | 0),
      ];
    },
  };
}

/** Carriers and modifications per tile, for a cover and the carrier made from it. */
function perTile(cover: Uint8Array, stego: Uint8Array): { carriers: number; mods: number }[] {
  const a = lumaGrid(cover);
  const b = lumaGrid(stego);
  const tiles = new Map<string, { carriers: number; mods: number }>();
  for (let i = 0; i < a.blocks.length; i++) {
    const [bx, by] = a.at(i);
    const key = `${(bx / TILE) | 0},${(by / TILE) | 0}`;
    let tile = tiles.get(key);
    if (!tile) tiles.set(key, (tile = { carriers: 0, mods: 0 }));
    const ba = a.blocks[i]!;
    const bb = b.blocks[i]!;
    for (let k = 1; k < 64; k++) {
      if (Math.abs(ba[k]!) >= 2) {
        tile.carriers++;
        if (ba[k] !== bb[k]) tile.mods++;
      }
    }
  }
  return [...tiles.values()];
}

/**
 * A cover re-encoded into the profile, carrying the largest payload the margin
 * allows.
 *
 * Sized from the capacity rather than to a gallery slot on purpose. These are
 * 1024x768 crops, far too small to take a 2109-byte slot at 16x, but the margin
 * is a *rate*: a payload of `capacity / margin` bits is exactly what it permits,
 * and the modification rate that follows is the production one whatever the
 * photo's size.
 */
async function embedAtMargin(name: string): Promise<{ cover: Uint8Array; stego: Uint8Array }> {
  const raw = new Uint8Array(readFileSync(join(CORPUS, name)));
  const { width, height, data } = jpeg.decode(raw, { useTArray: true });
  const cover = reencodeCover({ width, height, data: new Uint8ClampedArray(data) }, raw, name);
  const payload = new Uint8Array(
    Math.floor(jpegStegoCapacityBits(cover) / GALLERY_EMBED_MARGIN / 8),
  );
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 0xff;
  resetStegoCoverGuard();
  const stego = await embedBytesStegoJpeg(
    cover,
    payload,
    new Uint8Array(32).fill(7),
    GALLERY_EMBED_MARGIN,
  );
  return { cover, stego };
}

// Two of the five, one textured and one dim, which is the axis that moves the
// numbers. The full corpus is measured in the bench SPEC §9.8 cites; running all
// five here would buy a third decimal place for four times the CI time.
describe.each(['mountain.jpg', 'lake.jpg'])('modification density in %s', (name) => {
  it('spreads at the rate the margin promises, everywhere in the photo', async () => {
    const { cover, stego } = await embedAtMargin(name);
    const tiles = perTile(cover, stego);

    // Half the payload bits already match the carrier they land on, so the rate
    // the margin buys is 1/(2m), not 1/m.
    const expected = 1 / (2 * GALLERY_EMBED_MARGIN);
    const carriers = tiles.reduce((s, t) => s + t.carriers, 0);
    const mods = tiles.reduce((s, t) => s + t.mods, 0);
    expect(mods / carriers).toBeGreaterThan(expected * 0.9);
    expect(mods / carriers).toBeLessThan(expected * 1.1);

    // The property itself: per tile, the same rate, within sampling noise. The
    // comparison is against the binomial spread of drawing `n` positions, which
    // is what "uniform over the carriers" predicts and what the measurement
    // found (1.05x to 1.45x of it across the corpus).
    const big = tiles.filter((t) => t.carriers >= MIN_TILE_CARRIERS);
    expect(big.length, 'too few populated tiles to say anything').toBeGreaterThan(20);
    const rates = big.map((t) => t.mods / t.carriers);
    const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
    const sd = Math.sqrt(rates.reduce((s, r) => s + (r - mean) ** 2, 0) / rates.length);
    const n = big.reduce((s, t) => s + t.carriers, 0) / big.length;
    const binomial = Math.sqrt((mean * (1 - mean)) / n);

    expect(mean).toBeCloseTo(expected, 2);
    expect(
      sd,
      `tile rates spread wider than sampling explains (binomial ${binomial})`,
    ).toBeLessThan(binomial * 2);
  }, 60_000);
});
