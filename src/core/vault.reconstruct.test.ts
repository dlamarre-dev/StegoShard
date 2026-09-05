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
import { type VaultKey, exportVault, importVault } from './vault';

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
