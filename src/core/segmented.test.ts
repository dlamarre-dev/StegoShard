import { describe, it, expect } from 'vitest';
import {
  type Argon2Params,
  WrongPasswordError,
  createKeyBlock,
  randomBytes,
  serializeKeyBlock,
} from './crypto';
import {
  SEG_MAGIC,
  SEG_VERSION,
  SegmentedFormatError,
  buildSegmentedBlob,
  decodeSegmentedBlob,
  decodeSegmentedBlobWithDek,
  looksLikeSegmented,
} from './segmented';
import { MissingKeyError, type VaultKey } from './vault';

const TEST_PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const MAX = 100 * 1024 * 1024;
/** Smallest allowed chunk size, so modest payloads still span several chunks. */
const CHUNK = 4096;

async function makeKey(password: string): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock(password, TEST_PARAMS);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

/** Incompressible content of a given length (random ⇒ envelope length is exact). */
function randomContent(len: number): Uint8Array {
  return randomBytes(len);
}

describe('segmented blob round-trip', () => {
  // With filename 'x' (1 byte) and incompressible content, the envelope length is
  // 4 + len, so these lengths cover: empty, 1 byte, a partial last chunk, an exact
  // multiple of CHUNK (8188→8192), one-over (8189→8193), and several chunks.
  for (const len of [0, 1, 5000, 8188, 8189, 12345]) {
    it(`round-trips a ${len}-byte secret across chunk boundaries`, async () => {
      const key = await makeKey('pw');
      const content = randomContent(len);
      const blob = await buildSegmentedBlob('x', content, key, 'embedded', undefined, CHUNK);
      expect(looksLikeSegmented(blob)).toBe(true);
      const out = await decodeSegmentedBlob(blob, 'pw', { maxContentBytes: MAX });
      expect(out.filename).toBe('x');
      expect([...out.content]).toEqual([...content]);
    });
  }

  it('decodes with an already-unlocked DEK (verify path, no password)', async () => {
    const key = await makeKey('pw');
    const content = randomContent(100);
    const blob = await buildSegmentedBlob('x', content, key, 'embedded', undefined, CHUNK);
    const out = await decodeSegmentedBlobWithDek(blob, key.dek, MAX);
    expect([...out.content]).toEqual([...content]);
  });

  it('reports real per-chunk progress that reaches the total', async () => {
    const key = await makeKey('pw');
    const content = randomContent(5000); // envelope 5004 → 2 chunks (4096 + 908)
    const seen: number[] = [];
    const blob = await buildSegmentedBlob(
      'x',
      content,
      key,
      'embedded',
      (p) => {
        if (p.phase === 'encrypt') seen.push(p.done);
      },
      CHUNK,
    );
    expect(seen.length).toBeGreaterThan(1); // multiple updates
    expect(seen.at(-1)).toBe(5004); // last update == total envelope length
    // and decrypt reports too
    const decSeen: number[] = [];
    await decodeSegmentedBlobWithDek(blob, key.dek, MAX, (p) => {
      if (p.phase === 'decrypt') decSeen.push(p.done);
    });
    expect(decSeen.at(-1)).toBe(5004);
  });
});

describe('segmented key modes', () => {
  it('needs the external key block in keyfile mode', async () => {
    const key = await makeKey('pw');
    const content = randomContent(50);
    const blob = await buildSegmentedBlob('x', content, key, 'keyfile', undefined, CHUNK);
    await expect(decodeSegmentedBlob(blob, 'pw', { maxContentBytes: MAX })).rejects.toBeInstanceOf(
      MissingKeyError,
    );
    const out = await decodeSegmentedBlob(blob, 'pw', {
      keyBlock: key.keyBlock,
      maxContentBytes: MAX,
    });
    expect([...out.content]).toEqual([...content]);
  });

  it('rejects a wrong password', async () => {
    const key = await makeKey('correct horse');
    const blob = await buildSegmentedBlob('x', randomContent(50), key, 'embedded', undefined, CHUNK);
    await expect(decodeSegmentedBlob(blob, 'wrong', { maxContentBytes: MAX })).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });
});

describe('segmented tamper / truncation / reorder rejection', () => {
  // keyfile mode ⇒ KB_LEN=0 ⇒ header = 8 + 0 + 35 = 43 bytes; decode with the DEK.
  const HEADER_LEN = 43;
  const CT_CHUNK = CHUNK + 16; // ciphertext + GCM tag

  async function freshBlob(len = 10000): Promise<{ key: VaultKey; blob: Uint8Array }> {
    const key = await makeKey('pw');
    const blob = await buildSegmentedBlob('x', randomContent(len), key, 'keyfile', undefined, CHUNK);
    return { key, blob };
  }

  it('rejects a flipped ciphertext byte', async () => {
    const { key, blob } = await freshBlob();
    blob[HEADER_LEN] = blob[HEADER_LEN]! ^ 0x01; // first ciphertext byte
    await expect(decodeSegmentedBlobWithDek(blob, key.dek, MAX)).rejects.toBeInstanceOf(
      SegmentedFormatError,
    );
  });

  it('rejects reordered chunks', async () => {
    const { key, blob } = await freshBlob(); // envelope 10004 → 3 chunks (two full)
    const c0 = blob.slice(HEADER_LEN, HEADER_LEN + CT_CHUNK);
    const c1 = blob.slice(HEADER_LEN + CT_CHUNK, HEADER_LEN + 2 * CT_CHUNK);
    blob.set(c1, HEADER_LEN);
    blob.set(c0, HEADER_LEN + CT_CHUNK);
    await expect(decodeSegmentedBlobWithDek(blob, key.dek, MAX)).rejects.toBeInstanceOf(
      SegmentedFormatError,
    );
  });

  it('rejects truncation (dropped tail bytes)', async () => {
    const { key, blob } = await freshBlob();
    const truncated = blob.slice(0, blob.length - 100); // body no longer matches header
    await expect(decodeSegmentedBlobWithDek(truncated, key.dek, MAX)).rejects.toBeInstanceOf(
      SegmentedFormatError,
    );
  });

  it('rejects appended trailing bytes', async () => {
    const { key, blob } = await freshBlob();
    const extended = new Uint8Array(blob.length + 5);
    extended.set(blob, 0);
    await expect(decodeSegmentedBlobWithDek(extended, key.dek, MAX)).rejects.toBeInstanceOf(
      SegmentedFormatError,
    );
  });

  it('rejects a tampered chunk-size header field', async () => {
    const { key, blob } = await freshBlob();
    // chunkSize u32 lives at 8 + 0(KB) + 16(salt) + 7(prefix) = offset 31.
    blob[31 + 3] = blob[31 + 3]! ^ 0x02; // perturb the low byte → framing no longer matches
    await expect(decodeSegmentedBlobWithDek(blob, key.dek, MAX)).rejects.toBeInstanceOf(
      SegmentedFormatError,
    );
  });

  it('rejects bad magic and unsupported version', async () => {
    const { key, blob } = await freshBlob();
    const badMagic = blob.slice();
    badMagic[0] = badMagic[0]! ^ 0xff;
    expect(looksLikeSegmented(badMagic)).toBe(false);
    await expect(decodeSegmentedBlobWithDek(badMagic, key.dek, MAX)).rejects.toBeInstanceOf(
      SegmentedFormatError,
    );
    const badVer = blob.slice();
    badVer[SEG_MAGIC.length] = SEG_VERSION + 9;
    await expect(decodeSegmentedBlobWithDek(badVer, key.dek, MAX)).rejects.toThrow(
      /unsupported version/,
    );
  });
});
