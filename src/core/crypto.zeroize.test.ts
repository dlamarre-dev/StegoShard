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

/**
 * Wipes of a given length, counted exactly.
 *
 * `toBeGreaterThan(0)` was the first form and it was too weak. `deriveContentKey`
 * wipes two 32-byte buffers, the raw DEK copy and the CEK bytes, so deleting
 * either one still left a wipe of that length behind and the assertion passed. A
 * targeted mutation run confirmed the CEK deletion survived. Counts are exact
 * here for that reason: the number is the assertion.
 */
const wiped = (len: number) => wipes.filter((n) => n === len).length;

describe('key material is zeroized after use (CRYPTO-REVIEW §3)', () => {
  it('wipes the transient raw KEK after importing it', async () => {
    await deriveKEK('correct horse battery staple', randomBytes(16), PARAMS);
    // Exactly one 32-byte wipe: the Argon2 output, imported non-extractable then
    // wiped. Argon2 itself allocates through the hash-wasm heap, not through a
    // Uint8Array this spy can see.
    expect(wiped(32), 'deriveKEK did not wipe exactly its raw KEK bytes').toBe(1);
  });

  it('wipes the transient raw DEK after importing it', async () => {
    await generateDEK();
    expect(wiped(DEK_LEN), 'generateDEK did not wipe exactly its raw DEK bytes').toBe(1);
  });

  it('wipes the exported DEK copy on the wrap path', async () => {
    const kek = await deriveKEK('pw', randomBytes(16), PARAMS);
    const dek = await generateDEK();
    wipes = [];
    await wrapDEK(dek, kek);
    expect(wiped(DEK_LEN), 'wrapDEK did not wipe the exported key copy').toBe(1);
  });

  it('wipes a copy, not the buffer exportKey returned', async () => {
    // The subtle half of the claim, and the first version of this test did not
    // check it. It asserted only that the key was still usable afterwards, which
    // passes on any conforming WebCrypto: the spec already says `exportKey`
    // returns a fresh ArrayBuffer, so removing `.slice(0)` would have gone
    // unnoticed on Node. The `.slice()` exists for runtimes that do not conform,
    // Deno among them per the comment in crypto.ts, where the returned buffer
    // still aliases the live key.
    //
    // So the buffer `exportKey` hands back is captured and inspected directly.
    // Without the slice, `view.fill(0)` would scribble on exactly this buffer.
    const kek = await deriveKEK('pw', randomBytes(16), PARAMS);
    const dek = await generateDEK();

    let exported: ArrayBuffer | null = null;
    const realExport = globalThis.crypto.subtle.exportKey.bind(globalThis.crypto.subtle);
    const exportSpy = vi
      .spyOn(globalThis.crypto.subtle, 'exportKey')
      .mockImplementation(async (...args: Parameters<typeof realExport>) => {
        const out = await realExport(...args);
        if (out instanceof ArrayBuffer && out.byteLength === DEK_LEN) exported = out;
        return out;
      });
    try {
      await wrapDEK(dek, kek);
    } finally {
      exportSpy.mockRestore();
    }

    expect(exported, 'exportKey was never called with a DEK-sized key').not.toBeNull();
    expect(
      new Uint8Array(exported!).some((b) => b !== 0),
      'wrapDEK zeroized the buffer exportKey returned, so a non-conforming runtime would lose the key',
    ).toBe(true);

    // And the key still works, which is the consequence that would follow.
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
    expect(wiped(DEK_LEN), 'unwrapDEK did not wipe the plaintext DEK').toBe(1);
  });

  it('wipes the transient CEK bytes after deriving the content key', async () => {
    const dek = await generateDEK();
    wipes = [];
    await deriveContentKey(dek, randomBytes(16));
    // Two, not one: the raw DEK copy and the CEK bytes, both 32 bytes. Asserting
    // "at least one" let either deletion pass, which is exactly what happened.
    expect(wiped(32), 'deriveContentKey wiped the wrong number of 32-byte buffers').toBe(2);
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
