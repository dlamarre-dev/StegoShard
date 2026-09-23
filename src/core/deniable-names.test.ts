/**
 * The names a deniable delivery gives its photos: `IMG_` and four drawn digits,
 * distinct, clear of whatever is already in the folder, and saying nothing about
 * the source.
 */

import { describe, expect, it } from 'vitest';
import { PHOTO_NAME_SPACE, photoExt, photoNames } from './deniable-names';

describe('photoNames', () => {
  it('draws IMG_nnnn names with the extension asked for', () => {
    const names = photoNames(['jpg', 'png', 'jpg']);
    expect(names[0]).toMatch(/^IMG_\d{4}\.jpg$/);
    expect(names[1]).toMatch(/^IMG_\d{4}\.png$/);
    expect(names[2]).toMatch(/^IMG_\d{4}\.jpg$/);
  });

  it('never repeats a number within one delivery, even across extensions', () => {
    const names = photoNames(Array.from({ length: 500 }, (_, i) => (i % 2 ? 'jpg' : 'png')));
    const numbers = names.map((n) => n.slice(4, 8));
    expect(new Set(numbers).size).toBe(500);
  });

  it('avoids a number already taken in the folder, whatever its extension or case', () => {
    // Everything but IMG_0042 is taken, so that is the only name it can draw.
    const taken = new Set<string>();
    for (let n = 0; n < PHOTO_NAME_SPACE; n++) {
      if (n !== 42) taken.add(`img_${String(n).padStart(4, '0')}.${n % 2 ? 'PNG' : 'jpeg'}`);
    }
    expect(photoNames(['jpg'], taken)).toEqual(['IMG_0042.jpg']);
    expect(() => photoNames(['jpg', 'jpg'], taken)).toThrow(RangeError);
  });

  it('is drawn, not sequential: a run of names is not a run of numbers', () => {
    const numbers = photoNames(Array.from({ length: 20 }, () => 'jpg')).map((n) =>
      Number(n.slice(4, 8)),
    );
    const consecutive = numbers.slice(1).filter((v, i) => v === numbers[i]! + 1).length;
    expect(consecutive).toBeLessThan(5);
  });

  // An 8-character hex run is what a set id or a date would look like, and the
  // deniable-name tests refuse it; four digits after `IMG_` cannot form one.
  it('can never contain an 8-character hex run', () => {
    for (const n of photoNames(Array.from({ length: 200 }, () => 'jpg'))) {
      expect(n).not.toMatch(/[0-9a-f]{8}/i);
    }
  });
});

describe('photoExt', () => {
  it('follows the bytes: PNG by signature, JPEG otherwise', () => {
    expect(photoExt(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('png');
    expect(photoExt(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('jpg');
  });
});
