/**
 * Filenames for the photos a deniable delivery hands over: the gallery photos
 * and every stego key photo.
 *
 * A photo used to keep its cover's own name, on the reasoning that an ordinary
 * name blends into a photo library. The name is not ordinary, though. It is the
 * device's: `PXL_20260921_143012.jpg` says Pixel and the second it was taken,
 * `20260921_143012.jpg` says Samsung and the same, and even `IMG_2043.jpg` says
 * which camera roll and roughly where in it. None of that belongs in a delivery
 * whose whole purpose is to say nothing.
 *
 * So every delivered photo is named `IMG_` and four digits drawn from the CSPRNG,
 * distinct within the delivery. `IMG_` is the most widespread camera convention
 * there is, which is what makes it say nothing in particular; the digits are drawn
 * independently rather than as a run, so they carry no order either. The
 * extension follows the bytes, never the source: a JPEG is `.jpg`, a raster is
 * `.png`, because restore picks the decoder by extension.
 *
 * Four digits are also short of the eight-hex-character run the deniable-name
 * tests refuse, which is what a set id or a date would look like.
 */

import { randomIntBelow } from './crypto';

/** How many distinct names the scheme has: `IMG_0000` to `IMG_9999`. */
export const PHOTO_NAME_SPACE = 10_000;

/** The file extension a delivered photo takes, from what its bytes are. */
export type PhotoExt = 'jpg' | 'png';

/**
 * One name per extension in `exts`, all distinct, none of them in `taken`.
 *
 * `taken` is what must not be reused: the names already in the output folder,
 * so a save never collides with a file that is already there, and never needs
 * the `-2` suffix that used to say two photos had shared a name. Throws when
 * the space cannot supply enough names, which takes a folder with thousands of
 * `IMG_` files in it.
 */
export function photoNames(
  exts: readonly PhotoExt[],
  taken: ReadonlySet<string> = new Set(),
): string[] {
  // A number is unusable if either spelling of it is taken: two files that differ
  // only by extension read as the same photo in two formats.
  const used = new Set<number>();
  for (const name of taken) {
    const m = /^IMG_(\d{4})\.[a-z]+$/i.exec(name);
    if (m) used.add(Number(m[1]));
  }
  if (used.size + exts.length > PHOTO_NAME_SPACE) {
    throw new RangeError(`no room for ${exts.length} more IMG_ names beside ${used.size} taken`);
  }
  return exts.map((ext) => {
    let n: number;
    do n = randomIntBelow(PHOTO_NAME_SPACE);
    while (used.has(n));
    used.add(n);
    return `IMG_${String(n).padStart(4, '0')}.${ext}`;
  });
}

/** The extension a photo's bytes call for: PNG by its signature, JPEG otherwise. */
export function photoExt(bytes: Uint8Array): PhotoExt {
  return bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' : 'jpg';
}
