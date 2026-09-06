/**
 * A present-but-wrong shard must not turn a recoverable set fatal.
 *
 * `reassembleBlob`'s comment states the property: reconstruction is "tolerant of
 * up to m missing shards, retrying alternative k-subsets so one present-but-wrong
 * shard can't turn a recoverable set fatal, gated by the integrity hash".
 *
 * Missing shards were tested. A shard that is *present and wrong* was not, and
 * that is the harder half: a missing shard is excluded by construction, while a
 * wrong one has to be found and worked around. `reconstructVerified` carried 19
 * survivors, the largest cluster left in vault.ts, essentially all of them in the
 * retry loop and the hash gate that decides when a subset is good.
 *
 * The distinction matters in practice. A cloud host that silently re-encodes one
 * image, or a single bad sector, gives you every shard back with one of them
 * quietly altered. Without the retry the first k-subset drawn includes the bad
 * shard, decodes to a wrong blob, and the whole vault reads as unrecoverable
 * while the data needed to restore it is sitting right there.
 *
 * One mutant in this function survives on purpose: the `present.length < k`
 * early return is redundant with `kSubsets`, which yields nothing when k exceeds
 * the item count, so the function returns null either way. Defensive code
 * guarding a property the surrounding design already provides, reasonable to
 * keep and impossible to cover.
 *
 * A SECOND ONE WAS CLAIMED HERE AND WAS WRONG, which is worth leaving on the
 * record. This comment used to say the `catch` that skips a failed subset was
 * "unreachable by construction", reasoning that the erasure code uses a
 * systematic Cauchy matrix, which is MDS, so every k-subset of columns is
 * invertible and no subset can be singular.
 *
 * The reasoning about matrices is correct. The conclusion is not, because a
 * singular matrix is not the only way `decodeBlob` can throw: `rsReconstructData`
 * rejects shards of unequal length first, before any matrix exists. A set
 * carrying one shard of the wrong length reaches reconstruction, throws on every
 * subset containing it, and is recovered from the subsets that exclude it. That
 * is the test below, and it restores byte for byte.
 *
 * The lesson is not about Cauchy matrices. A claim that a branch cannot be
 * reached is a claim about *every* path into it, and this one enumerated the
 * interesting path while missing the boring one, then told the next reader not to
 * bother looking. Prefer a failing experiment to a convincing argument.
 */

import { describe, it, expect } from 'vitest';
import { type Argon2Params, createKeyBlock, serializeKeyBlock } from './crypto';
import { decodeImagePayload, encodeImagePayload } from './header';
import { type VaultKey, exportVault, importVault, kSubsets } from './vault';

const FAST: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const NAME = 'secret.txt';

/** Incompressible, so the vault genuinely spans several shards. */
function noise(n: number): Uint8Array {
  const a = new Uint8Array(n);
  let s = 4242;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    a[i] = (s >>> 24) & 0xff;
  }
  return a;
}

const CONTENT = noise(20 * 1024);

async function makeKey(): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock('pw', FAST);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

/** Alter a payload's shard bytes while leaving its header readable. */
function corruptShard(payload: Uint8Array): Uint8Array {
  const c = payload.slice();
  c[c.length - 1] = c[c.length - 1]! ^ 0xff;
  return c;
}

describe('reconstruction works around a present-but-wrong shard', () => {
  it('restores the file when one shard is silently altered', async () => {
    // The header still parses, so this payload is not dropped as foreign: it
    // reaches reconstruction and lies. Only the retry over other k-subsets, and
    // the hash that tells a good subset from a bad one, recover from that.
    const key = await makeKey();
    const { imagePayloads, k, m } = await exportVault(NAME, CONTENT, key);
    expect(k).toBeGreaterThan(1);
    expect(m).toBeGreaterThan(0);

    const damaged = imagePayloads.map((p, i) => (i === 0 ? corruptShard(p) : p));
    const out = await importVault(damaged, 'pw', { keyBlock: key.keyBlock });

    expect(out.filename).toBe(NAME);
    expect([...out.content]).toEqual([...CONTENT]);
  });

  it('restores when the altered shard is a parity shard rather than a data one', async () => {
    // Parity and data shards are interchangeable to the decoder, but they are
    // not to a test that only ever damages index 0. Damaging the last shard
    // exercises the loop reaching a subset that excludes a different position.
    const key = await makeKey();
    const { imagePayloads } = await exportVault(NAME, CONTENT, key);

    const damaged = imagePayloads.map((p, i) =>
      i === imagePayloads.length - 1 ? corruptShard(p) : p,
    );
    const out = await importVault(damaged, 'pw', { keyBlock: key.keyBlock });
    expect([...out.content]).toEqual([...CONTENT]);
  });

  it('restores with one shard altered and another missing at the same time', async () => {
    // Tolerance is stated in terms of m. With m parity shards, losing one and
    // corrupting another still leaves a good k-subset, and finding it is the
    // whole job of the retry. This is the case a simple "drop the bad ones"
    // implementation gets wrong, because nothing marks the bad one.
    const key = await makeKey();
    const { imagePayloads, m } = await exportVault(NAME, CONTENT, key);
    expect(m).toBeGreaterThanOrEqual(2);

    const damaged = imagePayloads.slice(0, -1).map((p, i) => (i === 1 ? corruptShard(p) : p));
    const out = await importVault(damaged, 'pw', { keyBlock: key.keyBlock });
    expect([...out.content]).toEqual([...CONTENT]);
  });
});

describe('the integrity hash is what makes the retry safe', () => {
  it('refuses rather than returning a plausible wrong blob when every subset is bad', async () => {
    // The gate on the far side of the loop. Corrupt enough shards that no
    // k-subset reconstructs the original, and reconstruction must report failure
    // instead of handing back whichever blob some subset happened to produce.
    // A retry loop without the hash check would return the first thing that
    // decoded without throwing.
    const key = await makeKey();
    const { imagePayloads } = await exportVault(NAME, CONTENT, key);

    const allDamaged = imagePayloads.map(corruptShard);
    await expect(importVault(allDamaged, 'pw', { keyBlock: key.keyBlock })).rejects.toThrow();
  });

  it('refuses when fewer than k shards are present', async () => {
    // Distinct from "every subset is bad": here there are not enough shards to
    // form a subset at all.
    //
    // This does not kill the `present.length < k` guard above the loop, and it
    // cannot: `kSubsets` yields nothing when k exceeds the number of items, so
    // the loop body never runs and the function returns null regardless. The
    // guard is redundant with the generator it precedes. Measured, not assumed:
    // replacing it with `present.length < 0` survives this test and every other
    // one in the suite. The behaviour is still worth pinning, so long as nobody
    // reads a passing test here as evidence that the guard is load-bearing.
    const key = await makeKey();
    const { imagePayloads, k } = await exportVault(NAME, CONTENT, key);

    const tooFew = imagePayloads.slice(0, k - 1);
    await expect(importVault(tooFew, 'pw', { keyBlock: key.keyBlock })).rejects.toThrow();
  });

  it('restores from exactly k shards, the minimum the erasure code promises', async () => {
    // The boundary on the passing side: k shards and not one more is exactly
    // what Reed-Solomon guarantees is enough.
    const key = await makeKey();
    const { imagePayloads, k } = await exportVault(NAME, CONTENT, key);

    const exactlyK = imagePayloads.slice(0, k);
    const out = await importVault(exactlyK, 'pw', { keyBlock: key.keyBlock });
    expect([...out.content]).toEqual([...CONTENT]);
  });
});

/**
 * The other retry, the one that fires when a subset does not decode at all.
 *
 * Everything above exercises the retry driven by the integrity hash: the subset
 * decodes, produces a blob, and the hash says it is the wrong blob. This is the
 * sibling path, where `decodeBlob` throws and the loop moves on without ever
 * getting a blob to hash. Nothing reached it, which is why the mutation run
 * reported the `catch` as having no coverage at all.
 *
 * A shard of the wrong length is the realistic way in. Nothing between the image
 * header and reconstruction requires the shards of a set to agree on length, so
 * one payload declaring a different `shardLen` travels all the way down and makes
 * `rsReconstructData` refuse every subset it appears in.
 */
describe('reconstruction works around a shard that cannot be decoded at all', () => {
  /**
   * A payload that belongs to the set but carries a shard of the wrong length.
   * Everything reassembly reads from a header (`setId`, `k`, `m`, `blobLen`,
   * `hash`) is preserved, so it is not dropped as foreign and not treated as a
   * different vault: it is a member, and it is undecodable.
   */
  function oddLengthShard(payload: Uint8Array): Uint8Array {
    const { header } = decodeImagePayload(payload);
    const shardLen = header.shardLen + 8;
    return encodeImagePayload({ ...header, shardLen }, noise(shardLen));
  }

  it('restores byte for byte when one shard has the wrong length', async () => {
    const key = await makeKey();
    const { imagePayloads } = await exportVault(NAME, CONTENT, key);
    expect(imagePayloads.length).toBeGreaterThan(1);

    // Index 0 on purpose. `kSubsets` yields the lowest indices first, so the very
    // first subset attempted contains the bad shard: the throw happens before any
    // successful decode, which is what puts the loop through the catch.
    const mixed = [...imagePayloads];
    mixed[0] = oddLengthShard(imagePayloads[0]!);

    const out = await importVault(mixed, 'pw', { keyBlock: key.keyBlock });
    expect(out.filename).toBe(NAME);
    expect([...out.content]).toEqual([...CONTENT]);
  });

  /**
   * The other half, and the reason the test above is about the retry rather than
   * about luck: take away the spare shards and the same bad set stops being
   * recoverable. If reconstruction had simply ignored the odd shard, this would
   * still succeed.
   */
  it('fails when there is no spare shard to retry with', async () => {
    const key = await makeKey();
    const { imagePayloads } = await exportVault(NAME, CONTENT, key);
    const { header } = decodeImagePayload(imagePayloads[0]!);

    const exactlyK = imagePayloads.slice(0, header.k);
    exactlyK[0] = oddLengthShard(imagePayloads[0]!);

    await expect(importVault(exactlyK, 'pw', { keyBlock: key.keyBlock })).rejects.toThrow(
      /integrity check/,
    );
  });
});

/**
 * The combination generator itself, which decides what reconstruction ever tries.
 *
 * Eight of the surviving mutants in this file's subject sat in these twelve
 * lines, and the reason is worth stating: every test above reaches the generator
 * through a real vault, so it only ever demands the handful of combinations that
 * one fixture happens to need. A generator that skipped some subsets, or emitted
 * a malformed one, would keep every test above green and would show up in
 * production as a vault that failed to restore when it should have.
 *
 * So the contract is asserted directly: every subset, exactly once, in order.
 */
describe('the k-subset generator enumerates completely and in order', () => {
  const choose = (n: number, k: number): number => {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return Math.round(r);
  };

  // Small enough to enumerate exhaustively, wide enough that the odometer has to
  // carry across several positions.
  const shapes: [number, number][] = [
    [1, 1],
    [4, 1],
    [4, 2],
    [5, 3],
    [7, 4],
    [8, 8],
    [9, 5],
  ];

  it.each(shapes)('yields every %i-choose-%i combination exactly once, ascending', (n, k) => {
    const items = Array.from({ length: n }, (_, i) => i * 10); // not 0..n-1, so a
    // generator returning indices instead of items would fail too.
    const out = [...kSubsets(items, k)];

    expect(out).toHaveLength(choose(n, k));
    expect(new Set(out.map((s) => s.join(','))).size).toBe(out.length); // no repeats

    for (const s of out) {
      expect(s).toHaveLength(k);
      expect(s.every((v) => items.includes(v))).toBe(true);
      // Strictly ascending: a carry that failed to reset the trailing positions
      // produces a subset that is not.
      expect([...s].sort((a, b) => a - b)).toEqual(s);
      expect(new Set(s).size).toBe(k);
    }

    // The first yield is the first k items, which is what makes reconstruction
    // try the lowest-indexed shards before reaching for parity.
    expect(out[0]).toEqual(items.slice(0, k));
    // And the last is the final k, so the enumeration ran to the end rather than
    // stopping early or running past it.
    expect(out.at(-1)).toEqual(items.slice(n - k));
  });

  // Both refusals matter: `k > n` is the case reconstruction relies on when
  // fewer than k shards survive, and it is what makes the `present.length < k`
  // guard above the loop redundant rather than load-bearing.
  it.each([
    [3, 4],
    [0, 1],
    [3, 0],
    [3, -1],
  ])('yields nothing for %i items taken %i at a time', (n, k) => {
    expect([
      ...kSubsets(
        Array.from({ length: n }, (_, i) => i),
        k,
      ),
    ]).toEqual([]);
  });
});

/**
 * What `reassembleBlob` does with a pile of images it did not curate.
 *
 * Restore is pointed at a folder, not at a manifest, so the payloads arriving
 * here are whatever was in it: images from two different saves, files that are
 * not vault images at all, and headers a forger controls. Three guards handle
 * that and none of them had a test that could tell they were there.
 */
describe('reassembling from an uncurated pile of images', () => {
  it('refuses an empty set, and says so', async () => {
    await expect(importVault([], 'pw', {})).rejects.toThrow(/no images provided/);
  });

  /**
   * Two vaults in one folder is an ordinary accident: a backup directory with
   * last month's save still in it. The set with more images wins, and the other
   * is ignored rather than mixed in, which would corrupt both.
   *
   * Both orderings are here because one of them proves nothing. The selection
   * loop keeps the first set to beat the running best, so a fixture whose
   * majority happens to come last is also satisfied by "take whichever was seen
   * last", and the first version of this test did exactly that.
   */
  it.each([
    ['majority first', true],
    ['majority last', false],
  ])('restores the larger set when two are mixed, %s', async (_label, majorityFirst) => {
    const keyA = await makeKey();
    const keyB = await makeKey();
    const otherContent = noise(4 * 1024); // a smaller vault, so fewer images

    const a = await exportVault(NAME, CONTENT, keyA);
    const b = await exportVault('other.bin', otherContent, keyB);
    expect(a.imagePayloads.length).toBeGreaterThan(b.imagePayloads.length);

    const mixed = majorityFirst
      ? [...a.imagePayloads, ...b.imagePayloads]
      : [...b.imagePayloads, ...a.imagePayloads];

    const out = await importVault(mixed, 'pw', { keyBlock: keyA.keyBlock });
    expect(out.filename).toBe(NAME);
    expect([...out.content]).toEqual([...CONTENT]);
  });

  /**
   * An exact tie goes to the set seen first, which is arbitrary but has to be
   * decided rather than left to whichever comparison someone writes next.
   * Loosening `>` to `>=` hands the vault to the other set, and both are
   * restorable here, so the wrong choice comes back as the wrong file rather
   * than as a failure.
   */
  it('breaks a tie in favour of the set seen first', async () => {
    const keyA = await makeKey();
    const keyB = await makeKey();
    const otherContent = noise(20 * 1024); // sized to give the same image count

    const a = await exportVault(NAME, CONTENT, keyA);
    const b = await exportVault('other.bin', otherContent, keyB);
    expect(b.imagePayloads.length).toBe(a.imagePayloads.length);

    const out = await importVault([...a.imagePayloads, ...b.imagePayloads], 'pw', {
      keyBlock: keyA.keyBlock,
    });
    expect(out.filename).toBe(NAME);
  });

  /**
   * A shard index past the end of the set, and the only forgery that reaches
   * this guard.
   *
   * A payload that simply names a high index never gets here: `decodeHeader`
   * rejects `shardIndex >= k + m` against the header's *own* k and m, and the
   * payload is dropped as unreadable. My first version of this test forged only
   * the index and passed with the guard deleted, because the decoder was doing
   * the work.
   *
   * The gap is that the decoder checks each header against itself while
   * `reassembleBlob` sizes the slot array from the set's first member. A header
   * declaring larger k and m of its own is internally consistent, so it is
   * accepted, and its index can still be past the real set's end. Then this
   * bound is all there is: without it the write extends the slot array beyond
   * k + m and every subset fails to reconstruct.
   */
  it.each([
    ['exactly at the end', 0],
    ['past the end', 4],
  ])('ignores a forged shard index %s of the real set', async (_label, over) => {
    const key = await makeKey();
    const { imagePayloads } = await exportVault(NAME, CONTENT, key);
    const { header, shard } = decodeImagePayload(imagePayloads[0]!);

    // `over: 0` is the boundary the bound actually draws. Widening `<` to `<=`
    // lets exactly that index through, and a fixture only ever a few past the
    // end cannot tell the two apart.
    const forged = encodeImagePayload(
      { ...header, k: header.k + 12, m: header.m + 2, shardIndex: header.k + header.m + over },
      shard,
    );
    // It really does survive the decoder: that is what makes it this guard's
    // problem rather than the header's.
    expect(decodeImagePayload(forged).header.shardIndex).toBeGreaterThanOrEqual(
      header.k + header.m,
    );

    const out = await importVault([...imagePayloads, forged], 'pw', { keyBlock: key.keyBlock });
    expect([...out.content]).toEqual([...CONTENT]);
  });
});

/**
 * One mutant here cannot be killed, recorded so it is not chased.
 *
 * `let bestSet = ''` can be seeded with any string at all. The counter beside it
 * starts at -1, and the loop that follows runs over a map that is never empty,
 * because `decoded.length === 0` is refused above it. So the first iteration
 * always beats -1 and always overwrites the seed, whatever it was.
 */
