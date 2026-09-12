/**
 * The cover-reuse guard.
 *
 * Two of these matter more than the rest. "Refuses a second payload" is the
 * feature; "allows the same cover under a different password" is the one that
 * catches the wrong implementation — keying the guard on the cover fingerprint
 * alone would pass the first and fail the second, while refusing an operation
 * that is perfectly safe (a different password derives an independent seed, pad
 * and layout, so there is no two-time pad to leak).
 */

import { beforeEach, describe, it, expect } from 'vitest';
import {
  type Argon2Params,
  StegoCapacityError,
  StegoCoverReuseError,
  embedKeyBlockStego,
  embedKeyBlockStegoJpeg,
  embedKeyFactorStego,
  embedKeyFactorStegoJpeg,
  extractKeyBlockStego,
  resetStegoCoverGuard,
  type CoverClaim,
  stegoErrorCode,
  stegoErrorFromWire,
  stegoErrorToWire,
  createKeyBlock,
  serializeKeyBlock,
} from '.';
import jpeg from 'jpeg-js';

const FAST: Argon2Params = { iterations: 1, memoryKiB: 64, parallelism: 1 };
const PW = 'a cover reuse guard passphrase';
const W = 128;
const H = 128;

beforeEach(resetStegoCoverGuard);

/** Deterministic noise, so two calls with one seed are the same cover content. */
function makeCover(seed: number): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < rgba.length; i += 4) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    rgba[i] = x & 0xff;
    rgba[i + 1] = (x >> 8) & 0xff;
    rgba[i + 2] = (x >> 16) & 0xff;
    rgba[i + 3] = 255;
  }
  return rgba;
}

async function keyBlock(password: string): Promise<Uint8Array> {
  const { block } = await createKeyBlock(password, FAST);
  return serializeKeyBlock(block);
}

/** A baseline JPEG cover, built the same way stego.binding.test.ts builds one. */
function makeJpeg(seed: number, width = 96, height = 96): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  let x = seed >>> 0 || 1;
  for (let p = 0; p < width * height; p++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    data[p * 4] = (x >>> 24) & 0xff;
    data[p * 4 + 1] = (x >>> 16) & 0xff;
    data[p * 4 + 2] = (x >>> 8) & 0xff;
    data[p * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width, height }, 80).data);
}

describe('a cover carries one payload per password', () => {
  it('refuses a second, different payload (RGBA)', async () => {
    const a = makeCover(11);
    const b = makeCover(11); // an identical copy, not a different photo
    await embedKeyBlockStego(a, W, H, await keyBlock(PW), PW, FAST);
    await expect(
      embedKeyBlockStego(b, W, H, await keyBlock('another vault entirely'), PW, FAST),
    ).rejects.toThrow(StegoCoverReuseError);
  });

  it('leaves the refused cover untouched', async () => {
    // The check runs before the first mutation, so a refusal must not have
    // written anything: a half-embedded cover would be the worst outcome of all.
    const a = makeCover(12);
    const b = makeCover(12);
    const pristine = b.slice();
    await embedKeyBlockStego(a, W, H, await keyBlock(PW), PW, FAST);
    await expect(embedKeyBlockStego(b, W, H, await keyBlock('second'), PW, FAST)).rejects.toThrow(
      StegoCoverReuseError,
    );
    expect([...b]).toEqual([...pristine]);
  });
});

describe('the JPEG carrier is guarded on the same terms', () => {
  it('refuses a second, different payload and allows a different password', async () => {
    // The JPEG path has its own embed function and its own fingerprint domain, so
    // it needs its own assertion rather than inheriting the RGBA one.
    const a = makeJpeg(31);
    await embedKeyBlockStegoJpeg(a, await keyBlock(PW), PW, FAST);
    await expect(embedKeyBlockStegoJpeg(a, await keyBlock('second'), PW, FAST)).rejects.toThrow(
      StegoCoverReuseError,
    );
    await expect(
      embedKeyBlockStegoJpeg(a, await keyBlock('other'), 'a different password', FAST),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('treats a JPEG and an RGBA cover as two covers', async () => {
    // Different fingerprint domains derive independent keys, so using both is not
    // reuse. SPEC §5.4 states this, and scripts/gen-stego-samples.ts relies on it.
    const rgba = makeCover(32);
    const jpg = makeJpeg(32);
    await embedKeyBlockStego(rgba, W, H, await keyBlock(PW), PW, FAST);
    await expect(
      embedKeyBlockStegoJpeg(jpg, await keyBlock('x'), PW, FAST),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe('what it must NOT refuse', () => {
  it('allows the same cover under a different password', async () => {
    // The regression test for keying the guard wrongly. A different password
    // means a different Argon2 seed, so pad and layout are independent and there
    // is nothing to leak. Refusing this would break a legitimate workflow.
    const a = makeCover(13);
    const b = makeCover(13);
    await embedKeyBlockStego(a, W, H, await keyBlock(PW), PW, FAST);
    await expect(
      embedKeyBlockStego(
        b,
        W,
        H,
        await keyBlock('a different password'),
        'a different password',
        FAST,
      ),
    ).resolves.toBeUndefined();
  });

  it('allows the same cover under different Argon2 parameters', async () => {
    // Also an independent keystream, and the guard gets this right for free by
    // keying on the derived key rather than on (fingerprint, password).
    const slower: Argon2Params = { iterations: 2, memoryKiB: 64, parallelism: 1 };
    const a = makeCover(14);
    const b = makeCover(14);
    await embedKeyBlockStego(a, W, H, await keyBlock(PW), PW, FAST);
    await expect(
      embedKeyBlockStego(b, W, H, await keyBlock('x'), PW, slower),
    ).resolves.toBeUndefined();
  });

  it('allows a byte-identical re-embed, and changes nothing', async () => {
    // Provably a no-op: the fingerprint is invariant under embedding, so the
    // second write moves no carrier and produces no second artifact to compare.
    // Refusing it would be theatre and would break retry tolerance.
    const kb = await keyBlock(PW);
    const a = makeCover(15);
    await embedKeyBlockStego(a, W, H, kb, PW, FAST);
    const after = a.slice();
    await expect(embedKeyBlockStego(a, W, H, kb, PW, FAST)).resolves.toBeUndefined();
    expect([...a]).toEqual([...after]);
  });

  it('allows different covers under one password', async () => {
    const a = makeCover(16);
    const b = makeCover(17);
    await embedKeyBlockStego(a, W, H, await keyBlock(PW), PW, FAST);
    await expect(
      embedKeyBlockStego(b, W, H, await keyBlock('y'), PW, FAST),
    ).resolves.toBeUndefined();
  });

  it('never guards extraction, and extraction never records', async () => {
    // A reader cannot know how a carrier was produced, and refusing to read would
    // deny recovery. Extracting twice must also leave the guard empty, or the
    // next legitimate embed into that cover would be refused.
    const kb = await keyBlock(PW);
    const a = makeCover(18);
    await embedKeyBlockStego(a, W, H, kb, PW, FAST);
    resetStegoCoverGuard();
    await extractKeyBlockStego(a, W, H, PW, FAST);
    await extractKeyBlockStego(a, W, H, PW, FAST);
    // Nothing was recorded, so this embed is the first the guard has seen.
    await expect(embedKeyBlockStego(a, W, H, kb, PW, FAST)).resolves.toBeUndefined();
  });
});

describe('a failed embed does not poison the cover', () => {
  it('lets a retry succeed after a capacity failure', async () => {
    // The tag is recorded only after the write succeeds. If it were recorded up
    // front, a cover that was merely too small would be refused for the rest of
    // the session, which is a worse failure than the one being prevented.
    const tiny = new Uint8Array(8 * 8 * 4);
    await expect(embedKeyBlockStego(tiny, 8, 8, await keyBlock(PW), PW, FAST)).rejects.toThrow(
      StegoCapacityError,
    );
    const ok = makeCover(19);
    await expect(
      embedKeyBlockStego(ok, W, H, await keyBlock(PW), PW, FAST),
    ).resolves.toBeUndefined();
  });
});

describe('the override, and the error', () => {
  it('proceeds when the caller says so', async () => {
    const a = makeCover(20);
    const b = makeCover(20);
    await embedKeyBlockStego(a, W, H, await keyBlock(PW), PW, FAST);
    await expect(
      embedKeyBlockStego(b, W, H, await keyBlock('z'), PW, FAST, { allowCoverReuse: true }),
    ).resolves.toBeUndefined();
  });

  it('carries its code, survives the worker boundary, and leaks no details', async () => {
    const err = new StegoCoverReuseError();
    expect(stegoErrorCode(err)).toBe('STEGO_COVER_REUSE');
    const revived = stegoErrorFromWire(stegoErrorToWire(err));
    expect(revived).toBeInstanceOf(StegoCoverReuseError);
    // No fingerprint, no filename: either would be a machine-readable identifier
    // of a stego cover in a --json envelope or an MCP result, which is the
    // durable trace this design exists to avoid creating.
    expect(stegoErrorToWire(err).details).toBeUndefined();
    expect(err.message).not.toMatch(/[0-9a-f]{8}/);
  });
});

describe('a claim is owned by the call that made it', () => {
  /** Capture the claim an embed makes, the way the orchestration layer does. */
  async function embedHolding(cover: Uint8Array, kb: Uint8Array): Promise<CoverClaim> {
    let claim: CoverClaim | undefined;
    await embedKeyBlockStego(cover, W, H, kb, PW, FAST, {
      onClaim: (c) => {
        claim = c;
      },
    });
    if (!claim) throw new Error('no claim handed back');
    return claim;
  }

  it('is dropped when the artifact never reaches disk', async () => {
    // The reported bug. `externalKey` embeds well before `writeOut` runs, so a
    // save that fails afterwards would otherwise leave the cover claimed for a
    // payload that never landed and refuse the retry. There is no leak in that
    // case: a leak needs two artifacts to compare, and only one was written.
    const claim = await embedHolding(makeCover(41), await keyBlock(PW));
    claim.release();
    await expect(
      embedKeyBlockStego(makeCover(41), W, H, await keyBlock('the retry'), PW, FAST),
    ).resolves.toBeUndefined();
  });

  it('stands when the artifact landed, even if the save fails later', async () => {
    // The other direction, and the more dangerous one. A save writes
    // incrementally: if the stego image is on disk and a LATER write fails,
    // releasing would let a retry mint a second artifact from one cover under one
    // password -- the exact leak SPEC §5.3 forbids.
    await embedHolding(makeCover(42), await keyBlock(PW));
    await expect(
      embedKeyBlockStego(makeCover(42), W, H, await keyBlock('second'), PW, FAST),
    ).rejects.toThrow(StegoCoverReuseError);
  });

  it("does not let one call release another call's claim", async () => {
    // Two claims on two different covers; releasing one must not touch the other.
    // An earlier design kept a single realm-wide set of unconfirmed claims, so a
    // failure in one save released a concurrent save's claims too.
    const first = await embedHolding(makeCover(45), await keyBlock(PW));
    await embedHolding(makeCover(46), await keyBlock(PW));
    first.release();
    await expect(
      embedKeyBlockStego(makeCover(45), W, H, await keyBlock('a'), PW, FAST),
    ).resolves.toBeUndefined();
    await expect(
      embedKeyBlockStego(makeCover(46), W, H, await keyBlock('b'), PW, FAST),
    ).rejects.toThrow(StegoCoverReuseError);
  });

  it('restores the displaced claim rather than deleting it', async () => {
    // THE regression test for this guard, and it was missing until a review asked
    // for it. `used` holds one entry per cover, so a release that deletes drops
    // whatever claim the releasing call overwrote -- and a call can legitimately
    // overwrite one, with `allowCoverReuse` or with a byte-identical payload.
    //
    // Save 1 lands and claims the cover. Save 2 overrides, embeds a different
    // payload, then fails before writing and releases. If release deletes, save 3
    // is accepted and there are now two artifacts from one cover under one
    // password: the §5.3 leak, re-opened by the mechanism meant to prevent a false
    // refusal. Reverting release to an unconditional delete must fail this test.
    await embedKeyBlockStego(makeCover(60), W, H, await keyBlock('one'), PW, FAST);

    let second: CoverClaim | undefined;
    await embedKeyBlockStego(makeCover(60), W, H, await keyBlock('two'), PW, FAST, {
      allowCoverReuse: true,
      onClaim: (c) => {
        second = c;
      },
    });
    second!.release(); // save 2 failed before its artifact landed

    await expect(
      embedKeyBlockStego(makeCover(60), W, H, await keyBlock('three'), PW, FAST),
      'the first, landed claim was dropped when the second was released',
    ).rejects.toThrow(StegoCoverReuseError);
  });

  it('lets the owner of the only claim release it completely', async () => {
    // The other half: when there was nothing to displace, release must remove the
    // entry outright, or a failed first save would burn the cover forever.
    let only: CoverClaim | undefined;
    await embedKeyBlockStego(makeCover(61), W, H, await keyBlock('a'), PW, FAST, {
      onClaim: (c) => {
        only = c;
      },
    });
    only!.release();
    await expect(
      embedKeyBlockStego(makeCover(61), W, H, await keyBlock('b'), PW, FAST),
    ).resolves.toBeUndefined();
  });

  it('is inert once the cover has been re-claimed by someone else', async () => {
    // `release` removes the entry only if it is still exactly what this call
    // wrote. Otherwise a stale handle could drop a claim it no longer owns.
    const stale = await embedHolding(makeCover(47), await keyBlock(PW));
    await embedKeyBlockStego(makeCover(47), W, H, await keyBlock('newer'), PW, FAST, {
      allowCoverReuse: true,
    });
    stale.release();
    await expect(
      embedKeyBlockStego(makeCover(47), W, H, await keyBlock('third'), PW, FAST),
    ).rejects.toThrow(StegoCoverReuseError);
  });

  it('reports capacity, not reuse, on a cover that IS already claimed (RGBA)', async () => {
    // A test that actually bites, unlike the two it replaces.
    //
    // Those used a tiny cover whose fingerprint differed from the claimed one, so
    // it derived a different guard tag and could never have reached the reuse
    // branch no matter which order the checks ran in. Inverting the order left
    // them green.
    //
    // 45x45 gives 45*45*3 = 6075 carrier bits: enough for the 37-byte key factor
    // (37*8*16 = 4736) and not for the 92-byte key block (92*8*16 = 11776). So the
    // SAME cover under the SAME password can be claimed by the factor and then
    // fail on capacity for the block -- same fingerprint, same tag, different
    // payload. If the reuse check ran first this would throw StegoCoverReuseError.
    const side = 45;
    const cover = new Uint8Array(side * side * 4);
    let x = 77;
    for (let i = 0; i < cover.length; i += 4) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      cover[i] = x & 0xff;
      cover[i + 1] = (x >> 8) & 0xff;
      cover[i + 2] = (x >> 16) & 0xff;
      cover[i + 3] = 255;
    }
    const claimed = cover.slice();
    await embedKeyFactorStego(claimed, side, side, new Uint8Array(32).fill(7), PW, FAST);
    await expect(
      embedKeyBlockStego(claimed, side, side, await keyBlock(PW), PW, FAST),
    ).rejects.toThrow(StegoCapacityError);
  });

  it('reports capacity, not reuse, on a JPEG cover that IS already claimed', async () => {
    // The JPEG path checks capacity per branch, after the tag is derived, so its
    // ordering is genuinely separate -- and it was inverted until a review caught
    // it. Same construction: claim with the 37-byte factor, then ask the same
    // cover for the 92-byte block it cannot hold.
    //
    // 32x32 is the window, measured rather than guessed: it yields 1125 eligible
    // AC coefficients, above the factor's 37*8*2 = 592 and below the block's
    // 92*8*2 = 1472. At 64x64 there are 4387 and the block fits, so the reuse
    // branch fires instead -- correct behaviour, but it tests nothing about order.
    const cover = makeJpeg(53, 32, 32);
    const claimed = await embedKeyFactorStegoJpeg(cover, new Uint8Array(32).fill(9), PW, FAST);
    await expect(embedKeyBlockStegoJpeg(claimed, await keyBlock(PW), PW, FAST)).rejects.toThrow(
      StegoCapacityError,
    );
  });
});

describe('the guard forgets rather than growing without bound', () => {
  it('clears on reset', async () => {
    const a = makeCover(21);
    const b = makeCover(21);
    await embedKeyBlockStego(a, W, H, await keyBlock(PW), PW, FAST);
    resetStegoCoverGuard();
    await expect(
      embedKeyBlockStego(b, W, H, await keyBlock('w'), PW, FAST),
    ).resolves.toBeUndefined();
  });
});
