/**
 * The brand strip stamped onto generated images. What matters here is that it
 * never touches the symbol below it, that it renders identically wherever it
 * runs (the browser and the CLI share this code precisely so their output
 * agrees), and that a branded image still decodes.
 */

import { describe, it, expect } from 'vitest';
import {
  brandBandHeight,
  brandCaption,
  foldToBrandText,
  colorGridCodec,
  decodeWithAnyCodec,
  drawBrandBand,
  fitLine,
  isRenderableAscii,
  qrGridCodec,
  recoveryLines,
  textWidth,
  PROFILE_CLOUD,
  PROFILE_DISK,
} from './index';

const band = { recovery: recoveryLines('color-grid') };

// These buffers run to millions of bytes, so compare them in place. Spreading
// them into arrays for `toEqual` costs more than everything else in this file.
function expectSameBytes(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length);
  let mismatch = -1;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      mismatch = i;
      break;
    }
  }
  expect(mismatch, `first differing byte at index ${mismatch}`).toBe(-1);
}

function payload(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
}

describe('brand strip', () => {
  it('adds a strip above the symbol and copies the symbol verbatim', () => {
    const img = colorGridCodec.encode(payload(500), PROFILE_DISK);
    const out = drawBrandBand(img, band);
    const bandH = brandBandHeight(img.width, band);

    expect(out.width).toBe(img.width);
    expect(out.height).toBe(img.height + bandH);
    expect(bandH).toBe(out.height - img.height);
    // The symbol's pixels are untouched, so the quiet zone survives intact.
    expectSameBytes(out.data.subarray(bandH * out.width * 4), img.data);
  });

  it('is deterministic, so the browser and the CLI stamp the same pixels', () => {
    const img = colorGridCodec.encode(payload(500), PROFILE_DISK);
    expectSameBytes(drawBrandBand(img, band).data, drawBrandBand(img, band).data);
  });

  it('keeps a branded color grid decodable at both profiles', { timeout: 30_000 }, () => {
    for (const profile of [PROFILE_DISK, PROFILE_CLOUD]) {
      const body = payload(colorGridCodec.capacity(profile));
      const out = drawBrandBand(colorGridCodec.encode(body, profile), {
        recovery: recoveryLines('color-grid'),
        lines: ['MY BACKUP 2026', '1 / 4'],
      });
      expect([...decodeWithAnyCodec(out)], `profile ${profile}`).toEqual([...body]);
    }
  });

  it('keeps a branded QR decodable, so the strip is safe on both codecs', () => {
    const body = payload(700);
    const out = drawBrandBand(qrGridCodec.encode(body, PROFILE_DISK), {
      recovery: recoveryLines('qr-grid'),
    });
    expect([...decodeWithAnyCodec(out)]).toEqual([...body]);
  });

  it('names the format and points at the spec', () => {
    const [format, where] = recoveryLines('color-grid');
    expect(format).toContain('V1');
    expect(format).toContain('COLOR-GRID');
    expect(where).toContain('STEGOSHARD');
    // Everything on the strip must be drawable by the ASCII core font.
    for (const line of recoveryLines('color-grid')) expect(isRenderableAscii(line)).toBe(true);
  });

  it('shrinks then truncates a caption rather than letting it run off the edge', () => {
    const img = colorGridCodec.encode(payload(100), PROFILE_DISK);
    const avail = img.width - 100; // any inset the band may use
    // A line that fits is left at full scale and full length.
    const short = fitLine('1 / 4', avail, 3);
    expect(short.text).toBe('1 / 4');
    expect(short.scale).toBe(3);
    // A line that does not fit shrinks first, then loses its tail.
    const long = fitLine('X'.repeat(300), avail, 3);
    expect(long.scale).toBe(1);
    expect(long.text.length).toBeLessThan(300);
    expect(textWidth(long.text, long.scale)).toBeLessThanOrEqual(avail);

    const out = drawBrandBand(img, {
      recovery: recoveryLines('color-grid'),
      lines: ['X'.repeat(300)],
    });
    expect(out.width).toBe(img.width);
  });

  it('folds a Latin caption to something drawable rather than losing it', () => {
    // Before this, one accent dropped a whole title: `--title "Sauvegarde clé"`
    // reached the image as nothing at all.
    expect(foldToBrandText('Sauvegarde clé')).toBe('SAUVEGARDE CLE');
    expect(foldToBrandText('Archivo señuelo')).toBe('ARCHIVO SENUELO');
    expect(foldToBrandText('Größe')).toBe('GROSSE');
    // The punctuation a word processor substitutes as you type.
    expect(foldToBrandText('“Test” — 2026…')).toBe('"TEST" - 2026...');
    expect(foldToBrandText('«Test»')).toBe('"TEST"');
    for (const text of ['Sauvegarde clé', 'Größe', '“Test” — 2026…']) {
      expect(isRenderableAscii(foldToBrandText(text)), text).toBe(true);
    }
    // A script with no ASCII form is left for the caller to deal with.
    expect(isRenderableAscii(foldToBrandText('機密バックアップ'))).toBe(false);
  });

  describe('caption composition, shared by both surfaces', () => {
    it('always carries the date and the sequence, with or without a title', () => {
      // The browser used to omit both unless a title had been asked for, so an
      // unlabelled page said nothing about when it was made or what it belonged to.
      expect(brandCaption({ date: '2026-08-12', index: 1, total: 4 })).toEqual({
        lines: ['2026-08-12', '1 / 4'],
        unstampableTitle: null,
      });
      expect(
        brandCaption({ title: 'Wallet backup', date: '2026-08-12', index: 2, total: 4 }),
      ).toEqual({ lines: ['WALLET BACKUP', '2026-08-12', '2 / 4'], unstampableTitle: null });
    });

    it('orders the lines title, date, sequence, matching the README samples', () => {
      const { lines } = brandCaption({ title: 'A', date: '2026-08-12', index: 3, total: 9 });
      expect(lines).toEqual(['A', '2026-08-12', '3 / 9']);
    });

    it('hands back a title it cannot stamp instead of dropping it', () => {
      const caption = brandCaption({ title: 'アーカイブ', date: '2026-08-12', index: 1, total: 2 });
      // The date and sequence still make it; the title goes to the caller, which
      // has a real text renderer in the browser.
      expect(caption.lines).toEqual(['2026-08-12', '1 / 2']);
      expect(caption.unstampableTitle).toBe('アーカイブ');
    });

    it('leaves out what it was not given', () => {
      expect(brandCaption({})).toEqual({ lines: [], unstampableTitle: null });
      expect(brandCaption({ index: 1, total: 3 }).lines).toEqual(['1 / 3']);
    });
  });

  it('skips caption lines the ASCII font cannot draw, instead of mangling them', () => {
    const img = colorGridCodec.encode(payload(100), PROFILE_DISK);
    const withCjk = brandBandHeight(img.width, {
      recovery: recoveryLines('color-grid'),
      lines: ['機密バックアップ'],
    });
    const without = brandBandHeight(img.width, { recovery: recoveryLines('color-grid') });
    expect(withCjk).toBe(without);
    expect(isRenderableAscii('機密')).toBe(false);
    expect(isRenderableAscii('MY BACKUP 2026')).toBe(true);
    // Lowercase is folded to uppercase rather than rejected.
    expect(isRenderableAscii('my backup')).toBe(true);
  });
});
