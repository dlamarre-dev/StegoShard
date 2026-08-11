/**
 * Conformance matrix for the §10 access structures (SPEC §10.10). These are the
 * standing guards that the invariants hold as the code evolves:
 *
 *  - excluded paths NEVER gain a slot array (the "someone unified the writers"
 *    tripwire);
 *  - plain / Mode A / Mode B containers are byte-length-indistinguishable at the
 *    same bucket on the same path (§10.2);
 *  - the slot open is fail-closed and position-independent (§10.3.1);
 *  - a tampered slot array fails rather than redirecting to another region;
 *  - the decode surface leaks no slot/region/mode, and the core logs nothing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { readU16 } from './bytes';
import {
  type Argon2Params,
  DEK_LEN,
  KEY_BLOCK_LEN,
  SLOT_ARRAY_LEN,
  VAULT_SALT_LEN,
  WrongPasswordError,
  buildSlotArray,
  createKeyBlock,
  deriveKEK,
  openSlotArray,
  randomBytes,
  serializeKeyBlock,
} from './crypto';
import { GALLERY_LADDER } from './buckets';
import {
  type VaultKey,
  blobLenFor,
  buildPlainVaultBlobMulti,
  buildVaultBlob,
  decodeMultiRegionVaultBlob,
  exportVaultBinary,
  importVaultBinary,
} from './vault';
import { buildDuressVaultBlob, buildNonPossessionVaultBlob } from './access';
import { buildPayload } from './payload';

const P: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const enc = (s: string) => new TextEncoder().encode(s);
const CAP = 1 << 20;
const small = () => enc('a small secret');

async function vaultKey(): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock('pw', P);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

describe('§10.10 excluded paths carry no slot array (regression tripwire)', () => {
  it('the single-region image blob is the 92-byte-key-block shape, not multi-region', async () => {
    const key = await vaultKey();
    const content = small();
    const blob = await buildVaultBlob('f.txt', content, key, 'embedded');
    // A single-region blob begins with KB_LEN = 92 (the embedded SSKY key block),
    // NOT a 16-byte vault_salt + 304-byte slot array.
    expect(readU16(blob, 0)).toBe(KEY_BLOCK_LEN);
    // And it stays the pre-§10 analytic size (doubling would betray a "unified" writer).
    const env = await buildPayload('f.txt', content);
    expect(blob.length).toBe(blobLenFor(env.length, true));
    // It is far smaller than the equivalent multi-region blob (~2× + bucket padding).
    const { blob: multi } = await buildPlainVaultBlobMulti(
      'f.txt',
      content,
      'pw',
      GALLERY_LADDER,
      P,
    );
    expect(multi.length).toBeGreaterThan(blob.length * 2);
    expect(multi.length).toBeGreaterThan(VAULT_SALT_LEN + SLOT_ARRAY_LEN);
  });

  it('the branded .ssbn container stays single-region (segmented KB_LEN header)', async () => {
    const key = await vaultKey();
    const { container } = await exportVaultBinary('f.txt', small(), key, { variant: 'branded' });
    // Strip the "SSBN" magic+version; the segmented header's KB_LEN (u16 at offset 6)
    // is the 92-byte embedded key block; the multi-region head has vault_salt there.
    const payload = container.subarray(5);
    expect(new TextDecoder().decode(payload.subarray(0, 4))).toBe('SSCS');
    expect(readU16(payload, 6)).toBe(KEY_BLOCK_LEN);
    // Round-trips through the single-region decoder.
    const out = await importVaultBinary(container, 'pw');
    expect(new TextDecoder().decode(out.content)).toBe('a small secret');
  });
});

describe('§10.10 per-path indistinguishability at a fixed bucket (§10.2)', () => {
  it('plain / Mode A / Mode B gallery blobs share one length and layout', async () => {
    // All payloads are small enough to land in the smallest (4 KiB) gallery bucket.
    const plain = (await buildPlainVaultBlobMulti('r', small(), 'pw', GALLERY_LADDER, P)).blob;
    const duress = (
      await buildDuressVaultBlob(
        'r',
        small(),
        'd',
        enc('decoy'),
        'realphrase-x',
        'duressphrase-y',
        GALLERY_LADDER,
        P,
      )
    ).blob;
    const nonposs = (await buildNonPossessionVaultBlob('r', small(), 'pw', 2, 3, GALLERY_LADDER, P))
      .blob;

    // Byte-length equality: the mode is not readable from the container size.
    expect(duress.length).toBe(plain.length);
    expect(nonposs.length).toBe(plain.length);
    // Identical section layout: vault_salt(16) · slot_array(304) · two equal regions.
    for (const blob of [plain, duress, nonposs]) {
      const regionArea = blob.length - VAULT_SALT_LEN - SLOT_ARRAY_LEN;
      expect(regionArea % 2).toBe(0);
      expect(regionArea).toBeGreaterThan(0);
    }
  });
});

describe('§10.10 constant-work slot open: fail-closed and position-independent', () => {
  it('opens the live slot wherever the shuffle placed it, over many authorings', async () => {
    const salt = randomBytes(16);
    const kek = await deriveKEK('pw', salt, P);
    for (let i = 0; i < 12; i++) {
      const dek = randomBytes(DEK_LEN);
      const arr = await buildSlotArray([{ kek, dek, regionIndex: i & 1 }]);
      const got = await openSlotArray(arr, [kek]);
      expect([...got.dek]).toEqual([...dek]); // found regardless of position (no early exit)
    }
  });

  it('fails closed when two slots open under the same KEK (malformed)', async () => {
    const kek = await deriveKEK('pw', randomBytes(16), P);
    // Two live slots under the SAME kek → more than one match → fail closed.
    const arr = await buildSlotArray([
      { kek, dek: randomBytes(DEK_LEN), regionIndex: 0 },
      { kek, dek: randomBytes(DEK_LEN), regionIndex: 1 },
    ]);
    await expect(openSlotArray(arr, [kek])).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe('§10.10 tamper: a corrupted slot array fails, never redirects', () => {
  it('corrupting the slot array yields WrongPasswordError, not another region', async () => {
    const { blob } = await buildPlainVaultBlobMulti('r', small(), 'pw', GALLERY_LADDER, P);
    const tampered = blob.slice();
    // Corrupt the first (nonce) byte of ALL four slots, so the (shuffled) live slot
    // is definitely broken; its GCM open then fails rather than redirecting.
    for (let s = 0; s < 4; s++) {
      const off = VAULT_SALT_LEN + s * 76;
      tampered[off] = tampered[off]! ^ 0xff;
    }
    await expect(
      decodeMultiRegionVaultBlob(tampered, 'pw', { params: P, maxContentBytes: CAP }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('flipping the vault salt yields WrongPasswordError (wrong KEK)', async () => {
    const { blob } = await buildPlainVaultBlobMulti('r', small(), 'pw', GALLERY_LADDER, P);
    const tampered = blob.slice();
    tampered[0] = tampered[0]! ^ 0xff;
    await expect(
      decodeMultiRegionVaultBlob(tampered, 'pw', { params: P, maxContentBytes: CAP }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe('§10.10 no leakage of slot/region/mode', () => {
  it('the decode surface returns only { filename, content, bundled }', async () => {
    const { blob } = await buildPlainVaultBlobMulti('note.txt', small(), 'pw', GALLERY_LADDER, P);
    const out = await decodeMultiRegionVaultBlob(blob, 'pw', { params: P, maxContentBytes: CAP });
    // Tripwire on the exact surface: nothing naming the slot, region or access
    // mode may reach the caller. `bundled` is a property of the plaintext the
    // writer stored and takes the same value whichever region held it, so it
    // cannot distinguish one from another.
    expect(Object.keys(out).sort()).toEqual(['bundled', 'content', 'filename']);
  });

  it('bundled is region-blind: a bundle in either region unlocks identically', async () => {
    // Written 8 times: the live region is a CSPRNG bit, so this exercises both
    // placements without depending on which one a given run picked.
    for (let i = 0; i < 8; i++) {
      const { blob } = await buildPlainVaultBlobMulti(
        'b.zip',
        small(),
        'pw',
        GALLERY_LADDER,
        P,
        null,
        true,
      );
      const out = await decodeMultiRegionVaultBlob(blob, 'pw', { params: P, maxContentBytes: CAP });
      expect(out.bundled).toBe(true);
    }
  });

  it('no core module logs to the console (would be a side channel)', () => {
    const coreDir = join(fileURLToPath(import.meta.url), '..');
    const files = readdirSync(coreDir, { recursive: true, encoding: 'utf-8' }).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(join(coreDir, f), 'utf-8');
      expect(src, `${f} must not console.* (no slot/region could leak there)`).not.toMatch(
        /\bconsole\.\w+\(/,
      );
    }
  });
});
