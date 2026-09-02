/**
 * The error-code registry is a published contract: the CLI's `--json` envelope,
 * the MCP tool results and the library all key on these codes. So the tests here
 * guard the properties a caller relies on, not the table's contents:
 *
 *  - exhaustiveness, discovered from the barrel rather than restated, so a new
 *    core error class fails CI instead of silently becoming uncodeable;
 *  - the name literal each constructor assigns really matches its row, which is
 *    what makes the Worker-boundary fallback work;
 *  - the two no-oracle invariants (one gallery code, no mode-specific code).
 */

import { describe, it, expect } from 'vitest';
import * as core from './index';
import { STEGO_ERROR_CODES, stegoErrorCode, stegoErrorDetails } from './errors';
import {
  BucketTooLargeError,
  CredentialsNotIndependentError,
  FileTooLargeError,
  GalleryCoverCapacityError,
  GalleryFileTooLargeError,
  GalleryRestoreError,
  GalleryTooFewImagesError,
  GalleryTooManyImagesError,
  JpegUnsupportedError,
  MissingKeyError,
  SegmentedFormatError,
  ShareChecksumError,
  ShareSetError,
  StegoCapacityError,
  StegoCoverFormatError,
  TooManyFilesError,
  TooManyImagesError,
  VerificationError,
  WrongPasswordError,
} from './index';

/** One live instance of every core error class, with plausible arguments. */
const INSTANCES: readonly Error[] = [
  new BucketTooLargeError(5000, 4096),
  new CredentialsNotIndependentError('equal'),
  new FileTooLargeError(2_000_000, 1_048_576),
  new GalleryCoverCapacityError('IMG_2043.jpg', 120, 800),
  new GalleryFileTooLargeError(70_000, 65_536),
  new GalleryRestoreError(),
  new GalleryTooFewImagesError(3, 5),
  new GalleryTooManyImagesError(300, 256),
  new JpegUnsupportedError('progressive scan'),
  new MissingKeyError(),
  new SegmentedFormatError('truncated chunk'),
  new ShareChecksumError(),
  new ShareSetError('duplicate share index'),
  new StegoCapacityError(1024),
  new StegoCoverFormatError(),
  new TooManyFilesError(900, 256),
  new TooManyImagesError(400, 150),
  new VerificationError(),
  new WrongPasswordError(),
];

/**
 * Every Error subclass the barrel exports. Discovered, not listed: this is the
 * check that makes adding a class without a code impossible to miss.
 */
function exportedErrorClasses(): { name: string; ctor: new (...args: never[]) => Error }[] {
  const out: { name: string; ctor: new (...args: never[]) => Error }[] = [];
  for (const [name, value] of Object.entries(core)) {
    if (typeof value !== 'function') continue;
    if (value === Error) continue;
    if (!(value.prototype instanceof Error)) continue;
    out.push({ name, ctor: value as new (...args: never[]) => Error });
  }
  return out;
}

describe('error code registry', () => {
  it('covers every Error subclass the core barrel exports', () => {
    const exported = exportedErrorClasses().map((e) => e.name);
    // Sanity: discovery works at all, so a broken filter cannot vacuously pass.
    expect(exported.length).toBeGreaterThan(15);
    const uncovered = exported.filter(
      (name) => !INSTANCES.some((err) => err.constructor.name === name || err.name === name),
    );
    expect(uncovered).toEqual([]);
  });

  it('assigns a code to every instance', () => {
    for (const err of INSTANCES) {
      expect(stegoErrorCode(err), err.name).not.toBeNull();
    }
  });

  it('assigns a distinct code to each class', () => {
    const codes = INSTANCES.map((err) => stegoErrorCode(err));
    expect(new Set(codes).size).toBe(INSTANCES.length);
  });

  it('STEGO_ERROR_CODES lists exactly the codes in use, sorted', () => {
    const used = INSTANCES.map((err) => stegoErrorCode(err)!).sort();
    expect([...STEGO_ERROR_CODES]).toEqual(used);
  });

  // The `name` literal is what classifies an error that crossed a Worker
  // boundary, where run-in-worker.ts rebuilds only some classes for real.
  it('classifies a name-only error the way it classifies the real class', () => {
    for (const err of INSTANCES) {
      const plain = Object.assign(new Error(err.message), { name: err.name });
      expect(stegoErrorCode(plain), err.name).toBe(stegoErrorCode(err));
    }
  });

  // No core error subclasses another, so the instanceof scan needs no ordering.
  it('no core error class subclasses another', () => {
    for (const a of INSTANCES) {
      for (const b of INSTANCES) {
        if (a === b) continue;
        expect(a instanceof (b.constructor as new () => Error), `${a.name} vs ${b.name}`).toBe(
          false,
        );
      }
    }
  });

  it('returns null for anything it does not classify', () => {
    expect(stegoErrorCode(new Error('boom'))).toBeNull();
    expect(stegoErrorCode(new TypeError('nope'))).toBeNull();
    expect(stegoErrorCode('a string')).toBeNull();
    expect(stegoErrorCode(null)).toBeNull();
    expect(stegoErrorCode(undefined)).toBeNull();
    expect(stegoErrorCode({ name: 'WrongPasswordError' })).toBeNull();
  });
});

describe('error details', () => {
  it('surfaces only values already present in the message', () => {
    for (const err of INSTANCES) {
      const details = stegoErrorDetails(err);
      if (!details) continue;
      for (const value of Object.values(details)) {
        expect(err.message, `${err.name} / ${value}`).toContain(String(value));
      }
    }
  });

  it('carries the numbers a caller would otherwise have to parse', () => {
    expect(stegoErrorDetails(new FileTooLargeError(2_000_000, 1_048_576))).toEqual({
      size: 2_000_000,
      limit: 1_048_576,
    });
    expect(stegoErrorDetails(new GalleryCoverCapacityError('a.jpg', 120, 800))).toEqual({
      coverName: 'a.jpg',
      capacityBits: 120,
      neededBits: 800,
    });
    expect(stegoErrorDetails(new CredentialsNotIndependentError('equal'))).toEqual({
      reason: 'equal',
    });
  });

  it('is undefined when there is nothing to report', () => {
    expect(stegoErrorDetails(new WrongPasswordError())).toBeUndefined();
    expect(stegoErrorDetails(new GalleryRestoreError())).toBeUndefined();
    expect(stegoErrorDetails(new Error('boom'))).toBeUndefined();
    expect(stegoErrorDetails('a string')).toBeUndefined();
  });

  // A Worker-reconstructed error arrives without the readonly fields; the
  // details must degrade to undefined rather than emit nulls or NaN.
  it('degrades when the fields are absent', () => {
    const plain = Object.assign(new Error('file too large'), { name: 'FileTooLargeError' });
    expect(stegoErrorCode(plain)).toBe('FILE_TOO_LARGE');
    expect(stegoErrorDetails(plain)).toBeUndefined();
  });
});

describe('no-oracle invariants', () => {
  // gallery.ts conflates "wrong password" with "no gallery here" on purpose.
  // Two codes would rebuild exactly the distinction the format removes.
  it('gallery restore has a single code, distinct from a wrong password', () => {
    const galleryCodes = STEGO_ERROR_CODES.filter((c) => c.startsWith('GALLERY_RESTORE'));
    expect(galleryCodes).toEqual(['GALLERY_RESTORE_FAILED']);
    expect(stegoErrorCode(new GalleryRestoreError())).toBe('GALLERY_RESTORE_FAILED');
  });

  // A code naming a mode, a region or a slot would defeat SPEC §10: unlocking a
  // duress or non-possession container must look like any other wrong password.
  it('no code names a mode, region, slot or credential', () => {
    for (const code of STEGO_ERROR_CODES) {
      expect(code, code).not.toMatch(/DURESS|DECOY|NONPOSSESSION|REGION|SLOT|REAL_|GATED/);
    }
  });

  it('a wrong password carries no details that could distinguish a region', () => {
    expect(stegoErrorDetails(new WrongPasswordError())).toBeUndefined();
    expect(new WrongPasswordError().message).toBe('wrong password');
  });
});
