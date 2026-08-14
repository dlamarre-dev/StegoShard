import { describe, it, expect } from 'vitest';
import { SQLITE_MAGIC, packSqlite, unpackSqlite } from './sqlite-container';

const PAGE_SIZE = 4096;

/** Sizes spanning inline-only, the local/overflow boundary, and multi-page chains. */
const SIZES = [1, 50, 4000, 4025, 4026, 4027, 5000, 8192, 50_000, 500_000];

describe('sqlite container pack/unpack', () => {
  for (const size of SIZES) {
    it(`round-trips a ${size}-byte blob through a valid database`, () => {
      const blob = Uint8Array.from({ length: size }, (_, i) => (i * 2654435761) & 0xff);
      const db = packSqlite(blob);

      // Real SQLite header and page size.
      expect([...db.slice(0, 16)]).toEqual([...SQLITE_MAGIC]);
      const dv = new DataView(db.buffer, db.byteOffset, db.byteLength);
      expect(dv.getUint16(16, false)).toBe(PAGE_SIZE);

      // Structurally exact: no unreferenced trailing bytes.
      const pageCount = dv.getUint32(28, false);
      expect(db.length).toBe(pageCount * PAGE_SIZE);
      // change counter (24) == version-valid-for (92), so SQLite trusts pageCount.
      expect(dv.getUint32(24, false)).toBe(dv.getUint32(92, false));

      const back = unpackSqlite(db);
      expect(back).not.toBeNull();
      expect([...back!]).toEqual([...blob]);
    });
  }

  it('returns null for bytes that are not one of our databases', () => {
    expect(unpackSqlite(Uint8Array.from([1, 2, 3]))).toBeNull(); // too short
    const notSqlite = new Uint8Array(PAGE_SIZE);
    expect(unpackSqlite(notSqlite)).toBeNull(); // no SQLite magic
  });
});

describe('sqlite container reader robustness (multi-row)', () => {
  it('spreads a large blob across several page_cache rows and still round-trips', () => {
    const blob = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 97) & 0xff);
    const db = packSqlite(blob);
    // Page 2 must be an interior b-tree root (0x05) once there are many rows.
    expect(db[PAGE_SIZE]).toBe(0x05);
    expect([...unpackSqlite(db)!]).toEqual([...blob]);
  });

  it('returns null when the root b-tree page type is neither interior nor leaf', () => {
    const db = packSqlite(Uint8Array.of(1, 2, 3, 4));
    db[PAGE_SIZE] = 0x99; // corrupt the cache root page type
    expect(unpackSqlite(db)).toBeNull();
  });
});

/**
 * Every rejection path in the reader, because the reader is the attack surface.
 *
 * `unpackSqlite` is handed a file the user was given: on restore it parses bytes
 * an adversary may have written. It has ten paths that return null; three were
 * covered before this block (short input, wrong magic, bad root page type), and
 * the branch coverage of this file sat at 71.91%, the lowest in `src/core`.
 *
 * Each case below corrupts one field of an otherwise valid container, so a
 * failure names the specific guard that stopped working rather than "something
 * about SQLite broke". The container is rebuilt per test: sharing one would let
 * an earlier mutation leak into a later expectation.
 */
describe('sqlite container reader: every rejection path', () => {
  const valid = (bytes = 300_000) =>
    packSqlite(Uint8Array.from({ length: bytes }, (_, i) => (i * 97) & 0xff));

  const dvOf = (db: Uint8Array) => new DataView(db.buffer, db.byteOffset, db.byteLength);

  it('rejects a declared page size that is not ours', () => {
    const db = valid(4000);
    dvOf(db).setUint16(16, 8192, false);
    expect(unpackSqlite(db)).toBeNull();
  });

  it('rejects a file shorter than its own declared page count', () => {
    const db = valid(50_000);
    // The header still claims every page; the bytes stop early. Truncation in
    // transit looks exactly like this.
    expect(unpackSqlite(db.subarray(0, db.length - PAGE_SIZE))).toBeNull();
  });

  /**
   * Every guard the reader has, reached by corruption rather than by hand.
   *
   * An earlier version of this block tried to locate the overflow pointer by
   * walking the page layout, and silently corrupted nothing: the probe never
   * matched, so the test asserted a rejection that the reader was never asked
   * for. Re-deriving the file format inside its own test is how that happens.
   *
   * This sweeps single-byte corruptions across the whole container instead, and
   * asserts the structural invariant: **an accepted result is always the stored
   * length.** Never shorter, never longer.
   *
   * Length, not content, is the right property here, and the first version of
   * this test got it wrong. Flipping a byte inside a row's value changes the
   * blob, and that is correct: the container is a disguise, not an
   * authentication layer, and the changed bytes are ciphertext whose GCM tag
   * fails one layer up. What the tag cannot catch is misassembly that still
   * produces a plausible length, because the failure would then look like a
   * wrong password rather than a damaged file.
   */
  it('never returns a blob of the wrong length under single-byte corruption', () => {
    const source = Uint8Array.from({ length: 40_000 }, (_, i) => (i * 97) & 0xff);
    const db = packSqlite(source);

    let rejected = 0;
    let intact = 0;
    let altered = 0;
    // Stride rather than every byte: 4096 samples over the whole file, which
    // lands in the header, the interior root, leaf cells and overflow chains.
    const stride = Math.max(1, Math.floor(db.length / 4096));
    for (let i = 0; i < db.length; i += stride) {
      const bad = db.slice();
      bad[i] = (bad[i]! ^ 0xff) & 0xff;
      const out = unpackSqlite(bad);
      if (out === null) {
        rejected++;
        continue;
      }
      expect(out.length, `byte ${i} reassembled to ${out.length} bytes`).toBe(source.length);
      if (out.every((v, j) => v === source[j])) intact++;
      else altered++;
    }
    // All three outcomes must occur, or the sweep proves nothing. All-rejected
    // would mean the corruption is too coarse to reach the reader; all-intact
    // would mean no byte that matters was ever touched; no alterations at all
    // would mean the payload region was never hit.
    expect(rejected).toBeGreaterThan(0);
    expect(intact).toBeGreaterThan(0);
    expect(altered).toBeGreaterThan(0);
    // Printed on stderr rather than console.log: the repo forbids console.log in
    // source, and the counts matter. A sweep that silently drifted to all-rejected
    // would still pass its assertions while covering far less than it appears to.
    process.stderr.write(
      `  sqlite corruption sweep: ${rejected} rejected, ${intact} exact, ` +
        `${altered} altered-but-correct-length\n`,
    );
  });

  it('skips a cell whose offset points past the end of its page', () => {
    const db = valid(4000);
    const pageCount = dvOf(db).getUint32(28, false);
    for (let n = 2; n <= pageCount; n++) {
      const page = db.subarray((n - 1) * PAGE_SIZE, n * PAGE_SIZE);
      if (page[0] !== 0x0d) continue;
      page[8] = 0xff; // cell offset near the very end of the page
      page[9] = 0xf0;
      break;
    }
    // Either the row is dropped and nothing is left (null), or the remaining
    // rows no longer reassemble the blob. What must not happen is a silent
    // partial success, so any non-null answer must still be a complete blob.
    const out = unpackSqlite(db);
    if (out !== null) expect(out.length).toBe(4000);
  });

  it('returns null rather than an empty blob when no vault rows survive', () => {
    const db = valid(4000);
    const pageCount = dvOf(db).getUint32(28, false);
    // Blank every leaf page: the decoy rows go too, so nothing matches the vault
    // key prefix and `parts` is empty. unpackSqlite:415 promises null here, and a
    // caller that trusted a zero-length success would decrypt nothing.
    for (let n = 3; n <= pageCount; n++) {
      db.fill(0, (n - 1) * PAGE_SIZE, n * PAGE_SIZE);
    }
    expect(unpackSqlite(db)).toBeNull();
  });

  it('never returns a zero-length blob', () => {
    // The contract the fuzzer now asserts on every accepted input, pinned here
    // as a unit test so it holds even when the fuzzer is not run.
    for (const size of [1, 4000, 50_000]) {
      const out = unpackSqlite(valid(size));
      expect(out).not.toBeNull();
      expect(out!.length).toBeGreaterThan(0);
    }
  });

  it('round-trips an empty blob or refuses it, but does not lose data silently', () => {
    // packSqlite(∅) produces one zero-length chunk; unpackSqlite:417 then returns
    // null because the reassembled blob is empty. That asymmetry is fine as long
    // as it is explicit: what would not be fine is returning a different blob.
    const db = packSqlite(new Uint8Array(0));
    expect(unpackSqlite(db)).toBeNull();
  });
});
