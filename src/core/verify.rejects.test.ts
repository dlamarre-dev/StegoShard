/**
 * Post-save verification has to be seen rejecting, not only accepting.
 *
 * `assertRestores` and the three `verify*Export` functions are the last thing
 * between a user and a save that looks fine and is not. The comment above them
 * says so: decode the artifact back "BEFORE telling the user the save succeeded",
 * so a carrier fault surfaces now rather than at some future restore when the
 * original is gone.
 *
 * The mutation run found that safety net had only ever been watched succeeding.
 * Stryker reported the `throw new VerificationError()` inside `assertRestores`
 * as **no coverage**, and the same for `verifyDisguisedExport`: the `if` line
 * runs on every happy-path test, but its condition was never once true, so the
 * throw never executed. The two existing rejection tests both fail earlier, in
 * `verifyImageExport`'s own catch around `reassembleBlob`, and never reach the
 * comparison at all.
 *
 * The survivors say the same thing from the other side. Forcing that condition
 * to `false`, so verification never rejects anything, survived the suite. So did
 * turning its `||` into `&&`, which is a verification that only objects when the
 * filename *and* the content are both wrong.
 *
 * `verifyDisguisedExport` had no test whatsoever, on either side.
 */

import { describe, it, expect } from 'vitest';
import { type Argon2Params, createKeyBlock, serializeKeyBlock } from './crypto';
import {
  type VaultKey,
  VerificationError,
  exportVault,
  exportVaultBinary,
  exportVaultBinaryDisguised,
  verifyBinaryExport,
  verifyDisguisedExport,
  verifyImageExport,
} from './vault';

const FAST: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };
const NAME = 'secret.txt';
const CONTENT = new Uint8Array(3000).map((_, i) => (i * 131 + 7) & 0xff);

async function makeKey(): Promise<VaultKey> {
  const { dek, block } = await createKeyBlock('pw', FAST);
  return { dek, keyBlock: serializeKeyBlock(block) };
}

describe('assertRestores actually rejects (image path)', () => {
  it('rejects when the content differs from what was saved', async () => {
    // Reaches the comparison rather than failing in reassembly, which is what
    // the two existing rejection tests do. This is the mutant Stryker could not
    // cover: the throw on the far side of that `if`.
    const key = await makeKey();
    const { imagePayloads } = await exportVault(NAME, CONTENT, key);
    const different = new Uint8Array(CONTENT.length).fill(0x42);

    await expect(verifyImageExport(imagePayloads, key.dek, NAME, different)).rejects.toBeInstanceOf(
      VerificationError,
    );
  });

  it('rejects when only the filename differs', async () => {
    // The `||` in that comparison. Turned into `&&` it survives every other test
    // here, because nothing ever gets the filename wrong while the bytes are
    // right, which is precisely the case a renamed save would produce.
    const key = await makeKey();
    const { imagePayloads } = await exportVault(NAME, CONTENT, key);

    await expect(
      verifyImageExport(imagePayloads, key.dek, 'a-different-name.txt', CONTENT),
    ).rejects.toBeInstanceOf(VerificationError);
  });

  it('rejects when the restored content is a prefix of what was expected', async () => {
    // `bytesEqual` opens with a length check whose `return false` never ran, and
    // the direction matters. It wrote `bytesEqual(got.content, content)`, and the
    // loop that follows runs to `a.length`. So when what came back is *longer*
    // the loop already catches it by reading past the end of `b` and comparing
    // against undefined; the length check is redundant there.
    //
    // It only earns its place when what came back is **shorter**: the loop then
    // runs to the short length, every byte agrees, and it returns true. That is
    // a truncated restore reported as a faithful one, which is the worst
    // direction for this particular check to fail in.
    //
    // A first version of this test had the arguments the other way round and
    // killed nothing, passing on the redundant side of the branch.
    const key = await makeKey();
    const { imagePayloads } = await exportVault(NAME, CONTENT, key);
    const expectedLonger = new Uint8Array(CONTENT.length + 1);
    expectedLonger.set(CONTENT, 0);

    await expect(
      verifyImageExport(imagePayloads, key.dek, NAME, expectedLonger),
    ).rejects.toBeInstanceOf(VerificationError);
  });

  it('rejects when handed a key that cannot open the blob', async () => {
    // The `catch` inside assertRestores, as opposed to the one around
    // reassembly. The shards are intact and reassemble cleanly; decryption is
    // what fails. Verification passing here would mean confirming a save against
    // a key that cannot read it.
    const key = await makeKey();
    const other = await makeKey();
    const { imagePayloads } = await exportVault(NAME, CONTENT, key);

    await expect(verifyImageExport(imagePayloads, other.dek, NAME, CONTENT)).rejects.toBeInstanceOf(
      VerificationError,
    );
  });
});

describe('verifyBinaryExport rejects a rename too', () => {
  it('rejects when only the filename differs', async () => {
    // Same `||` on the branded path, which had a content-mismatch test but no
    // filename one.
    const key = await makeKey();
    const { container } = await exportVaultBinary(NAME, CONTENT, key, { variant: 'branded' });

    await expect(
      verifyBinaryExport(container, key.dek, 'renamed.txt', CONTENT),
    ).rejects.toBeInstanceOf(VerificationError);
  });
});

// 30s against a measured 800ms per test, which needs explaining rather than
// looking like padding. `exportVaultBinaryDisguised` takes no Argon2 parameters:
// it hardcodes the production ones, 256 MiB and four passes, and then builds a
// DB_LADDER-sized SQLite container. The other tests in this file take 3ms because
// they can pass FAST params; these cannot.
//
// In isolation 800ms is comfortably inside vitest's 5s default. In the full suite
// it is not: workers compete for the memory bandwidth Argon2 exists to consume,
// and one run timed out at 5s having done work that normally takes under one.
// The test was not hung, it was queued. A generous ceiling is the honest fix,
// since the alternative is a suite that fails on a loaded machine.
describe('verifyDisguisedExport, which had no test at all', { timeout: 30_000 }, () => {
  // The disguised `.db` is the deniable path, so a bad save here is the one
  // least likely to be noticed by other means: the file still looks like an
  // ordinary SQLite database whether or not it carries a recoverable vault.
  async function disguised() {
    return exportVaultBinaryDisguised(NAME, CONTENT, 'pw');
  }

  it('accepts a faithful container', async () => {
    const { container, regionIndex, dek } = await disguised();
    await expect(
      verifyDisguisedExport(container, dek, regionIndex, NAME, CONTENT),
    ).resolves.toBeUndefined();
  });

  it('rejects when the content differs', async () => {
    const { container, regionIndex, dek } = await disguised();
    const different = new Uint8Array(CONTENT.length).fill(0x42);
    await expect(
      verifyDisguisedExport(container, dek, regionIndex, NAME, different),
    ).rejects.toBeInstanceOf(VerificationError);
  });

  it('rejects when only the filename differs', async () => {
    const { container, regionIndex, dek } = await disguised();
    await expect(
      verifyDisguisedExport(container, dek, regionIndex, 'renamed.txt', CONTENT),
    ).rejects.toBeInstanceOf(VerificationError);
  });

  it('rejects a container that was only half written', async () => {
    // The `catch`: decoding fails outright rather than returning a wrong answer.
    //
    // This started as a flipped tail byte and was **flaky**, failing three runs
    // in six. A disguised container places its live region at a random index
    // among the decoys, so the last byte is sometimes live ciphertext, where the
    // GCM tag refuses it, and sometimes inert filler, where flipping it changes
    // nothing and verification rightly accepts. Truncation does not care where
    // the live region landed.
    const { container, regionIndex, dek } = await disguised();
    const half = container.slice(0, container.length >> 1);
    await expect(
      verifyDisguisedExport(half, dek, regionIndex, NAME, CONTENT),
    ).rejects.toBeInstanceOf(VerificationError);
  });
});
