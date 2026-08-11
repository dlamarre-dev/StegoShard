/**
 * Output-count estimates. The counts drive what the user sees before committing
 * to a save, so they have to track the codec and key mode they actually picked,
 * a number that never moves is worse than no number at all.
 */

import { describe, it, expect } from 'vitest';
import { MAX_IMAGES } from '@core';
import { estimateFor, estimatesFrom, firstCodecThatFits, formatSize } from './estimate';
import type { Msg } from './save-controller';

const msg: Msg = (key, subs) => `${key}:${Array.isArray(subs) ? subs.join(',') : (subs ?? '')}`;

/** A 40 KB secret, roughly, expressed as an envelope length. */
const ENVELOPE = 40_000;

describe('estimates', () => {
  it('reports a count per codec for the image destinations', () => {
    for (const dest of ['disk'] as const) {
      const e = estimateFor(dest, ENVELOPE, ENVELOPE, msg);
      expect(e.available).toBe(true);
      expect(e.counts?.color, `${dest} color`).toBeGreaterThan(0);
      expect(e.counts?.qr, `${dest} qr`).toBeGreaterThan(0);
      // The whole reason for offering the choice.
      expect(e.counts!.color!, `${dest}`).toBeLessThan(e.counts!.qr!);
    }
  });

  it('follows the selected codec in the headline count', () => {
    const color = estimateFor('disk', ENVELOPE, ENVELOPE, msg, { codec: 'color' });
    const qr = estimateFor('disk', ENVELOPE, ENVELOPE, msg, { codec: 'qr' });
    expect(color.count).toBe(color.counts!.color);
    expect(qr.count).toBe(qr.counts!.qr);
    expect(color.count).toBeLessThan(qr.count);
  });

  it('offers no codec choice for paper, which always renders QR', () => {
    const e = estimateFor('paper', ENVELOPE, ENVELOPE, msg, { codec: 'color' });
    expect(e.counts).toBeUndefined();
    // Asking for colour must not change a paper estimate.
    expect(e.count).toBe(estimateFor('paper', ENVELOPE, ENVELOPE, msg, { codec: 'qr' }).count);
  });

  it('reacts to key mode, which used to be pinned to embedded', () => {
    const embedded = estimateFor('disk', ENVELOPE, ENVELOPE, msg, { keyMode: 'embedded' });
    const keyfile = estimateFor('disk', ENVELOPE, ENVELOPE, msg, { keyMode: 'keyfile' });
    // An embedded key block rides inside the vault blob, so it can only ever
    // need at least as many images as the keyfile mode.
    expect(embedded.count).toBeGreaterThanOrEqual(keyfile.count);
  });

  it('reports one file for the binary destinations, with no codec choice', () => {
    for (const dest of ['binary', 'sqlite'] as const) {
      const e = estimateFor(dest, ENVELOPE, ENVELOPE, msg);
      expect(e).toMatchObject({ available: true, count: 1 });
      expect(e.counts).toBeUndefined();
    }
  });

  // A 400 KB secret needs 62 colour images but over 150 QR images, so the codec
  // choice alone decides whether the disk destination is usable.
  const TIPPING = 400_000;

  it('keeps a destination available when one codec still fits', () => {
    const e = estimateFor('disk', TIPPING, TIPPING, msg, { codec: 'qr' });
    // The destination stays open; it is the *codec* that does not fit, and
    // moving the user's destination because they toggled a codec is worse than
    // greying out the codec they toggled to.
    expect(e.available).toBe(true);
    expect(e.codecFits).toEqual({ color: true, qr: false });
  });

  it('still reports both counts when a codec does not fit', () => {
    // The count next to the *other* codec is exactly what tells the user how to
    // fix it, so dropping `counts` here left them with no way to see the way out.
    const e = estimateFor('disk', TIPPING, TIPPING, msg, { codec: 'qr' });
    expect(e.counts?.color).toBeGreaterThan(0);
    expect(e.counts?.qr).toBeGreaterThan(150);
  });

  it('snaps off a codec that does not fit, and leaves a fitting one alone', () => {
    const tight = estimateFor('disk', TIPPING, TIPPING, msg, { codec: 'qr' });
    expect(firstCodecThatFits(tight, 'qr')).toBe('color');
    expect(firstCodecThatFits(tight, 'color')).toBe('color');
    // Where both fit, the user's choice is untouched.
    const roomy = estimateFor('disk', 50_000, 50_000, msg, {});
    expect(firstCodecThatFits(roomy, 'qr')).toBe('qr');
    // Paper offers no choice, so there is nothing to snap.
    expect(firstCodecThatFits(estimateFor('paper', 5_000, 5_000, msg, {}), 'qr')).toBe('qr');
  });

  it('marks a destination unavailable only when no codec fits', () => {
    // Far past MAX_IMAGES at any codec.
    const huge = 900_000;
    const e = estimateFor('paper', huge, huge, msg);
    expect(e.available).toBe(false);
    expect(e.reason).toBe(`wizTooManyImages:${MAX_IMAGES}`);

    const disk = estimateFor('disk', 1_048_000, 1_048_000, msg, {});
    expect(disk.codecFits).toEqual({ color: false, qr: false });
    expect(disk.available).toBe(false);
  });

  // A photo carrier pads two regions into one bucket, so its ceiling is the top
  // rung of GALLERY_LADDER (64 KiB), far below the 1 MB image cap. The arithmetic
  // for the shard split *throws* past that rung, and the estimate pass used to
  // let it escape: the whole update was abandoned, so the expert form kept the
  // previous file's size on screen and the wizard concluded that nothing at all
  // could hold the file. Every destination here is reachable for a 229 KB secret.
  const PAST_GALLERY = 229 * 1024;

  it('reports the gallery as full instead of throwing past its bucket ladder', () => {
    const e = estimateFor('gallery', PAST_GALLERY, PAST_GALLERY, msg);
    expect(e.available).toBe(false);
    expect(e.reason).toBe('wizTooLargeGallery:64');
  });

  it('leaves the other destinations usable for a secret the gallery cannot take', () => {
    const all = estimatesFrom(
      PAST_GALLERY,
      PAST_GALLERY,
      ['disk', 'binary', 'sqlite', 'gallery'],
      msg,
      { codec: 'color' },
    );
    expect(all.gallery!.available).toBe(false);
    for (const dest of ['disk', 'binary', 'sqlite'] as const) {
      expect(all[dest]!.available, dest).toBe(true);
    }
  });

  it('caps the decoy .db at its own ladder, not the browser input limit', () => {
    // The .db writer pads two regions to a shared bucket topping out at 64 MiB;
    // a 100 MiB envelope is under the 256 MiB input cap and used to be offered,
    // then failed at the very end of the save.
    const past = 100 * 1024 * 1024;
    expect(estimateFor('sqlite', past, past, msg).available).toBe(false);
    // The branded .ssbn has no ladder, so it still takes it.
    expect(estimateFor('binary', past, past, msg).available).toBe(true);
  });

  it('estimatesFrom covers every requested destination', () => {
    const all = estimatesFrom(ENVELOPE, ENVELOPE, ['disk', 'paper', 'binary'], msg, {
      codec: 'color',
    });
    expect(Object.keys(all).sort()).toEqual(['binary', 'disk', 'paper']);
    expect(all.disk!.counts?.color).toBeDefined();
    expect(all.paper!.counts).toBeUndefined();
  });

  it('formats sizes for the size line', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
