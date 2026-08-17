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
 * Two mutants in this function survive on purpose, recorded here so the next
 * reader does not hunt for a test that cannot exist. The `present.length < k`
 * early return is redundant with `kSubsets`, which yields nothing when k exceeds
 * the item count, so the function returns null either way. And the `catch` that
 * skips a subset with a singular matrix is unreachable by construction: the
 * erasure code uses a systematic Cauchy matrix, which is MDS, so every k-subset
 * of columns is invertible. Turning that `continue` into a `break` changes
 * nothing, because the branch never runs.
 *
 * Both are defensive code guarding properties the surrounding design already
 * provides. That is a reasonable thing to keep and an impossible thing to cover,
 * and the difference between those two statements is the whole reason to write
 * this paragraph instead of a test that appears to cover them.
 */

import { describe, it, expect } from 'vitest';
import { type Argon2Params, createKeyBlock, serializeKeyBlock } from './crypto';
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
