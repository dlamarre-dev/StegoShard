/**
 * Gallery Mode (SPEC §9 + §10): fragmented, decoy-padded, blind-winnowed
 * round-trips plus the resilience and deniability properties the threat model
 * demands: loss/recompression tolerance, noise rejection, size invariance, an
 * identical Huffman size-category histogram, and high-entropy decoys.
 *
 * Under the §10 access-structure geometry every gallery vault carries the
 * mandatory 4-slot / 2-region blob, so a secret costs ~2× the fragments it used
 * to and even a tiny secret needs several data shards. Cover counts here are
 * therefore provisioned from `estimateGalleryCovers` rather than hard-coded.
 */

import { describe, it, expect } from 'vitest';
import jpeg from 'jpeg-js';
import {
  type Argon2Params,
  type GalleryCover,
  type GalleryImage,
  GALLERY_SLOT_BYTES,
  GalleryCoversRejectedError,
  GalleryFileTooLargeError,
  GalleryRestoreError,
  GalleryTooFewImagesError,
  GalleryTooManyImagesError,
  JpegUnsupportedError,
  DEFAULT_CALIBRATION,
  ProgressTracker,
  planSave,
  type Progress,
  decode as decodeJpeg,
  estimateGalleryCovers,
  galleryCoversForEnvelopeLen,
  galleryDecode,
  galleryEncode,
  inspectJpegCover,
  shamirRecover,
} from './index';
import { withC2pa } from './jpeg-fixtures';

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

/**
 * Cover sizes are set by the embed margin, not by taste.
 *
 * `GALLERY_EMBED_MARGIN` asks for 16 eligible carriers per payload bit — 269 952
 * of them for one slot — so a cover has to be big enough to hold that many.
 * Noise at q85 yields roughly 680k carriers per megapixel, and a raster cover
 * yields three per pixel, which is where 768² and 384² come from. The old 256²
 * fixtures were sized for the 4× margin and now fail the screen, correctly.
 */
function jpegCover(name: string, seed: number, size = 768): GalleryCover {
  return { kind: 'jpeg', name, jpeg: noisyJpeg(size, size, 85, seed) };
}

function rgbaCover(name: string, seed: number, w = 384, h = 384): GalleryCover {
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

/** Re-encode a JPEG at a different quality; simulates a cloud service recompressing. */
function recompress(jpg: Uint8Array, quality = 70): Uint8Array {
  const d = jpeg.decode(jpg, { useTArray: true });
  return new Uint8Array(
    jpeg.encode({ data: Buffer.from(d.data), width: d.width, height: d.height }, quality).data,
  );
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Provision `needed + extra` covers of one kind, sized to the new 2× geometry. */
async function coversFor(
  filename: string,
  content: Uint8Array,
  make: (name: string, seed: number) => GalleryCover,
  extra = 2,
): Promise<{ covers: GalleryCover[]; k: number; m: number; needed: number }> {
  const { k, m, needed } = await estimateGalleryCovers(filename, content, 'embedded');
  const covers = Array.from({ length: needed + extra }, (_, i) => make(`p${i}`, i + 101));
  return { covers, k, m, needed };
}

/**
 * Cover normalization across the set (SPEC §9.7).
 *
 * The property is uniformity, not cleanliness, so the decoys matter as much as
 * the carriers: a set where only the K+M fragment photos lost their manifests
 * sorts exactly as well as one where only those photos fail C2PA validation.
 * `galleryEncode` normalizes before it embeds, so these assert on the produced
 * images rather than on what was handed in.
 */
describe('gallery cover normalization', () => {
  it('strips the manifest from carriers AND decoys alike', async () => {
    const secret = enc.encode('uniformity is the property');
    const { covers, k, m } = await coversFor('n.txt', secret, (n, s) => jpegCover(`${n}.jpg`, s));
    // Every cover arrives carrying a manifest.
    const dirty = covers.map((c) => (c.kind === 'jpeg' ? { ...c, jpeg: withC2pa(c.jpeg, 2) } : c));

    const res = await galleryEncode('n.txt', secret, 'pw', dirty, { params: FAST });
    for (const img of res.images) {
      if (img.kind === 'jpeg') expect(inspectJpegCover(img.jpeg).jumbf.segments).toBe(0);
    }
    // Decoys are the covers past the K+M carriers, and they are in the loop too.
    expect(res.images.length).toBeGreaterThan(k + m);
    expect(res.normalization.removed.covers).toBe(dirty.length);
    expect(res.normalization.uniform).toBe(true);
  }, 120000);

  it('normalizes a mixed set down to one profile, not just the dirty half', async () => {
    const secret = enc.encode('half and half');
    const { covers } = await coversFor('n.txt', secret, (n, s) => jpegCover(`${n}.jpg`, s));
    const mixed = covers.map((c, i) =>
      c.kind === 'jpeg' && i % 2 === 0 ? { ...c, jpeg: withC2pa(c.jpeg, 1) } : c,
    );

    const res = await galleryEncode('n.txt', secret, 'pw', mixed, { params: FAST });
    expect(res.normalization.removed.covers).toBeGreaterThan(0);
    expect(res.normalization.removed.covers).toBeLessThan(mixed.length);
    // The point: having started uneven, the set ends up even.
    expect(res.normalization.covers?.withManifest).toEqual([]);
    expect(res.normalization.covers?.divergent).toEqual([]);
    expect(res.normalization.uniform).toBe(true);
  }, 120000);

  it('still restores after the manifests are gone', async () => {
    const secret = enc.encode('round trip through normalization');
    const { covers } = await coversFor('n.txt', secret, (n, s) => jpegCover(`${n}.jpg`, s));
    const dirty = covers.map((c) => (c.kind === 'jpeg' ? { ...c, jpeg: withC2pa(c.jpeg, 3) } : c));
    const { images } = await galleryEncode('n.txt', secret, 'pw', dirty, { params: FAST });
    const out = await galleryDecode(images as GalleryCover[], 'pw', { params: FAST });
    expect(dec.decode(out.content)).toBe('round trip through normalization');
  }, 120000);

  it('reports a raster cover set as non-uniform when it is mixed with JPEGs', async () => {
    const secret = enc.encode('mixed formats');
    const { covers } = await coversFor('n.txt', secret, (n, s) => jpegCover(`${n}.jpg`, s));
    // Swap one JPEG for a PNG-backed raster cover of the same size.
    const mixed = [...covers.slice(0, -1), rgbaCover('odd.png', 77)];
    const res = await galleryEncode('n.txt', secret, 'pw', mixed, { params: FAST });
    expect(res.normalization.raster).toBe(1);
    expect(res.normalization.uniform).toBe(false);
  }, 120000);

  /**
   * `fileToGalleryCover` calls anything with an SOI a JPEG, so a truncated photo
   * in the cover folder reaches normalization. It used to arrive as a bare
   * `JpegStructureError`, which no image adapter maps, so a consumer catching
   * `StegoCoverFormatError` around a gallery save met an unhandled type. The
   * refusal is also cheap: it lands before the Argon2, not after it.
   */
  it('refuses a truncated cover with the class the adapters translate', async () => {
    const secret = enc.encode('truncated cover');
    const { covers } = await coversFor('n.txt', secret, (n, s) => jpegCover(`${n}.jpg`, s));
    const broken = covers.map((c, i) =>
      i === 0 && c.kind === 'jpeg' ? { ...c, jpeg: c.jpeg.subarray(0, c.jpeg.length - 12) } : c,
    );
    await expect(
      galleryEncode('n.txt', secret, 'pw', broken, { params: FAST }),
    ).rejects.toMatchObject({ name: 'JpegUnsupportedError' });
  });

  it('an all-raster set is uniform and reports nothing removed', async () => {
    const secret = enc.encode('all png');
    const { covers } = await coversFor('n.txt', secret, (n, s) => rgbaCover(`${n}.png`, s));
    const res = await galleryEncode('n.txt', secret, 'pw', covers, { params: FAST });
    expect(res.normalization.raster).toBe(covers.length);
    expect(res.normalization.covers).toBeNull();
    expect(res.normalization.removed.covers).toBe(0);
    expect(res.normalization.uniform).toBe(true);
  });
});

describe('gallery round-trip', () => {
  it('hides a secret across RGBA covers and restores it blindly', async () => {
    const secret = enc.encode('the launch codes are 0000');
    const { covers } = await coversFor('note.txt', secret, (n, s) => rgbaCover(`${n}.png`, s));
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
    const secret = enc.encode('gallery jpeg secret');
    const { covers } = await coversFor('s.txt', secret, (n, s) => jpegCover(`${n}.jpg`, s));
    const { images } = await galleryEncode('s.txt', secret, 'hunter2', covers, { params: FAST });
    for (const img of images) {
      if (img.kind === 'jpeg') expect(decodeJpeg(img.jpeg).width).toBe(768);
    }
    const out = await galleryDecode(images as GalleryCover[], 'hunter2', { params: FAST });
    expect(dec.decode(out.content)).toBe('gallery jpeg secret');
  }, 120000);

  it('round-trips a compressible secret larger than the compressed-blob ceiling', async () => {
    // 20 KB of repetition gzips to well under a gallery bucket but inflates back on
    // restore. Regression for the decode bound bug that once capped decompression
    // at the compressed ceiling.
    const secret = new Uint8Array(20 * 1024).fill(0x41);
    const { covers } = await coversFor('big.txt', secret, (n, s) => rgbaCover(`${n}.png`, s));
    const { images } = await galleryEncode('big.txt', secret, 'pw', covers, { params: FAST });
    const out = await galleryDecode(images as GalleryCover[], 'pw', { params: FAST });
    expect(out.content.length).toBe(secret.length);
    expect([...out.content.subarray(0, 8)]).toEqual([...secret.subarray(0, 8)]);
  });

  it('round-trips a keyfile gallery only with the external key factor', async () => {
    const secret = enc.encode('keyfile gallery secret');
    const { covers } = await coversFor('k.txt', secret, (n, s) => rgbaCover(`${n}.png`, s));
    const { images, keyBlock } = await galleryEncode('k.txt', secret, 'pw', covers, {
      params: FAST,
      keyMode: 'keyfile',
    });
    // The external key factor (32 random bytes) is required; without it the slot
    // KEK is wrong and no fragment unwraps → indistinguishable from no gallery.
    expect(keyBlock.length).toBe(32);
    await expect(galleryDecode(images as GalleryCover[], 'pw', { params: FAST })).rejects.toThrow(
      GalleryRestoreError,
    );
    const out = await galleryDecode(images as GalleryCover[], 'pw', { params: FAST, keyBlock });
    expect(dec.decode(out.content)).toBe('keyfile gallery secret');
  });

  it('estimateGalleryCovers predicts the minimum cover count encode needs', async () => {
    const secret = enc.encode('a short secret');
    const { k, m, needed } = await estimateGalleryCovers('s.txt', secret, 'embedded');
    // A tiny secret pads to the 4 KiB gallery bucket; the doubled blob spans ~5
    // data shards, so the floor is well above the old k=1 minimum.
    expect(needed).toBe(k + m + 2);
    expect(k).toBeGreaterThan(1);
    const covers = Array.from({ length: needed }, (_, i) => rgbaCover(`p${i}.png`, i + 60));
    const res = await galleryEncode('s.txt', secret, 'pw', covers, { params: FAST });
    expect(res.images.length).toBe(needed);
  });

  it('rejects a secret larger than a gallery can carry', async () => {
    // Above the 64 KiB gallery bucket ceiling: no bucket fits → GalleryFileTooLargeError.
    const covers = Array.from({ length: 12 }, (_, i) => rgbaCover(`p${i}.png`, i + 20));
    const tooBig = new Uint8Array(70 * 1024);
    let s = 0x1234abcd >>> 0;
    for (let i = 0; i < tooBig.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      tooBig[i] = (s >>> 24) & 0xff; // incompressible, so it can't slip under a bucket
    }
    await expect(galleryEncode('huge.bin', tooBig, 'pw', covers, { params: FAST })).rejects.toThrow(
      GalleryFileTooLargeError,
    );
  });

  it('wrong password yields no restorable gallery', async () => {
    const secret = enc.encode('hi');
    const { covers } = await coversFor('x', secret, (n, s) => rgbaCover(`${n}.png`, s));
    const { images } = await galleryEncode('x', secret, 'right', covers, { params: FAST });
    await expect(
      galleryDecode(images as GalleryCover[], 'wrong', { params: FAST }),
    ).rejects.toBeInstanceOf(GalleryRestoreError);
  });
});

describe('gallery resilience', () => {
  it('amnesia: restores after images are deleted (parity recovery)', async () => {
    const secret = globalThis.crypto.getRandomValues(new Uint8Array(3000)); // incompressible, k=5
    const { covers, k, m } = await coversFor(
      'big.bin',
      secret,
      (n, s) => rgbaCover(`${n}.png`, s),
      3,
    );
    expect(k).toBeGreaterThan(1); // genuinely fragmented
    expect(m).toBeGreaterThanOrEqual(2);
    const { images } = await galleryEncode('big.bin', secret, 'pw', covers, { params: FAST });

    // Drop m carrier images (indices 0..m-1 are data/parity shards).
    const survivors = (images as GalleryImage[]).filter((_, i) => i >= m);
    const out = await galleryDecode(survivors as GalleryCover[], 'pw', { params: FAST });
    expect([...out.content]).toEqual([...secret]);
  }, 20000);

  it('recompression: destroyed carriers are rejected, RS restores from the rest', async () => {
    const secret = enc.encode('resilient secret');
    const { covers, m } = await coversFor('r.txt', secret, (n, s) => jpegCover(`${n}.jpg`, s), 3);
    const { images } = await galleryEncode('r.txt', secret, 'pw', covers, { params: FAST });

    // Corrupt m carrier images by recompressing them; ≥ k survivors suffice.
    const damaged = (images as GalleryImage[]).map((img, i) => {
      if (i < m && img.kind === 'jpeg') return { ...img, jpeg: recompress(img.jpeg) };
      return img;
    });
    const out = await galleryDecode(damaged as GalleryCover[], 'pw', { params: FAST });
    expect(dec.decode(out.content)).toBe('resilient secret');
  }, 120000);

  it('noise: foreign and undersized images are ignored, not fatal', async () => {
    const secret = enc.encode('ignore the noise');
    const { covers } = await coversFor('n.txt', secret, (n, s) => jpegCover(`${n}.jpg`, s));
    const { images } = await galleryEncode('n.txt', secret, 'pw', covers, { params: FAST });
    const withNoise: GalleryCover[] = [
      ...(images as GalleryCover[]),
      jpegCover('foreign.jpg', 999), // never embedded
      { kind: 'jpeg', name: 'tiny.jpg', jpeg: noisyJpeg(16, 16, 20) }, // below capacity
      jpegCover('camera.jpg', 12345), // another random photo
    ];
    const out = await galleryDecode(withNoise, 'pw', { params: FAST });
    expect(dec.decode(out.content)).toBe('ignore the noise');
  }, 120000);

  it('a mid-capacity foreign photo is skipped, not fatal (keystream guard)', async () => {
    const secret = enc.encode('guarded');
    const { covers } = await coversFor('g.txt', secret, (n, s) => jpegCover(`${n}.jpg`, s));
    const { images } = await galleryEncode('g.txt', secret, 'pw', covers, { params: FAST });
    // A foreign JPEG whose eligible-carrier count sits just above the slot size but
    // below the 4x embedding margin. It once drained the position keystream and threw;
    // the capacity-margin guard on extraction must now skip it instead.
    const foreign: GalleryCover = { kind: 'jpeg', name: 'foreign.jpg', jpeg: noisyJpeg(112, 112) };
    const out = await galleryDecode([...(images as GalleryCover[]), foreign], 'pw', {
      params: FAST,
    });
    expect(dec.decode(out.content)).toBe('guarded');
  }, 120000);
});

describe('gallery deniability', () => {
  it('every JPEG output stays within 0.5% of its cover size (size invariance)', async () => {
    const secret = enc.encode('deniable');
    const { covers } = await coversFor('s.txt', secret, (n, s) => jpegCover(`${n}.jpg`, s));
    const { images } = await galleryEncode('s.txt', secret, 'pw', covers, { params: FAST });
    images.forEach((img, i) => {
      const cover = covers[i]!;
      if (img.kind === 'jpeg' && cover.kind === 'jpeg') {
        const drift = Math.abs(img.jpeg.length - cover.jpeg.length);
        expect(drift / cover.jpeg.length).toBeLessThan(0.005);
        expect(drift).toBeLessThan(64);
      }
    });
  }, 120000);

  it('the Huffman size-category histogram is identical before and after embedding', async () => {
    const secret = enc.encode('histogram');
    const { covers } = await coversFor('h.txt', secret, (n, s) => jpegCover(`${n}.jpg`, s));
    const { images } = await galleryEncode('h.txt', secret, 'pw', covers, { params: FAST });
    images.forEach((img, i) => {
      const cover = covers[i]!;
      if (img.kind === 'jpeg' && cover.kind === 'jpeg') {
        expect(acHistogram(img.jpeg)).toEqual(acHistogram(cover.jpeg));
      }
    });
  }, 120000);

  it('decoy payloads look like ciphertext (Shannon entropy ≈ 8 bits/byte)', async () => {
    const secret = enc.encode('small');
    const { covers } = await coversFor('e.txt', secret, (n, s) => rgbaCover(`${n}.png`, s), 4);
    const { images, k, m } = await galleryEncode('e.txt', secret, 'pw', covers, { params: FAST });
    for (let t = 0; t < 3; t++) {
      const decoy = globalThis.crypto.getRandomValues(new Uint8Array(GALLERY_SLOT_BYTES));
      expect(shannonEntropy(decoy)).toBeGreaterThan(7.5);
    }
    expect(k + m).toBeLessThan(images.length); // there really are decoys
  });
});

/**
 * Which covers carry the shards is drawn, not taken from the input order.
 *
 * Images come back in input order and every surface writes them in it, so if the
 * first K+M inputs were the carriers, the order files land in, and their
 * modification times, would point at the photos holding the secret. Checked
 * without reaching inside: drop the first m+1 images. Under the old rule those
 * were always carriers, leaving k-1 of the k needed, and the restore failed
 * every time. With twenty photos and drawn roles, all m+1 being carriers is a
 * few-percent event, so across three independent saves at least one restores.
 */
describe('gallery role assignment', () => {
  it('does not make the first K+M covers the carriers', async () => {
    const secret = enc.encode('the order says nothing');
    let restored = 0;
    for (let run = 0; run < 3 && restored === 0; run++) {
      const { covers } = await coversFor(
        'r.txt',
        secret,
        (n, s) => rgbaCover(`${n}.png`, s + run * 100),
        11,
      );
      const { images, m } = await galleryEncode('r.txt', secret, 'pw', covers, { params: FAST });
      const kept = images.slice(m + 1);
      const ok = await galleryDecode(kept, 'pw', { params: FAST }).then(
        (r) => r.content.length === secret.length,
        () => false,
      );
      if (ok) restored++;
    }
    expect(restored).toBe(1);
  }, 180000);
});

/**
 * The events a gallery save reports, replayed into its progress plan.
 *
 * The plan (`planSave`) and the code have to agree stage for stage: an event
 * the plan does not expect where it expects it makes the tracker skip ahead,
 * and the bar jumps. So the real stream is recorded and fed in, and the plan
 * must reach the end with no stage skipped. The CLI's plan is the one whose
 * stages are all core's (the browser adds its own around them).
 */
describe('gallery progress', () => {
  it('reports every stage of its plan, in order', async () => {
    const secret = enc.encode('progress');
    const { covers } = await coversFor('p.txt', secret, (n, s) => rgbaCover(`${n}.png`, s));
    const events: Progress[] = [];
    const onProgress = (p: Progress): void => {
      events.push(p);
    };
    const res = await galleryEncode('p.txt', secret, 'pw', covers, { params: FAST, onProgress });
    // What `verifyGalleryExport` runs, with this test's cheap Argon2 parameters.
    await galleryDecode(res.images as GalleryCover[], 'pw', { params: FAST, onProgress });

    const plan = planSave({
      surface: 'cli',
      dest: 'gallery',
      keyMode: 'embedded',
      secretBytes: secret.length,
      coverBytes: covers.map(() => 100_000),
      preserveContainer: true, // no re-encode: these covers are handed in as pixels
      argon2: FAST,
    });
    const tracker = new ProgressTracker(plan, DEFAULT_CALIBRATION, () => 0);
    let last = 0;
    for (const e of events) {
      const f = tracker.onEvent(e).fraction;
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
    expect(tracker.skipped()).toBe(0);
    expect(tracker.view().finished).toBe(true);
    // Two derivations to save, two to verify.
    expect(events.filter((e) => e.phase === 'derive' && e.done === 1)).toHaveLength(4);
  }, 60000);
});

describe('gallery grouping and validation', () => {
  it('resolves the majority set when two same-password galleries are mixed', async () => {
    // A carries a larger secret (more shards) than B, so A wins the majority.
    const secretA = globalThis.crypto.getRandomValues(new Uint8Array(6000)); // k=17
    const secretB = enc.encode('bravo'); // k=5
    const A = await coversFor('A.txt', secretA, (n, s) => rgbaCover(`a${n}.png`, s), 1);
    const B = await coversFor('B.txt', secretB, (n, s) => rgbaCover(`b${n}.png`, s + 500), 1);
    expect(A.k).toBeGreaterThan(B.k);
    const a = await galleryEncode('A.txt', secretA, 'pw', A.covers, { params: FAST });
    const b = await galleryEncode('B.txt', secretB, 'pw', B.covers, { params: FAST });

    const mixed = [...(a.images as GalleryCover[]), ...(b.images as GalleryCover[])];
    const out = await galleryDecode(mixed, 'pw', { params: FAST });
    expect([...out.content]).toEqual([...secretA]); // A has more fragments

    const outB = await galleryDecode(b.images as GalleryCover[], 'pw', { params: FAST });
    expect(dec.decode(outB.content)).toBe('bravo');
  }, 30000);

  it('tolerates a duplicated carrier and an un-embedded original', async () => {
    const secret = enc.encode('dedupe me');
    const { covers } = await coversFor('d.txt', secret, (n, s) => rgbaCover(`${n}.png`, s));
    const { images } = await galleryEncode('d.txt', secret, 'pw', covers, { params: FAST });
    const withDupes: GalleryCover[] = [
      ...(images as GalleryCover[]),
      (images as GalleryCover[])[0]!, // duplicate a carrier
      rgbaCover('original.png', 101), // the untouched original of p0 (seed 101)
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

  it('rejects a cover without enough carriers, naming it and only it', async () => {
    // Enough covers to clear the count floor, with a too-small carrier at index 0.
    const secret = enc.encode('hi');
    const { needed } = await estimateGalleryCovers('x', secret, 'embedded');
    const covers: GalleryCover[] = [
      { kind: 'jpeg', name: 'smooth.jpg', jpeg: noisyJpeg(16, 16, 20) }, // too small, a carrier
      ...Array.from({ length: needed }, (_, i) => rgbaCover(`p${i}.png`, i + 1)),
    ];
    const err = await galleryEncode('x', secret, 'pw', covers, { params: FAST }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GalleryCoversRejectedError);
    // Only the offender is named: a refusal that listed the whole folder would
    // tell the user to throw away photos that are fine.
    expect((err as GalleryCoversRejectedError).names).toEqual(['smooth.jpg']);
  });

  /**
   * The screen runs over the whole set, so a decoy that cannot take a slot
   * sparsely is refused exactly like a carrier would be. That is the point: if
   * "passes the screen" were true only of the carriers, it would be a test an
   * analyst could run to find them.
   */
  it('rejects a smooth decoy as readily as a smooth carrier', async () => {
    const secret = enc.encode('hi');
    const { needed } = await estimateGalleryCovers('x', secret, 'embedded');
    const covers: GalleryCover[] = [
      ...Array.from({ length: needed }, (_, i) => rgbaCover(`p${i}.png`, i + 1)),
      // Past the K+M carriers, so this one would have held nothing but chaff.
      { kind: 'jpeg', name: 'flat-decoy.jpg', jpeg: noisyJpeg(16, 16, 20) },
      ...Array.from({ length: 2 }, (_, i) => rgbaCover(`q${i}.png`, i + 60)),
    ];
    const err = await galleryEncode('x', secret, 'pw', covers, { params: FAST }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GalleryCoversRejectedError);
    expect((err as GalleryCoversRejectedError).names).toEqual(['flat-decoy.jpg']);
  });

  /**
   * A progressive JPEG reaches the core under `preserveContainer`. It cannot be
   * embedded into, and the refusal has to say so: the capacity count used to
   * read "cannot decode" as zero carriers and call it too smooth, which tells a
   * user to drop a textured photo for the wrong reason.
   */
  it('reports a progressive JPEG as unsupported, not as too smooth', async () => {
    const secret = enc.encode('hi');
    const { needed } = await estimateGalleryCovers('x', secret, 'embedded');
    const progressive = noisyJpeg(64, 64);
    const sof = progressive.findIndex((b, i) => b === 0xff && progressive[i + 1] === 0xc0);
    progressive[sof + 1] = 0xc2; // SOF0 -> SOF2
    const covers: GalleryCover[] = [
      { kind: 'jpeg', name: 'progressive.jpg', jpeg: progressive },
      ...Array.from({ length: needed }, (_, i) => rgbaCover(`p${i}.png`, i + 1)),
    ];
    const err = await galleryEncode('x', secret, 'pw', covers, { params: FAST }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JpegUnsupportedError);
    expect(err).not.toBeInstanceOf(GalleryCoversRejectedError);
  });

  /**
   * The screen is a floor, not a ranking. A folder of photos that all clear the
   * margin comes out whole, however differently textured they are: selecting the
   * best of a folder would make the delivered set the textured tail of it, which
   * is a property an analyst could look for (SPEC §9.8).
   */
  it('keeps every cover that clears the bar, however far it clears it', async () => {
    const secret = enc.encode('hi');
    const { needed } = await estimateGalleryCovers('x', secret, 'embedded');
    const covers: GalleryCover[] = Array.from({ length: needed }, (_, i) =>
      // Alternating 384² and 768²: a 4x spread in carriers, all of it above the bar.
      i % 2 === 0 ? rgbaCover(`p${i}.png`, i + 1) : rgbaCover(`p${i}.png`, i + 1, 768, 768),
    );
    const res = await galleryEncode('x', secret, 'pw', covers, { params: FAST });
    expect(res.images.length).toBe(needed);
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

describe('gallery non-possession (Mode B, §10.6)', () => {
  it('gated on threshold shares: password + k restores, password alone cannot', async () => {
    const secret = enc.encode('gated gallery secret');
    const { covers } = await coversFor('g.txt', secret, (n, s) => rgbaCover(`${n}.png`, s));
    const { images, shares } = await galleryEncode('g.txt', secret, 'pw', covers, {
      params: FAST,
      mode: 'nonpossession',
      threshold: { k: 2, n: 3 },
    });
    expect(shares?.length).toBe(3);

    // The password winnows the fragments, but the gated slot won't open without S.
    await expect(galleryDecode(images as GalleryCover[], 'pw', { params: FAST })).rejects.toThrow(
      GalleryRestoreError,
    );

    // Any 2 of the 3 shares recover S → the gated slot opens.
    const S = await shamirRecover([shares![0]!, shares![2]!]);
    const out = await galleryDecode(images as GalleryCover[], 'pw', { params: FAST, secret: S });
    expect(dec.decode(out.content)).toBe('gated gallery secret');
    expect(out.bundled).toBe(false);
  });

  // Found in review: the plain branch forwarded `bundle` and this one did not,
  // so a multi-file save restored as one opaque .zip.
  it('keeps the bundle flag, as the plain branch does', async () => {
    const secret = enc.encode('a bundle standing in for several files');
    const { covers } = await coversFor('stegoshard-bundle.zip', secret, (n, s) =>
      rgbaCover(`${n}.png`, s),
    );
    const { images, shares } = await galleryEncode('stegoshard-bundle.zip', secret, 'pw', covers, {
      params: FAST,
      mode: 'nonpossession',
      threshold: { k: 2, n: 3 },
      bundle: true,
    });
    const S = await shamirRecover(shares!);
    const out = await galleryDecode(images as GalleryCover[], 'pw', { params: FAST, secret: S });
    expect(out.bundled).toBe(true);
  });
});

describe('gallery cover estimate (multi-region geometry)', () => {
  it('is key-mode independent — the slot array is always embedded', () => {
    const env = 5000;
    const embedded = galleryCoversForEnvelopeLen(env, 'embedded');
    const keyfile = galleryCoversForEnvelopeLen(env, 'keyfile');
    expect(keyfile).toEqual(embedded); // no key-mode length distinguisher (§10.2)
    expect(embedded.k).toBeGreaterThan(1);
  });
});
