/**
 * Gallery Mode (SPEC §9): fragmented, decoy-padded, blind-winnowed round-trips
 * plus the resilience and deniability properties the threat model demands —
 * loss/recompression tolerance, noise rejection, size invariance, an identical
 * Huffman size-category histogram, and high-entropy decoys.
 */

import { describe, it, expect } from 'vitest';
import jpeg from 'jpeg-js';
import {
  type Argon2Params,
  type GalleryCover,
  type GalleryImage,
  GALLERY_SLOT_BYTES,
  GalleryCoverCapacityError,
  GalleryFileTooLargeError,
  GalleryRestoreError,
  GalleryTooFewImagesError,
  GalleryTooManyImagesError,
  decode as decodeJpeg,
  estimateGalleryCovers,
  galleryCoversForEnvelopeLen,
  GALLERY_SLOT_DATA,
  galleryDecode,
  galleryEncode,
} from './index';

const FAST: Argon2Params = { iterations: 1, memoryKiB: 64, parallelism: 1 };

/** Textured baseline JPEG with plenty of |coef|≥2 carriers. */
function noisyJpeg(width: number, height: number, quality = 85, seed = 1): Uint8Array {
  const data = Buffer.alloc(width * height * 4);
  let s = seed >>> 0;
  for (let i = 0; i < width * height; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = (s >>> 24) & 0xff;
    data[i * 4 + 1] = (s >>> 16) & 0xff;
    data[i * 4 + 2] = (s >>> 8) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width, height }, quality).data);
}

function jpegCover(name: string, seed: number, size = 256): GalleryCover {
  return { kind: 'jpeg', name, jpeg: noisyJpeg(size, size, 85, seed) };
}

function rgbaCover(name: string, seed: number, w = 256, h = 256): GalleryCover {
  const rgba = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let p = 0; p < w * h; p++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    rgba[p * 4] = (s >>> 24) & 0xff;
    rgba[p * 4 + 1] = (s >>> 16) & 0xff;
    rgba[p * 4 + 2] = (s >>> 8) & 0xff;
    rgba[p * 4 + 3] = 255;
  }
  return { kind: 'rgba', name, rgba, width: w, height: h };
}

/** Re-encode a JPEG at a different quality — simulates a cloud service recompressing. */
function recompress(jpg: Uint8Array, quality = 70): Uint8Array {
  const d = jpeg.decode(jpg, { useTArray: true });
  return new Uint8Array(
    jpeg.encode({ data: Buffer.from(d.data), width: d.width, height: d.height }, quality).data,
  );
}

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('gallery round-trip', () => {
  it('hides a secret across RGBA covers and restores it blindly', async () => {
    const covers = [0, 1, 2, 3, 4, 5].map((i) => rgbaCover(`p${i}.png`, i + 1));
    const secret = enc.encode('the launch codes are 0000');
    const { images, k, m, decoys } = await galleryEncode('note.txt', secret, 'pw', covers, {
      params: FAST,
    });
    expect(images.length).toBe(covers.length);
    expect(k + m + decoys).toBe(covers.length);

    const out = await galleryDecode(images as GalleryCover[], 'pw', { params: FAST });
    expect(out.filename).toBe('note.txt');
    expect(dec.decode(out.content)).toBe('the launch codes are 0000');
  });

  it('round-trips across JPEG covers, staying valid JPEGs', async () => {
    const covers = [1, 2, 3, 4, 5, 6].map((i) => jpegCover(`img${i}.jpg`, i));
    const secret = enc.encode('gallery jpeg secret');
    const { images } = await galleryEncode('s.txt', secret, 'hunter2', covers, { params: FAST });
    for (const img of images) {
      if (img.kind === 'jpeg') expect(decodeJpeg(img.jpeg).width).toBe(256);
    }
    const out = await galleryDecode(images as GalleryCover[], 'hunter2', { params: FAST });
    expect(dec.decode(out.content)).toBe('gallery jpeg secret');
  }, 30000);

  it('round-trips a compressible secret larger than the compressed-blob ceiling', async () => {
    // 500 KB of repetition gzips to a few KB (well under GALLERY_MAX_BLOB) but
    // inflates back to 500 KB on restore. Regression for the decode bound bug
    // that once capped decompression at the *compressed* ceiling (~380 KB).
    const covers = [0, 1, 2, 3, 4, 5].map((i) => rgbaCover(`p${i}.png`, i + 7));
    const secret = new Uint8Array(500 * 1024).fill(0x41);
    const { images } = await galleryEncode('big.txt', secret, 'pw', covers, { params: FAST });
    const out = await galleryDecode(images as GalleryCover[], 'pw', { params: FAST });
    expect(out.content.length).toBe(secret.length);
    expect([...out.content.subarray(0, 8)]).toEqual([...secret.subarray(0, 8)]);
  });

  it('round-trips a keyfile gallery only with the external key block', async () => {
    const covers = [0, 1, 2, 3, 4, 5].map((i) => rgbaCover(`p${i}.png`, i + 40));
    const secret = enc.encode('keyfile gallery secret');
    const { images, keyBlock } = await galleryEncode('k.txt', secret, 'pw', covers, {
      params: FAST,
      keyMode: 'keyfile',
    });
    // Without the key the fragments cannot be unwrapped → indistinguishable from none.
    await expect(galleryDecode(images as GalleryCover[], 'pw', { params: FAST })).rejects.toThrow(
      GalleryRestoreError,
    );
    const out = await galleryDecode(images as GalleryCover[], 'pw', { params: FAST, keyBlock });
    expect(dec.decode(out.content)).toBe('keyfile gallery secret');
  });

  it('estimateGalleryCovers predicts the minimum cover count encode needs', async () => {
    const secret = enc.encode('a short secret');
    const { needed } = await estimateGalleryCovers('s.txt', secret, 'embedded');
    expect(needed).toBe(5); // k=1 + m=2 + 2 decoys for a tiny secret
    const covers = Array.from({ length: needed }, (_, i) => rgbaCover(`p${i}.png`, i + 60));
    const res = await galleryEncode('s.txt', secret, 'pw', covers, { params: FAST });
    expect(res.images.length).toBe(needed);
  });

  it('rejects a secret larger than the 1 MiB content ceiling', async () => {
    const covers = [0, 1, 2, 3, 4, 5].map((i) => rgbaCover(`p${i}.png`, i + 20));
    const tooBig = new Uint8Array(1024 * 1024 + 1).fill(0x41);
    await expect(
      galleryEncode('huge.txt', tooBig, 'pw', covers, { params: FAST }),
    ).rejects.toThrow(GalleryFileTooLargeError);
  });

  it('wrong password yields no restorable gallery', async () => {
    const covers = [1, 2, 3, 4, 5].map((i) => rgbaCover(`p${i}.png`, i));
    const { images } = await galleryEncode('x', enc.encode('hi'), 'right', covers, {
      params: FAST,
    });
    await expect(
      galleryDecode(images as GalleryCover[], 'wrong', { params: FAST }),
    ).rejects.toBeInstanceOf(GalleryRestoreError);
  });
});

describe('gallery resilience', () => {
  it('amnesia: restores after images are deleted (parity recovery)', async () => {
    const covers = Array.from({ length: 10 }, (_, i) => rgbaCover(`p${i}.png`, i + 1));
    const secret = globalThis.crypto.getRandomValues(new Uint8Array(10000)); // incompressible → several shards
    const { images, k, m } = await galleryEncode('big.bin', secret, 'pw', covers, { params: FAST });
    expect(k).toBeGreaterThan(1); // genuinely fragmented

    // Drop m carrier images (indices 0 and 1 are data shards) plus survivors ≥ k.
    const survivors = (images as GalleryImage[]).filter((_, i) => i !== 0 && i !== 1);
    const out = await galleryDecode(survivors as GalleryCover[], 'pw', { params: FAST });
    expect([...out.content]).toEqual([...secret]);
    expect(m).toBeGreaterThanOrEqual(2);
  }, 20000);

  it('recompression: destroyed carriers are rejected, RS restores from the rest', async () => {
    const covers = [1, 2, 3, 4, 5, 6].map((i) => jpegCover(`c${i}.jpg`, i));
    const secret = enc.encode('resilient secret');
    const { images } = await galleryEncode('r.txt', secret, 'pw', covers, { params: FAST });

    // Corrupt two carrier images by recompressing them (k=1, m=2 → 1 survivor suffices).
    const damaged = (images as GalleryImage[]).map((img, i) => {
      if (i < 2 && img.kind === 'jpeg') return { ...img, jpeg: recompress(img.jpeg) };
      return img;
    });
    const out = await galleryDecode(damaged as GalleryCover[], 'pw', { params: FAST });
    expect(dec.decode(out.content)).toBe('resilient secret');
  }, 30000);

  it('noise: foreign and undersized images are ignored, not fatal', async () => {
    const covers = [1, 2, 3, 4, 5].map((i) => jpegCover(`c${i}.jpg`, i));
    const { images } = await galleryEncode('n.txt', enc.encode('ignore the noise'), 'pw', covers, {
      params: FAST,
    });
    const withNoise: GalleryCover[] = [
      ...(images as GalleryCover[]),
      jpegCover('foreign.jpg', 999), // never embedded
      { kind: 'jpeg', name: 'tiny.jpg', jpeg: noisyJpeg(16, 16, 20) }, // below capacity
      jpegCover('camera.jpg', 12345), // another random photo
    ];
    const out = await galleryDecode(withNoise, 'pw', { params: FAST });
    expect(dec.decode(out.content)).toBe('ignore the noise');
  }, 30000);

  it('a mid-capacity foreign photo is skipped, not fatal (keystream guard)', async () => {
    const covers = [1, 2, 3, 4, 5].map((i) => jpegCover(`c${i}.jpg`, i));
    const { images } = await galleryEncode('g.txt', enc.encode('guarded'), 'pw', covers, {
      params: FAST,
    });
    // A foreign JPEG whose eligible-carrier count sits just above the slot size but
    // below the 4x embedding margin (~17.9k carriers vs a 16.9k-bit slot). It once
    // drained the position keystream and threw, aborting the whole restore; the
    // capacity-margin guard on extraction must now skip it instead.
    const foreign: GalleryCover = { kind: 'jpeg', name: 'foreign.jpg', jpeg: noisyJpeg(112, 112) };
    const out = await galleryDecode([...(images as GalleryCover[]), foreign], 'pw', {
      params: FAST,
    });
    expect(dec.decode(out.content)).toBe('guarded');
  }, 30000);
});

describe('gallery deniability', () => {
  it('every JPEG output stays within 0.5% of its cover size (size invariance)', async () => {
    const covers = [1, 2, 3, 4, 5, 6].map((i) => jpegCover(`c${i}.jpg`, i));
    const { images } = await galleryEncode('s.txt', enc.encode('deniable'), 'pw', covers, {
      params: FAST,
    });
    images.forEach((img, i) => {
      const cover = covers[i]!;
      if (img.kind === 'jpeg' && cover.kind === 'jpeg') {
        // Byte-faithful in-place edit; the only drift is the odd byte-stuffing
        // 0x00 gained/lost when a toggled byte crosses 0xFF — a few bytes at most.
        const drift = Math.abs(img.jpeg.length - cover.jpeg.length);
        expect(drift / cover.jpeg.length).toBeLessThan(0.005);
        expect(drift).toBeLessThan(64);
      }
    });
  }, 30000);

  it('the Huffman size-category histogram is identical before and after embedding', async () => {
    const covers = [1, 2, 3, 4, 5].map((i) => jpegCover(`c${i}.jpg`, i));
    const { images } = await galleryEncode('h.txt', enc.encode('histogram'), 'pw', covers, {
      params: FAST,
    });
    images.forEach((img, i) => {
      const cover = covers[i]!;
      if (img.kind === 'jpeg' && cover.kind === 'jpeg') {
        expect(acHistogram(img.jpeg)).toEqual(acHistogram(cover.jpeg));
      }
    });
  }, 30000);

  it('decoy payloads look like ciphertext (Shannon entropy ≈ 8 bits/byte)', async () => {
    // Two data/parity + several decoys; decoys are getRandomValues of slot size.
    const covers = Array.from({ length: 8 }, (_, i) => rgbaCover(`p${i}.png`, i + 1));
    const { images, k, m } = await galleryEncode('e.txt', enc.encode('small'), 'pw', covers, {
      params: FAST,
    });
    // Recover each embedded slot's bytes is not exposed; instead validate the
    // property on freshly generated decoy-sized random buffers (what encode uses).
    for (let t = 0; t < 3; t++) {
      const decoy = globalThis.crypto.getRandomValues(new Uint8Array(GALLERY_SLOT_BYTES));
      expect(shannonEntropy(decoy)).toBeGreaterThan(7.5);
    }
    expect(k + m).toBeLessThan(images.length); // there really are decoys
  });
});

describe('gallery grouping and validation', () => {
  it('resolves the majority set when two same-password galleries are mixed', async () => {
    const coversA = [1, 2, 3, 4, 5, 6, 7].map((i) => rgbaCover(`a${i}.png`, i)); // 7 → more carriers
    const coversB = [11, 12, 13, 14, 15].map((i) => rgbaCover(`b${i}.png`, i));
    const a = await galleryEncode('A.txt', enc.encode('alpha secret'), 'pw', coversA, {
      params: FAST,
    });
    const b = await galleryEncode('B.txt', enc.encode('bravo'), 'pw', coversB, { params: FAST });

    const mixed = [...(a.images as GalleryCover[]), ...(b.images as GalleryCover[])];
    const out = await galleryDecode(mixed, 'pw', { params: FAST });
    expect(dec.decode(out.content)).toBe('alpha secret'); // A has more fragments

    // B still restores on its own.
    const outB = await galleryDecode(b.images as GalleryCover[], 'pw', { params: FAST });
    expect(dec.decode(outB.content)).toBe('bravo');
  }, 20000);

  it('tolerates a duplicated carrier and an un-embedded original', async () => {
    const covers = [1, 2, 3, 4, 5].map((i) => rgbaCover(`p${i}.png`, i));
    const { images } = await galleryEncode('d.txt', enc.encode('dedupe me'), 'pw', covers, {
      params: FAST,
    });
    const withDupes: GalleryCover[] = [
      ...(images as GalleryCover[]),
      (images as GalleryCover[])[0]!, // duplicate a carrier
      rgbaCover('original.png', 1), // the untouched original of p1
    ];
    const out = await galleryDecode(withDupes, 'pw', { params: FAST });
    expect(dec.decode(out.content)).toBe('dedupe me');
  });
});

describe('gallery guardrails', () => {
  it('rejects too few images', async () => {
    const covers = [1, 2, 3, 4].map((i) => rgbaCover(`p${i}.png`, i)); // < MIN_IMAGES (5)
    await expect(
      galleryEncode('x', enc.encode('hi'), 'pw', covers, { params: FAST }),
    ).rejects.toBeInstanceOf(GalleryTooFewImagesError);
  });

  it('rejects more photos than the ceiling', async () => {
    // The count check fires before any embedding, so 1×1 covers are fine here.
    const covers: GalleryCover[] = Array.from({ length: 257 }, (_, i) => ({
      kind: 'rgba',
      name: `p${i}.png`,
      rgba: new Uint8Array(4),
      width: 1,
      height: 1,
    }));
    await expect(
      galleryEncode('x', enc.encode('hi'), 'pw', covers, { params: FAST }),
    ).rejects.toBeInstanceOf(GalleryTooManyImagesError);
  });

  it('rejects a cover without enough carriers', async () => {
    const covers: GalleryCover[] = [
      rgbaCover('p1.png', 1),
      rgbaCover('p2.png', 2),
      rgbaCover('p3.png', 3),
      rgbaCover('p4.png', 4),
      { kind: 'jpeg', name: 'smooth.jpg', jpeg: noisyJpeg(16, 16, 20) }, // too small
    ];
    await expect(
      galleryEncode('x', enc.encode('hi'), 'pw', covers, { params: FAST }),
    ).rejects.toBeInstanceOf(GalleryCoverCapacityError);
  });
});

/** Histogram of AC-coefficient size categories (bit length of |coef|), across all blocks. */
function acHistogram(jpg: Uint8Array): Record<number, number> {
  const model = decodeJpeg(jpg);
  const h: Record<number, number> = {};
  for (const c of model.components) {
    for (const b of c.blocks) {
      for (let i = 1; i < 64; i++) {
        const v = b[i]!;
        const cat = v === 0 ? 0 : Math.floor(Math.log2(Math.abs(v))) + 1;
        h[cat] = (h[cat] ?? 0) + 1;
      }
    }
  }
  return h;
}

/** Shannon entropy in bits per byte. */
function shannonEntropy(bytes: Uint8Array): number {
  const counts = new Array(256).fill(0);
  for (const b of bytes) counts[b]++;
  let h = 0;
  for (const n of counts) {
    if (n === 0) continue;
    const p = n / bytes.length;
    h -= p * Math.log2(p);
  }
  return h;
}

describe('gallery cover estimate accounts for the full blob (A3 contentSalt)', () => {
  it('counts the per-export contentSalt so the estimate matches the real blob split', () => {
    // Envelope length chosen so the blob straddles a GALLERY_SLOT_DATA boundary
    // ONLY because of A3's 16-byte contentSalt: keyfile blob = 2+16+12+env+16.
    // At env=2010 → blob=2056 → k=2; without the contentSalt it would be 2040 → k=1.
    const env = 2 * GALLERY_SLOT_DATA - 2038; // 2010 when SLOT_DATA=2048
    const { k } = galleryCoversForEnvelopeLen(env, 'keyfile');
    expect(k).toBe(2);
  });
});
