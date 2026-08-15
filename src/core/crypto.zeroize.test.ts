/**
 * Key material is wiped after use, and nothing verified that until now.
 *
 * `docs/CRYPTO-REVIEW.md` §3 tells auditors three specific things: the transient
 * raw KEK is zeroized immediately after import in `deriveKEK`; the raw DEK is
 * zeroized on both the wrap and unwrap paths; and the wrap path zeroizes a
 * `.slice()` copy rather than the buffer `exportKey` returned, because a runtime
 * that aliased that buffer to the live key would otherwise see the wipe corrupt
 * the key.
 *
 * `src/core` performs 46 `fill(0)` calls in service of that. Not one was tested.
 * The first nightly mutation run showed what that means: deleting the calls
 * outright leaves the entire suite green, so the dossier described a behaviour
 * the code was free to stop having.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * The buffers are function-local, so a caller cannot inspect them. The spy goes
 * on `Uint8Array.prototype.fill` and records every wipe, which is exactly what
 * the mutant removes: delete the call and the test fails.
 *
 * It does not prove the memory becomes unreachable, and nothing in JavaScript
 * could. CRYPTO-REVIEW says `fill(0)` is best-effort, that the VM may have copied
 * buffers through GC compaction or the hash-wasm heap, and that remains true.
 * These tests move the claim from "documented" to "verified as written", which is
 * a smaller thing and the only honest one available.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  type Argon2Params,
  DEK_LEN,
  deriveContentKey,
  deriveKEK,
  exportDekRaw,
  generateDEK,
  randomBytes,
  unwrapDEK,
  wrapDEK,
} from './crypto';

const PARAMS: Argon2Params = { iterations: 1, memoryKiB: 256, parallelism: 1 };

/** Lengths of every buffer wiped with zero while the spy was installed. */
let wipes: number[] = [];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  wipes = [];
  const real = Uint8Array.prototype.fill;
  spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
    this: Uint8Array,
    ...args: unknown[]
  ) {
    // Only zero-fills count. Buffers are also filled with other values during
    // ordinary work, and counting those would make the assertions meaningless.
    if (args[0] === 0 && args.length === 1) wipes.push(this.length);
    return (real as (...a: unknown[]) => Uint8Array).apply(this, args);
  });
});

afterEach(() => spy.mockRestore());

/** Every wipe is asserted by length, since that is all a spy can see. */
const wiped = (len: number) => wipes.filter((n) => n === len).length;

describe('key material is zeroized after use (CRYPTO-REVIEW §3)', () => {
  it('wipes the transient raw KEK after importing it', async () => {
    await deriveKEK('correct horse battery staple', randomBytes(16), PARAMS);
    // 32 bytes: the Argon2 output, imported non-extractable and then wiped.
    expect(wiped(32), 'deriveKEK did not wipe its raw KEK bytes').toBeGreaterThan(0);
  });

  it('wipes the transient raw DEK after importing it', async () => {
    await generateDEK();
    expect(wiped(DEK_LEN), 'generateDEK did not wipe its raw DEK bytes').toBeGreaterThan(0);
  });

  it('wipes the exported DEK copy on the wrap path', async () => {
    const kek = await deriveKEK('pw', randomBytes(16), PARAMS);
    const dek = await generateDEK();
    wipes = [];
    await wrapDEK(dek, kek);
    expect(wiped(DEK_LEN), 'wrapDEK did not wipe the exported key copy').toBeGreaterThan(0);
  });

  it('leaves the wrapped key usable, so the wipe hit a copy and not the key', async () => {
    // The subtle half of the claim. If `wrapDEK` zeroized the buffer `exportKey`
    // handed back, on a runtime that aliases it to the live CryptoKey the key
    // itself would be destroyed. Encrypting after wrapping is what shows the
    // wipe landed on a copy.
    const kek = await deriveKEK('pw', randomBytes(16), PARAMS);
    const dek = await generateDEK();
    await wrapDEK(dek, kek);
    const raw = await exportDekRaw(dek);
    expect(raw.length).toBe(DEK_LEN);
    expect(
      raw.some((b) => b !== 0),
      'the DEK was zeroized along with its copy',
    ).toBe(true);
  });

  it('wipes the plaintext DEK on the unwrap path', async () => {
    const salt = randomBytes(16);
    const kek = await deriveKEK('pw', salt, PARAMS);
    const dek = await generateDEK();
    const { iv, wrapped } = await wrapDEK(dek, kek);
    wipes = [];
    await unwrapDEK(wrapped, iv, kek);
    expect(wiped(DEK_LEN), 'unwrapDEK did not wipe the plaintext DEK').toBeGreaterThan(0);
  });

  it('wipes the transient CEK bytes after deriving the content key', async () => {
    const dek = await generateDEK();
    wipes = [];
    await deriveContentKey(dek, randomBytes(16));
    expect(wiped(32), 'deriveContentKey did not wipe its raw CEK bytes').toBeGreaterThan(0);
  });

  it('the spy would notice a deleted wipe', async () => {
    // The instrument check. Every assertion above is "greater than zero", which a
    // spy that recorded nothing would fail rather than pass, but a spy that
    // recorded *everything* would satisfy them without measuring anything. This
    // pins that zero-fills are counted and other fills are not.
    const buf = new Uint8Array(999);
    wipes = [];
    buf.fill(7);
    expect(wiped(999), 'a non-zero fill was counted as a wipe').toBe(0);
    buf.fill(0);
    expect(wiped(999), 'a zero fill was not counted').toBe(1);
  });
});
