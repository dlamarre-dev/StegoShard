/**
 * The binary path's byte ceiling, and who chooses it.
 *
 * The core's own default is `MAX_FILE_BYTES_BINARY`, an alias for the 1 GiB
 * terminal budget, and the orchestration layer used to pass nothing and inherit
 * it silently. It now defaults to the conservative browser figure, so an embedded
 * caller cannot be talked into a 1 GiB in-memory buffer by whoever hands it a
 * file, and the CLI opts back up explicitly.
 *
 * Testing the real limits would mean allocating hundreds of megabytes, so these
 * assert the plumbing instead: that `maxBytes` reaches the core, that the default
 * is the conservative one, and that a caller can raise it. A small explicit
 * `maxBytes` stands in for the big one, which is exactly the same code path,
 * `content.length > maxBytes` in `exportVaultBinary`.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runRestore, runSave, DEFAULT_MAX_BINARY_BYTES } from './commands';
import { FileTooLargeError, MAX_FILE_BYTES_BINARY_CLI, MAX_FILE_BYTES_BINARY_UI } from '../../core';

const SLOW = { timeout: 90_000 };
const PW = 'a long unrelated passphrase for these tests';
const tmp = () => mkdtempSync(join(tmpdir(), 'ss-caps-'));

function secretOf(bytes: number): string {
  const dir = tmp();
  const path = join(dir, 's.bin');
  writeFileSync(
    path,
    Uint8Array.from({ length: bytes }, (_, i) => (i * 97) & 0xff),
  );
  return path;
}

const saveOpts = (input: string, outDir: string) => ({
  inputs: [input],
  outDir,
  password: PW,
  paper: false,
  zip: false,
  binary: 'branded' as const,
  keyMode: 'embedded' as const,
});

describe('the binary byte ceiling', () => {
  it('defaults to the conservative browser figure, not the terminal one', () => {
    expect(DEFAULT_MAX_BINARY_BYTES).toBe(MAX_FILE_BYTES_BINARY_UI);
    expect(DEFAULT_MAX_BINARY_BYTES).not.toBe(MAX_FILE_BYTES_BINARY_CLI);
    // The terminal budget is the larger of the two, so opting up is meaningful.
    expect(MAX_FILE_BYTES_BINARY_CLI).toBeGreaterThan(DEFAULT_MAX_BINARY_BYTES);
  });

  it('refuses a payload over an explicit maxBytes, naming both numbers', SLOW, async () => {
    const input = secretOf(4096);
    const failure = runSave({ ...saveOpts(input, tmp()), maxBytes: 1024 });
    await expect(failure).rejects.toBeInstanceOf(FileTooLargeError);
    await expect(failure).rejects.toMatchObject({ size: 4096, limit: 1024 });
  });

  it('accepts the same payload once the caller raises the ceiling', SLOW, async () => {
    const input = secretOf(4096);
    const res = await runSave({ ...saveOpts(input, tmp()), maxBytes: 8192 });
    expect(res.files).toHaveLength(1);
    expect(res.binary).toBe('branded');
  });

  it('accepts it under the default, which is far above 4 KiB', SLOW, async () => {
    const input = secretOf(4096);
    const res = await runSave(saveOpts(input, tmp()));
    expect(res.binary).toBe('branded');
  });

  // The restore side bounds decompression of bytes an adversary may have written,
  // so its ceiling has to be reachable too.
  it('bounds a restore, and the caller can raise that as well', SLOW, async () => {
    const input = secretOf(4096);
    const vault = tmp();
    const saved = await runSave(saveOpts(input, vault));
    const container = saved.files[0]!;

    await expect(
      runRestore({ inputs: [container], outDir: tmp(), password: PW, maxBytes: 1024 }),
    ).rejects.toThrow();

    const restored = await runRestore({ inputs: [container], outDir: tmp(), password: PW });
    expect(restored.files).toHaveLength(1);
  });
});
