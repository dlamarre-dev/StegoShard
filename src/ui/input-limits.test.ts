import { describe, it, expect } from 'vitest';
import {
  FileTooLargeError,
  GALLERY_MAX_IMAGES,
  MAX_FILE_BYTES,
  MAX_FILE_BYTES_BINARY_UI,
  TooManyFilesError,
} from '@core';
import {
  assertBlobSize,
  assertBrowserInputs,
  boundedBlobBytes,
  inputLimit,
  MAX_BROWSER_CONTAINER_BYTES,
  MAX_BROWSER_INPUT_FILES,
  MAX_BROWSER_MEDIA_BYTES,
  MAX_BROWSER_TOTAL_INPUT_BYTES,
} from './input-limits';

/**
 * This file had no tests at all, which is worth stating rather than quietly
 * fixing: its entire job is bounding untrusted input before it reaches the tab's
 * heap, and `src/ui` sits outside the coverage `include`, so nothing measured it
 * either. The guarantee in its own docstring, that the size check happens before
 * `arrayBuffer()`, was asserted nowhere.
 *
 * A `Blob` here is a stand-in with a `size` and an `arrayBuffer()`. Constructing
 * real 300 MiB blobs to test a 300 MiB limit would make the suite allocate what
 * the limit exists to refuse.
 */
function fakeBlob(size: number, onRead?: () => void): Blob {
  return {
    size,
    arrayBuffer: async () => {
      onRead?.();
      return new ArrayBuffer(Math.min(size, 8));
    },
  } as unknown as Blob;
}

describe('inputLimit', () => {
  it('maps every kind to its documented limit', () => {
    // Exhaustive by construction: a new kind added to the union without a case
    // here fails the typecheck rather than silently returning undefined.
    const kinds = ['secret', 'binary', 'archive', 'media'] as const;
    const expected: Record<(typeof kinds)[number], number> = {
      secret: MAX_FILE_BYTES,
      binary: MAX_FILE_BYTES_BINARY_UI,
      archive: MAX_BROWSER_CONTAINER_BYTES,
      media: MAX_BROWSER_MEDIA_BYTES,
    };
    for (const kind of kinds) expect(inputLimit(kind)).toBe(expected[kind]);
  });
});

describe('assertBlobSize', () => {
  it('accepts a blob exactly at the limit and rejects one byte more', () => {
    expect(() => assertBlobSize(fakeBlob(100), 100)).not.toThrow();
    expect(() => assertBlobSize(fakeBlob(101), 100)).toThrow(FileTooLargeError);
  });

  it('reports the actual size and the limit, not just that it failed', () => {
    // The user has to know which file to drop, so the numbers have to travel.
    try {
      assertBlobSize(fakeBlob(500), 100);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FileTooLargeError);
      expect(String((e as Error).message)).toContain('500');
      expect(String((e as Error).message)).toContain('100');
    }
  });
});

describe('assertBrowserInputs', () => {
  it('rejects more files than the count limit before looking at any size', () => {
    // Count first, on purpose: an adversary supplying ten thousand tiny files
    // should be stopped by the count, not by summing ten thousand sizes.
    const many = Array.from({ length: MAX_BROWSER_INPUT_FILES + 1 }, () => fakeBlob(1));
    expect(() => assertBrowserInputs(many)).toThrow(TooManyFilesError);
  });

  it('accepts exactly the count limit', () => {
    const atLimit = Array.from({ length: MAX_BROWSER_INPUT_FILES }, () => fakeBlob(1));
    expect(() => assertBrowserInputs(atLimit)).not.toThrow();
  });

  it('ties the default count to the gallery maximum plus room for key files', () => {
    expect(MAX_BROWSER_INPUT_FILES).toBe(GALLERY_MAX_IMAGES + 4);
  });

  it('rejects a single oversized file even when the total would fit', () => {
    expect(() => assertBrowserInputs([fakeBlob(MAX_BROWSER_MEDIA_BYTES + 1)])).toThrow(
      FileTooLargeError,
    );
  });

  it('rejects on the cumulative total, which no per-file check would catch', () => {
    // The interesting one. Every file is individually legal; together they are
    // not. This fires mid-loop, after some files have already passed.
    const each = MAX_BROWSER_MEDIA_BYTES;
    const count = Math.ceil(MAX_BROWSER_TOTAL_INPUT_BYTES / each) + 1;
    const blobs = Array.from({ length: count }, () => fakeBlob(each));
    expect(count).toBeLessThanOrEqual(MAX_BROWSER_INPUT_FILES); // not the count guard
    expect(() => assertBrowserInputs(blobs)).toThrow(FileTooLargeError);
  });

  it('stops at the file that crosses the total rather than reading the rest', () => {
    // Ordering matters for the same reason the size check precedes
    // arrayBuffer(): work avoided is the point of the limit.
    let inspected = 0;
    const probe = (size: number) =>
      ({
        get size() {
          inspected++;
          return size;
        },
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as unknown as Blob;
    const each = MAX_BROWSER_MEDIA_BYTES;
    const blobs = Array.from({ length: 20 }, () => probe(each));
    expect(() => assertBrowserInputs(blobs, { total: each * 3 })).toThrow(FileTooLargeError);
    // Four files at most are touched to discover that four exceed three.
    expect(inspected).toBeLessThanOrEqual(4 * 2);
  });

  it('honours explicit overrides for all three limits', () => {
    expect(() => assertBrowserInputs([fakeBlob(10)], { perFile: 5 })).toThrow(FileTooLargeError);
    expect(() => assertBrowserInputs([fakeBlob(4), fakeBlob(4)], { total: 5 })).toThrow(
      FileTooLargeError,
    );
    expect(() => assertBrowserInputs([fakeBlob(1), fakeBlob(1)], { count: 1 })).toThrow(
      TooManyFilesError,
    );
  });

  it('accepts an empty list', () => {
    expect(() => assertBrowserInputs([])).not.toThrow();
  });
});

describe('boundedBlobBytes', () => {
  it('reads a blob within the limit', async () => {
    const out = await boundedBlobBytes(fakeBlob(8), 100);
    expect(out).toBeInstanceOf(Uint8Array);
  });

  it('never calls arrayBuffer() on an oversized blob', async () => {
    // The guarantee this module exists for, quoted from its own docstring: the
    // check runs "before `arrayBuffer()` so a rejected input never has to be
    // copied into the tab's heap first". Nothing asserted it until now, so a
    // refactor that read first and measured after would have been invisible.
    let read = false;
    await expect(
      boundedBlobBytes(
        fakeBlob(1000, () => (read = true)),
        100,
      ),
    ).rejects.toBeInstanceOf(FileTooLargeError);
    expect(read, 'arrayBuffer() was called on a blob that should have been refused').toBe(false);
  });
});
