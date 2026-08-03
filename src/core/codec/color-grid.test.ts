import { describe, it, expect } from 'vitest';
import { PROFILE_CLOUD, PROFILE_DISK, PROFILE_PAPER } from '../header';
import { getCodec, colorGridCodec } from './index';
import type { ImageDataLike } from './types';

// Full-capacity encodes plus a decode; slow enough to matter under coverage.
const SLOW = { timeout: 60_000 };

function pattern(size: number, a: number, b: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => (i * a + b) & 0xff);
}

/** Rotate an image a quarter-turn clockwise. */
function rotate90(img: ImageDataLike): ImageDataLike {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = (x * h + (h - 1 - y)) * 4;
      out.set(data.subarray(src, src + 4), dst);
    }
  }
  return { data: out, width: h, height: w };
}

/** Paint a solid rectangle over the image, as a sticker or scratch would. */
function damage(img: ImageDataLike, fx: number, fy: number, fw: number, fh: number): ImageDataLike {
  const out = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  const x0 = Math.round(img.width * fx);
  const y0 = Math.round(img.height * fy);
  for (let y = y0; y < y0 + Math.round(img.height * fh); y++) {
    for (let x = x0; x < x0 + Math.round(img.width * fw); x++) {
      const i = (y * img.width + x) * 4;
      out.data[i] = 128;
      out.data[i + 1] = 128;
      out.data[i + 2] = 128;
    }
  }
  return out;
}

/** Nearest-neighbour rescale, and a flat colour cast over every channel. */
function rescale(img: ImageDataLike, factor: number): ImageDataLike {
  const w = Math.round(img.width * factor);
  const h = Math.round(img.height * factor);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (Math.floor(y / factor) * img.width + Math.floor(x / factor)) * 4;
      out.set(img.data.subarray(src, src + 4), (y * w + x) * 4);
    }
  }
  return { data: out, width: w, height: h };
}

function colourCast(img: ImageDataLike): ImageDataLike {
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = out[i]! * 0.85 + 20; // warm, dimmed red
    out[i + 1] = out[i + 1]! * 0.92 + 10;
    out[i + 2] = out[i + 2]! * 0.7; // blue channel crushed
  }
  return { data: out, width: img.width, height: img.height };
}

describe('color-grid codec', () => {
  it('round-trips a payload through pixels (render -> decode identity)', () => {
    const payload = pattern(200, 31, 7);
    const img = colorGridCodec.encode(payload, PROFILE_DISK);
    expect(img.width).toBe(img.height);
    expect(img.data.length).toBe(img.width * img.height * 4);
    expect([...colorGridCodec.decode(img)]).toEqual([...payload]);
  });

  it('round-trips a payload that includes 0x00 bytes', () => {
    const payload = Uint8Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 0 : i));
    const img = colorGridCodec.encode(payload, PROFILE_DISK);
    expect([...colorGridCodec.decode(img)]).toEqual([...payload]);
  });

  it('round-trips a single byte', () => {
    const img = colorGridCodec.encode(Uint8Array.of(0xa5), PROFILE_DISK);
    expect([...colorGridCodec.decode(img)]).toEqual([0xa5]);
  });

  it('round-trips exactly at the disk capacity', SLOW, () => {
    const payload = pattern(colorGridCodec.capacity(PROFILE_DISK), 97, 13);
    const img = colorGridCodec.encode(payload, PROFILE_DISK);
    expect([...colorGridCodec.decode(img)]).toEqual([...payload]);
  });

  it('round-trips exactly at the cloud capacity', SLOW, () => {
    const payload = pattern(colorGridCodec.capacity(PROFILE_CLOUD), 53, 3);
    const img = colorGridCodec.encode(payload, PROFILE_CLOUD);
    expect([...colorGridCodec.decode(img)]).toEqual([...payload]);
  });

  it('carries about three times the qr-grid payload per image', () => {
    expect(colorGridCodec.capacity(PROFILE_DISK)).toBeGreaterThan(2800 * 2.5);
    expect(colorGridCodec.capacity(PROFILE_CLOUD)).toBeGreaterThan(1600 * 2);
  });

  it('rejects an over-capacity payload', () => {
    const tooBig = new Uint8Array(colorGridCodec.capacity(PROFILE_DISK) + 1);
    expect(() => colorGridCodec.encode(tooBig, PROFILE_DISK)).toThrow(/capacity/);
  });

  it('refuses the paper profile, which stays on qr-grid', () => {
    expect(() => colorGridCodec.encode(Uint8Array.of(1), PROFILE_PAPER)).toThrow(/not supported/);
    expect(() => colorGridCodec.capacity(PROFILE_PAPER)).toThrow(/not supported/);
  });

  it('reads a symbol at any quarter-turn', SLOW, () => {
    const payload = pattern(600, 17, 5);
    let img = colorGridCodec.encode(payload, PROFILE_DISK);
    for (let turn = 1; turn <= 3; turn++) {
      img = rotate90(img);
      expect([...colorGridCodec.decode(img)], `${turn * 90} degrees`).toEqual([...payload]);
    }
  });

  it('survives a sticker over part of the grid', SLOW, () => {
    // Blocks map to contiguous vertical stripes, so localized damage destroys a
    // few blocks outright — which the erasure code absorbs — rather than lightly
    // corrupting all of them, which it could not.
    const payload = pattern(4000, 23, 9);
    const img = colorGridCodec.encode(payload, PROFILE_DISK);
    const hit = damage(img, 0.15, 0.2, 0.06, 0.6);
    expect([...colorGridCodec.decode(hit)]).toEqual([...payload]);
  });

  it('gives up cleanly when the damage exceeds the parity budget', SLOW, () => {
    const img = colorGridCodec.encode(pattern(4000, 3, 1), PROFILE_DISK);
    // Wipe the middle 70%, far past what 12% parity can rebuild.
    expect(() => colorGridCodec.decode(damage(img, 0.15, 0.1, 0.7, 0.8))).toThrow(
      /too much damage|no color grid/,
    );
  });

  it('survives a rescale, which is what photo services do on upload', SLOW, () => {
    const payload = pattern(600, 11, 3);
    const img = colorGridCodec.encode(payload, PROFILE_CLOUD);
    expect([...colorGridCodec.decode(rescale(img, 0.75))]).toEqual([...payload]);
  });

  it('survives a colour cast, thanks to the calibration run', SLOW, () => {
    // The decoder classifies against the palette as *observed*, not as encoded.
    const payload = pattern(600, 29, 7);
    const img = colorGridCodec.encode(payload, PROFILE_DISK);
    expect([...colorGridCodec.decode(colourCast(img))]).toEqual([...payload]);
  });

  it('resolves the codec by header id', () => {
    expect(getCodec(colorGridCodec.id)).toBe(colorGridCodec);
  });

  it('fills unused capacity with colour, not a black band', SLOW, () => {
    // The filler is outside the encryption, so a flat zeroed band would show
    // exactly how much of the capacity the secret used.
    const img = colorGridCodec.encode(pattern(400, 5, 1), PROFILE_DISK);
    let black = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i] === 0 && img.data[i + 1] === 0 && img.data[i + 2] === 0) black++;
    }
    // A zero-padded symbol was over a third black; 1/8 is what an even spread of
    // the eight colours gives, so allow a little over that and no more.
    expect(black / (img.width * img.height)).toBeLessThan(0.2);
  });

  it('varies the filler per payload, so padding cannot be spotted by comparison', SLOW, () => {
    // A constant seed would paint the same pattern into every part-full image,
    // handing the padding boundary to anyone who lines two of them up.
    const a = colorGridCodec.encode(pattern(400, 5, 1), PROFILE_DISK);
    const b = colorGridCodec.encode(pattern(400, 7, 3), PROFILE_DISK);
    let same = 0;
    for (let i = 0; i < a.data.length; i += 4) if (a.data[i] === b.data[i]) same++;
    expect(same / (a.width * a.height)).toBeLessThan(0.9);
    // ...but the same payload still encodes identically.
    const again = colorGridCodec.encode(pattern(400, 5, 1), PROFILE_DISK);
    expect([...again.data]).toEqual([...a.data]);
  });

  it('rejects a megapixel photo quickly instead of grinding on it', SLOW, () => {
    // Restore feeds every image through the detector, on the main thread. A
    // noisy photo produces a run every couple of pixels, so an unbounded
    // candidate cluster search went quadratic here — 12 MP took over a minute.
    const w = 2400;
    const h = 1800;
    const data = new Uint8ClampedArray(w * h * 4);
    let s = 7 >>> 0;
    for (let i = 0; i < w * h; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const v = 140 + ((s >>> 24) & 0x7f); // noisy greyscale, like a page photo
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    const started = performance.now();
    expect(() => colorGridCodec.decode({ data, width: w, height: h })).toThrow();
    // Generous versus the ~0.15 s this takes, but far under the old behaviour.
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('reports a clear error when the image holds no grid', () => {
    const blank: ImageDataLike = {
      data: new Uint8ClampedArray(64 * 64 * 4).fill(255),
      width: 64,
      height: 64,
    };
    expect(() => colorGridCodec.decode(blank)).toThrow(/color grid/);
  });
});
