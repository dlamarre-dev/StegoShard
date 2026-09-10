/**
 * What the AAD binding actually prevents (SPEC §6, §10.1, §10.6).
 *
 * Before this binding, every AEAD site on the image and gallery paths passed an
 * empty AAD. That did not let an attacker produce wrong plaintext — GCM still
 * failed the tag — but it left the container's fields individually sealed and
 * collectively unbound, which is a detectable-failure property rather than an
 * authenticated-vault one.
 *
 * Each test performs a splice an attacker with write access could actually
 * attempt, and requires it to be refused.
 *
 * BE PRECISE ABOUT WHAT THESE PROVE. Most of these splices already failed before
 * the AAD existed, because changing a key block, a salt or a region index also
 * changes the derived key. Running the suite with every AAD builder stubbed to
 * return empty shows exactly one test here still catching it: "the key block
 * being lifted out and delivered externally". That one is the splice the binding
 * alone refuses, and it is the honest headline. (Two more live in
 * slots.test.ts: a slot opened as the wrong container kind, and a slot moved
 * under a different vault salt.)
 *
 * The rest are still worth keeping. They pin the refusals as *authenticated*
 * rather than incidental, which is what stops a later refactor from quietly
 * reintroducing a path where the key does not change. But they are regression
 * guards, not evidence for the AAD, and should not be cited as such.
 *
 * The last test in the keyfile group is the opposite kind: it pins a splice that
 * must KEEP working, because binding it would have been a data-loss bug.
 */

import { describe, it, expect } from 'vitest';
import {
  type Argon2Params,
  SLOT_ARRAY_LEN,
  VAULT_SALT_LEN,
  WrongPasswordError,
  createKeyBlock,
  parseKeyBlock,
  rewrapKeyBlock,
  serializeKeyBlock,
} from './crypto';
import {
  type VaultKey,
  buildPlainVaultBlobMulti,
  decodeMultiRegionVaultBlob,
  exportVault,
  importVault,
} from './vault';
import { GALLERY_LADDER } from './buckets';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const enc = (s: string) => new TextEncoder().encode(s);

async function makeKey(password: string): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock(password, TEST_PARAMS);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

/** Rebuild the single-shot blob from an export's image payloads. */
async function blobOf(payloads: Uint8Array[]): Promise<Uint8Array> {
  // The header is 33 bytes; the blob is the concatenated shards trimmed to
  // BLOB_LEN, which `importVault` does internally. Reading it back out of the
  // payloads keeps these tests at the wire level, where the attacker works.
  const { decodeHeader } = await import('./header');
  const first = decodeHeader(payloads[0]!);
  const shards = payloads.map((p) => p.subarray(33));
  const joined = new Uint8Array(shards.reduce((n, s) => n + s.length, 0));
  let o = 0;
  for (const s of shards) {
    joined.set(s, o);
    o += s.length;
  }
  return joined.subarray(0, first.blobLen);
}

/**
 * Re-shard an edited blob of the SAME length, preserving each header.
 * For a length-changing edit use `reshardTo`, which rewrites BLOB_LEN too.
 */
function reshard(payloads: Uint8Array[], blob: Uint8Array): Uint8Array[] {
  const shardLen = payloads[0]!.length - 33;
  return payloads.map((p, i) => {
    const out = new Uint8Array(p.length);
    out.set(p.subarray(0, 33), 0);
    out.set(blob.subarray(i * shardLen, (i + 1) * shardLen), 33);
    return out;
  });
}

/**
 * Re-shard a blob whose length changed, rewriting BLOB_LEN in every header so
 * the container stays internally consistent. An attacker editing images would
 * of course fix these fields; a test that left them stale would be refused by
 * the header check and would prove nothing about the AAD.
 */
async function reshardTo(payloads: Uint8Array[], blob: Uint8Array): Promise<Uint8Array[]> {
  const { decodeHeader, encodeHeader } = await import('./header');
  const { sha256Short } = await import('./vault');
  // HASH_GLOBAL is recomputed, not left stale. It is a 4-byte truncated SHA-256
  // in an unauthenticated header: a triage hint for reconstruction errors, never
  // a security boundary (CRYPTO-REVIEW §7.4). An attacker rewriting the blob
  // rewrites it too, in one line, exactly as here. Leaving it stale would make
  // this test pass on the integrity hint and prove nothing about the AAD.
  const hash = await sha256Short(blob);
  const shardLen = payloads[0]!.length - 33;
  return payloads.map((p, i) => {
    const header = decodeHeader(p);
    const out = new Uint8Array(p.length);
    out.set(encodeHeader({ ...header, blobLen: blob.length, hash }), 0);
    out.set(blob.subarray(i * shardLen, (i + 1) * shardLen), 33);
    return out;
  });
}

describe('§6 vault blob: the key block is bound to the ciphertext', () => {
  it('refuses a foreign but valid key block spliced into an embedded blob', async () => {
    const mine = await makeKey('pw');
    const theirs = await makeKey('pw');
    const a = await exportVault('a.txt', enc('mine'), mine, { keyMode: 'embedded' });

    const blob = await blobOf(a.imagePayloads);
    const spliced = blob.slice();
    // Both key blocks are the fixed 92 bytes, so this substitution keeps every
    // length and offset intact. Only the AAD notices.
    spliced.set(theirs.keyBlock, 7);
    expect(spliced.length).toBe(blob.length);

    await expect(importVault(reshard(a.imagePayloads, spliced), 'pw')).rejects.toThrow();
  });

  /**
   * The one splice on this path that the AAD, and only the AAD, refuses.
   *
   * An embedded vault is self-contained: images plus password. Strip the 92
   * key-block bytes out of the blob and set KB_LEN to 0, and it becomes a
   * keyfile vault whose `.key` the attacker now controls. Nothing else objects:
   * the DEK, content salt, IV and ciphertext are untouched, so the CEK derives
   * identically and the content tag would verify. Only KB_LEN and the key-block
   * bytes being inside the AAD stop it.
   *
   * Worth being precise about why the sibling splices below are weaker
   * evidence: substituting a foreign key block, or borrowing another export's
   * salt or IV, already failed before this change, because each of them changes
   * the derived CEK. The AAD makes those refusals *authenticated* rather than
   * incidental, which is the property an audit asks about, but it is not what
   * makes them fail. This one is.
   */
  it('refuses the key block being lifted out and delivered externally', async () => {
    const key = await makeKey('pw');
    const a = await exportVault('a.txt', enc('self-contained'), key, { keyMode: 'embedded' });
    const blob = await blobOf(a.imagePayloads);

    const KB_LEN = 92;
    expect((blob[5]! << 8) | blob[6]!).toBe(KB_LEN);
    // Rebuild the blob as a well-formed keyfile-mode blob carrying the same
    // ciphertext: [ magic ][ VER ][ KB_LEN = 0 ][ contentSalt ][ IV ][ ct ].
    const stripped = new Uint8Array(blob.length - KB_LEN);
    stripped.set(blob.subarray(0, 7), 0);
    stripped[5] = 0;
    stripped[6] = 0;
    stripped.set(blob.subarray(7 + KB_LEN), 7);

    // It parses cleanly and the key material is entirely correct.
    const payloads = await reshardTo(a.imagePayloads, stripped);
    await expect(importVault(payloads, 'pw', { keyBlock: key.keyBlock })).rejects.toThrow();
  });

  it('refuses a content salt or IV borrowed from another export of the same key', async () => {
    const key = await makeKey('pw');
    const a = await exportVault('a.txt', enc('first'), key, { keyMode: 'embedded' });
    const b = await exportVault('b.txt', enc('second'), key, { keyMode: 'embedded' });
    const blobA = await blobOf(a.imagePayloads);
    const blobB = await blobOf(b.imagePayloads);

    // [ magic 4 ][ VER 1 ][ KB_LEN 2 ][ keyBlock 92 ][ contentSalt 16 ][ IV 12 ]
    const SALT_OFF = 7 + 92;
    for (const [name, off, len] of [
      ['content salt', SALT_OFF, 16],
      ['IV', SALT_OFF + 16, 12],
    ] as const) {
      const spliced = blobA.slice();
      spliced.set(blobB.subarray(off, off + len), off);
      await expect(
        importVault(reshard(a.imagePayloads, spliced), 'pw'),
        `${name} was not bound`,
      ).rejects.toThrow();
    }
  });

  it('refuses a blob whose version byte has been rewritten', async () => {
    const key = await makeKey('pw');
    const a = await exportVault('a.txt', enc('mine'), key, { keyMode: 'embedded' });
    const blob = await blobOf(a.imagePayloads);
    const bumped = blob.slice();
    bumped[4] = 0xff;
    await expect(importVault(reshard(a.imagePayloads, bumped), 'pw')).rejects.toThrow();
  });
});

describe('keyfile mode: the external key block is deliberately NOT bound', () => {
  /**
   * The regression guard for the one decision in this change that goes against
   * the obvious instinct.
   *
   * Binding SHA-256(keyBlock) into the AAD would close a negligible gap (an
   * attacker who can substitute a key block wrapping the SAME DEK already holds
   * the DEK, hence the plaintext) and open a real one: `changePassword`
   * re-wraps the same DEK under a new password, producing different bytes. Any
   * such binding would make every vault exported before a password change
   * permanently undecodable, silently, with a generic GCM failure.
   *
   * So this test asserts a splice that must SUCCEED.
   */
  it('still restores after the key block is re-wrapped under a new password', async () => {
    const { dek, block } = await createKeyBlock('old-password', TEST_PARAMS);
    const key: VaultKey = { dek, keyBlock: serializeKeyBlock(block) };
    const a = await exportVault('k.txt', enc('survives a password change'), key, {
      keyMode: 'keyfile',
    });

    const rewrapped = serializeKeyBlock(
      await rewrapKeyBlock(
        parseKeyBlock(key.keyBlock),
        'old-password',
        'new-password',
        TEST_PARAMS,
      ),
    );
    // A genuinely different artifact for the same DEK.
    expect([...rewrapped]).not.toEqual([...key.keyBlock]);

    const out = await importVault(a.imagePayloads, 'new-password', { keyBlock: rewrapped });
    expect(new TextDecoder().decode(out.content)).toBe('survives a password change');
  });

  it('still refuses a key block for a different DEK', async () => {
    // The binding that matters here is the CEK's, not the AAD's: a foreign key
    // block yields a foreign DEK, so the content tag fails anyway. Stated as a
    // test so the previous one cannot be read as "any key block will do".
    const key = await makeKey('pw');
    const other = await makeKey('pw');
    const a = await exportVault('k.txt', enc('x'), key, { keyMode: 'keyfile' });
    await expect(
      importVault(a.imagePayloads, 'pw', { keyBlock: other.keyBlock }),
    ).rejects.toThrow();
  });
});

describe('§10.6 multi-region blob: regions and slots are bound to their container', () => {
  const build = (filename: string, body: string, password: string) =>
    buildPlainVaultBlobMulti(filename, enc(body), password, GALLERY_LADDER, TEST_PARAMS);

  const open = (blob: Uint8Array, password: string) =>
    decodeMultiRegionVaultBlob(blob, password, {
      params: TEST_PARAMS,
      maxContentBytes: 1 << 20,
    });

  it('refuses a slot array transplanted from another vault', async () => {
    const a = await build('a.txt', 'alpha', 'pw-a');
    const b = await build('b.txt', 'bravo', 'pw-b');
    // Both blobs are the same shape, so the transplant is byte-for-byte clean.
    expect(a.blob.length).toBe(b.blob.length);
    expect(new TextDecoder().decode((await open(a.blob, 'pw-a')).content)).toBe('alpha');

    // Move b's whole slot array into a. Without the binding this would be an
    // ordinary "wrong credential" outcome; with it, b's own password cannot
    // open its own slots once they sit under a's vault salt.
    const spliced = a.blob.slice();
    spliced.set(b.blob.subarray(VAULT_SALT_LEN, VAULT_SALT_LEN + SLOT_ARRAY_LEN), VAULT_SALT_LEN);
    await expect(open(spliced, 'pw-b')).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(open(spliced, 'pw-a')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('refuses a region block transplanted from another vault', async () => {
    const a = await build('a.txt', 'alpha', 'pw');
    const b = await build('b.txt', 'bravo', 'pw');
    expect(a.blob.length).toBe(b.blob.length);

    // Same password, same geometry: only the container context differs, which
    // is exactly what the region AAD binds.
    const head = VAULT_SALT_LEN + SLOT_ARRAY_LEN;
    const spliced = a.blob.slice();
    spliced.set(b.blob.subarray(head), head);
    await expect(open(spliced, 'pw')).rejects.toThrow();
  });

  it('refuses the two region blocks being swapped in place', async () => {
    const a = await build('a.txt', 'alpha', 'pw');
    const head = VAULT_SALT_LEN + SLOT_ARRAY_LEN;
    const r = (a.blob.length - head) / 2;
    const swapped = a.blob.slice();
    swapped.set(a.blob.subarray(head + r), head);
    swapped.set(a.blob.subarray(head, head + r), head + r);
    // The region index is in the AAD, so a block cannot answer for its neighbour.
    await expect(open(swapped, 'pw')).rejects.toThrow();
  });

  it('keeps both region blocks the same length, dead one included', async () => {
    // The deniability invariant the binding must not have disturbed: nothing is
    // stored, so a dead region is still R indistinguishable CSPRNG bytes.
    const a = await build('a.txt', 'alpha', 'pw');
    const head = VAULT_SALT_LEN + SLOT_ARRAY_LEN;
    expect((a.blob.length - head) % 2).toBe(0);
  });
});
