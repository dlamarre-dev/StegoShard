/**
 * The vault identity block (SPEC §4, FLAGS bit2).
 *
 * Two things are under test: that the block round-trips exactly, and that its
 * *absence* is the default everywhere it must be. The second matters more. An
 * identity on a deniable path would be a linkability leak, so the guarantee is
 * structural — the gallery and disguised-`.db` builders take no identity
 * parameter — and these tests pin the observable half of that.
 */

import { describe, it, expect } from 'vitest';
import { buildPayload, parsePayload, type VaultIdentity } from './payload';
import { buildPlainVaultBlobMulti, decodeMultiRegionVaultBlob } from './vault';
import { GALLERY_LADDER } from './buckets';
import { type Argon2Params, randomBytes } from './crypto';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const enc = (s: string) => new TextEncoder().encode(s);
const MAX = 1 << 20;

const identity = (sequence = 1): VaultIdentity => ({
  vaultId: new Uint8Array(16).fill(0xa7),
  sequence,
});

describe('identity round-trip', () => {
  it('carries the vault id and sequence back unchanged', async () => {
    const id = identity(7);
    const env = await buildPayload('notes.txt', enc('hello'), { identity: id });
    const out = await parsePayload(env, MAX);

    expect(out.filename).toBe('notes.txt');
    expect(new TextDecoder().decode(out.content)).toBe('hello');
    expect(out.identity).toBeDefined();
    expect([...out.identity!.vaultId]).toEqual([...id.vaultId]);
    expect(out.identity!.sequence).toBe(7);
  });

  it('survives the compression path, which reorders nothing', async () => {
    // Compressible content takes the gzip branch; the identity sits before
    // CONTENT, so it must be unaffected either way.
    const env = await buildPayload('a.txt', enc('x'.repeat(4096)), { identity: identity(2) });
    const out = await parsePayload(env, MAX);
    expect(out.identity!.sequence).toBe(2);
    expect(out.content.length).toBe(4096);
  });

  it('composes with the bundle flag', async () => {
    const env = await buildPayload('b.zip', enc('zip'), { bundle: true, identity: identity(3) });
    const out = await parsePayload(env, MAX);
    expect(out.bundled).toBe(true);
    expect(out.identity!.sequence).toBe(3);
  });

  it('handles the sequence boundaries', async () => {
    for (const sequence of [1, 0xffffffff]) {
      const out = await parsePayload(
        await buildPayload('a', enc('x'), { identity: identity(sequence) }),
        MAX,
      );
      expect(out.identity!.sequence).toBe(sequence);
    }
  });
});

describe('identity absence', () => {
  it('is undefined, not a zero value, when the flag is clear', async () => {
    const out = await parsePayload(await buildPayload('a.txt', enc('x')), MAX);
    expect(out.identity).toBeUndefined();
  });

  it('adds no bytes when absent, so the common case is unchanged', async () => {
    // The envelope an untracked save produces must be byte-for-byte what it was
    // before the flag existed; otherwise every capacity estimate shifts.
    const plain = await buildPayload('a.txt', enc('x'));
    const withId = await buildPayload('a.txt', enc('x'), { identity: identity() });
    expect(withId.length - plain.length).toBe(20);
    expect(plain[0]! & 0x04).toBe(0);
  });
});

describe('identity rejection', () => {
  it('refuses a vault id of the wrong length', async () => {
    await expect(
      buildPayload('a', enc('x'), { identity: { vaultId: new Uint8Array(15), sequence: 1 } }),
    ).rejects.toThrow(/vault id/);
  });

  /**
   * The parse side has to agree with the build side, or the registry's
   * arithmetic runs on a range the builder never promised. Only a container
   * this code wrote wrong can carry a 0 — the identity block sits inside the
   * AEAD, so it is not an attacker's edit.
   */
  it('rejects a sequence of zero on the way back in', async () => {
    const env = await buildPayload('a.txt', enc('x'), { identity: identity(1) });
    // The sequence is the u32 at the end of the 20-byte identity block, which
    // begins right after the 3-byte header and the filename.
    const seqAt = 3 + 'a.txt'.length + 16;
    const zeroed = Uint8Array.from(env);
    zeroed.fill(0, seqAt, seqAt + 4);
    await expect(parsePayload(zeroed, MAX)).rejects.toThrow(/sequence out of range \(0\)/);
  });

  it('refuses a sequence outside the u32 range or below one', async () => {
    for (const sequence of [0, -1, 1.5, 0x1_0000_0000, Number.NaN]) {
      await expect(
        buildPayload('a', enc('x'), { identity: { vaultId: new Uint8Array(16), sequence } }),
        `sequence ${sequence} was accepted`,
      ).rejects.toThrow(/sequence/);
    }
  });

  it('refuses an envelope whose identity block is truncated', async () => {
    const env = await buildPayload('a.txt', enc('x'), { identity: identity() });
    // Cut into the identity block: the flag says it is there, the bytes do not.
    await expect(parsePayload(env.slice(0, 3 + 5 + 10), MAX)).rejects.toThrow(/identity/);
  });
});

describe('the deniable paths carry no identity, structurally', () => {
  /**
   * The multi-region builders accept no identity parameter at all, so this is a
   * type-level guarantee first. What is checkable at runtime is the other half:
   * their decode surface exposes no `identity` key that a caller could branch
   * on, which is what keeps a real and a decoy unlock indistinguishable.
   */
  it('returns a decode surface with no identity key', async () => {
    const { blob } = await buildPlainVaultBlobMulti(
      'a.txt',
      enc('alpha'),
      'pw',
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    const out = await decodeMultiRegionVaultBlob(blob, 'pw', {
      params: TEST_PARAMS,
      maxContentBytes: MAX,
    });
    expect(Object.keys(out).sort()).toEqual(['bundled', 'content', 'filename']);
  });

  it('produces a blob of the same length whatever the content, per bucket', async () => {
    // Padding to a bucket is what hides the true size; an identity would have
    // shifted it. Nothing on this path writes one, so both land on one rung.
    const a = await buildPlainVaultBlobMulti(
      'a',
      randomBytes(64),
      'pw',
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    const b = await buildPlainVaultBlobMulti(
      'b',
      randomBytes(200),
      'pw',
      GALLERY_LADDER,
      TEST_PARAMS,
    );
    expect(a.blob.length).toBe(b.blob.length);
  });
});
