/**
 * Headless image I/O: fast-png round-trip and — the load-bearing part — the
 * area-average downscaler must keep a QR decodable after a simulated photo
 * (upscale + noise + a repetitive background pattern that provokes moiré).
 * A bad resize corrupts the QR silently, so this is tested aggressively.
 */

import { describe, it, expect } from 'vitest';
import {
  CODEC_QR_GRID,
  PROFILE_PAPER,
  type Header,
  type ImageDataLike,
  encodeImagePayload,
  getCodec,
} from '@core';
import { downscale, fileToImageData, imageDataToPng, decodeImageToPayload } from './node-image-io';

const codec = getCodec(CODEC_QR_GRID);

function makePayload(len: number, seed = 42): Uint8Array {
  const header: Header = {
    version: 1,
    setId: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    shardIndex: 0,
    k: 1,
    m: 0,
    codecId: CODEC_QR_GRID,
    profile: PROFILE_PAPER,
    shardLen: len,
    blobLen: len,
    hash: Uint8Array.from([9, 9, 9, 9]),
  };
  let s = seed >>> 0;
  const shard = Uint8Array.from({ length: len }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  });
  return encodeImagePayload(header, shard);
}

/** Nearest-neighbour upscale, then add per-pixel noise plus a striped pattern. */
function simulatePhoto(img: ImageDataLike, factor: number, seed = 7): ImageDataLike {
  const w = img.width * factor;
  const h = img.height * factor;
  const out = new Uint8ClampedArray(w * h * 4);
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (Math.floor(y / factor) * img.width + Math.floor(x / factor)) * 4;
      const d = (y * w + x) * 4;
      const noise = (rnd() % 41) - 20; // ±20
      const stripe = (x + y) % 3 === 0 ? 8 : 0; // repetitive pattern → moiré risk
      for (let c = 0; c < 3; c++) out[d + c] = img.data[src + c]! + noise + stripe;
      out[d + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

describe('fast-png round-trip', () => {
  it('encodes and decodes a QR image losslessly through PNG', () => {
    const payload = makePayload(500);
    const img = codec.encode(payload, PROFILE_PAPER);
    const png = imageDataToPng(img);
    const back = fileToImageData(png, 'x.png');
    expect(back.width).toBe(img.width);
    expect(back.height).toBe(img.height);
    expect([...codec.decode(back)]).toEqual([...payload]);
  });

  it('decodeImageToPayload reads a rendered PNG at natural size', () => {
    const payload = makePayload(400);
    const png = imageDataToPng(codec.encode(payload, PROFILE_PAPER));
    expect([...decodeImageToPayload(png, 'p.png')!]).toEqual([...payload]);
  });
});

describe('downscale keeps the QR decodable (moiré/noise)', () => {
  it('recovers the payload from a noisy 3× upscaled photo after downscaling', () => {
    const payload = makePayload(300);
    const qr = codec.encode(payload, PROFILE_PAPER);
    const photo = simulatePhoto(qr, 3);
    // The photo is larger than the decode caps, so decodeImageToPayload will
    // exercise the area-average downscaler at 1400/1000.
    const png = imageDataToPng(photo);
    const recovered = decodeImageToPayload(png, 'photo.png');
    expect(recovered).not.toBeNull();
    expect([...recovered!]).toEqual([...payload]);
  });

  it('a direct 2× downscale of a clean render still decodes', () => {
    const payload = makePayload(350);
    const qr = codec.encode(payload, PROFILE_PAPER);
    const big = simulatePhoto(qr, 2, 1);
    const small = downscale(big, Math.max(big.width, big.height) / 2);
    expect([...codec.decode(small)]).toEqual([...payload]);
  });

  it('never upscales', () => {
    const payload = makePayload(100);
    const qr = codec.encode(payload, PROFILE_PAPER);
    const same = downscale(qr, qr.width * 4);
    expect(same.width).toBe(qr.width);
  });
});
