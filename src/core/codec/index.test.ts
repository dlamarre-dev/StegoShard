/**
 * Codec resolution and sniffing.
 *
 * The per-image header lives inside the payload, so `CODEC_ID` cannot tell a
 * decoder which codec to use — it has to guess from the pixels and fall back.
 * These tests pin that behaviour, including the case where the guess is wrong.
 */

import { describe, it, expect } from 'vitest';
import { CODEC_COLOR_GRID, CODEC_GALLERY, CODEC_QR_GRID, PROFILE_DISK } from '../header';
import { codecName, colorGridCodec, decodeWithAnyCodec, getCodec, qrGridCodec } from './index';
import type { ImageDataLike } from './types';

const payload = Uint8Array.from({ length: 300 }, (_, i) => (i * 19 + 5) & 0xff);

describe('codec registry', () => {
  it('resolves each codec by its header id', () => {
    expect(getCodec(CODEC_QR_GRID)).toBe(qrGridCodec);
    expect(getCodec(CODEC_COLOR_GRID)).toBe(colorGridCodec);
    expect(() => getCodec(99)).toThrow(/unknown codec/);
  });

  it('names every codec for the recovery strip', () => {
    expect(codecName(CODEC_QR_GRID)).toBe('qr-grid');
    expect(codecName(CODEC_COLOR_GRID)).toBe('color-grid');
    expect(codecName(CODEC_GALLERY)).toBe('gallery');
    // An id from a future version still prints something recognisable.
    expect(codecName(7)).toBe('codec-7');
  });
});

describe('codec sniffing', () => {
  it('reads a QR without being told which codec made it', () => {
    const img = qrGridCodec.encode(payload, PROFILE_DISK);
    expect([...decodeWithAnyCodec(img)]).toEqual([...payload]);
  });

  it('reads a color grid without being told which codec made it', () => {
    const img = colorGridCodec.encode(payload, PROFILE_DISK);
    expect([...decodeWithAnyCodec(img)]).toEqual([...payload]);
  });

  it('falls back to the other codec when the chroma guess is wrong', () => {
    // A faint colour wash pushes a QR over the chroma threshold, so the color
    // codec is tried first and must fail through to qr-grid.
    const img = qrGridCodec.encode(payload, PROFILE_DISK);
    const tinted = new Uint8ClampedArray(img.data);
    for (let i = 0; i < tinted.length; i += 4) {
      tinted[i + 2] = Math.max(0, tinted[i + 2]! - 60); // drop blue everywhere
    }
    expect([...decodeWithAnyCodec({ ...img, data: tinted })]).toEqual([...payload]);
  });

  it('reports an error when neither codec finds a symbol', () => {
    const noise = new Uint8ClampedArray(96 * 96 * 4);
    let s = 1;
    for (let i = 0; i < noise.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      noise[i] = (s >>> 24) & 0xff;
    }
    const blank: ImageDataLike = { data: noise, width: 96, height: 96 };
    expect(() => decodeWithAnyCodec(blank)).toThrow();
  });
});
