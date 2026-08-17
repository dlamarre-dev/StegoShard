/**
 * Two properties of the stego keystream that a code review turned up.
 *
 * The first is that exhaustion stays **loud**. When position selection runs past
 * the end of its keystream, that is a fault in the selection code, not a
 * condition a user provoked, and it must not be dressed up as something a caller
 * routinely handles.
 *
 * This was learned the hard way. A review pointed out that the previous test here
 * pinned the bare `stego: keystream exhausted` error, which codified a defect
 * rather than fixing it, and that was fair. The first fix converted the exhaustion
 * into a StegoCapacityError inside `pickPositions`, on the reasoning that draining
 * the stream does mean the cover cannot hold the payload at that density.
 *
 * Measuring it settled the question. Mutants in `StreamReader` and `pickPositions`
 * that had been caught *because* they drained the stream and threw something no
 * test expected now produced an error a test welcomed, and stego.ts fell from
 * 83.8% to 79.9% with fourteen new survivors. Converting an internal fault into an
 * expected refusal is the same mistake in a different coat, and mutation testing
 * is what made the difference visible rather than arguable.
 *
 * So the guard moved to the front instead: embedding defaults to a margin of 2,
 * measured to leave the stream about 45% headroom, and the capacity check refuses
 * anything denser before selection starts. Exhaustion is now unreachable at the
 * defaults, which is the point, and reachable only by a caller explicitly asking
 * for a margin the documentation does not support. That is what this file drives,
 * because an unreachable branch is also an untested one.
 *
 * The second property is that the two derived secrets are wiped. Same technique
 * and same honest limits as `crypto.zeroize.test.ts`: the spy proves the call
 * happens, not that the memory becomes unreachable.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  type Argon2Params,
  createKeyBlock,
  embedBytesStegoRgba,
  embedKeyBlockStego,
  extractKeyBlockStego,
  serializeKeyBlock,
} from './index';

const SEED = new Uint8Array(32).fill(7);
const FAST: Argon2Params = { iterations: 1, memoryKiB: 64, parallelism: 1 };
const W = 32;
const H = 32;
const CAPACITY = W * H * 3;

async function keyBlockBytes(password: string): Promise<Uint8Array> {
  const { block } = await createKeyBlock(password, FAST);
  return serializeKeyBlock(block);
}

/** A cover with room for the 92-byte key block at its 16x sparsity floor. */
function makeRgbaCover(): Uint8Array {
  const w = 128;
  const rgba = new Uint8Array(w * w * 4);
  let s = 1234;
  for (let p = 0; p < w * w; p++) {
    for (let c = 0; c < 3; c++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      rgba[p * 4 + c] = (s >>> 24) & 0xff;
    }
    rgba[p * 4 + 3] = 255;
  }
  return rgba;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('keystream exhaustion is a fault signal, not a refusal', () => {
  it('escapes as a plain error when a caller forces an unsupported margin', async () => {
    // Margin 1 at full capacity: the capacity guard lets it through and selection
    // cannot place the positions, because filling a cover needs about N·ln(N)
    // draws while the stream supplies 2N+1024.
    //
    // The assertion is deliberately about what this is *not*. A StegoCapacityError
    // here would mean the conversion came back, and with it the fourteen mutants
    // it hid.
    const rgba = new Uint8Array(W * H * 4).fill(128);
    const fills = new Uint8Array(CAPACITY / 8);

    const err = await embedBytesStegoRgba(rgba, W, H, fills, SEED, 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('KeystreamExhausted');
    expect((err as Error).message).toContain('keystream exhausted');
    expect(
      (err as Error).name,
      'exhaustion is being reported as a capacity refusal again, which hides selection bugs',
    ).not.toBe('StegoCapacityError');
  });

  it('does not fire at the supported margin, which is why the default moved', async () => {
    // The other side. At the default the guard refuses first, with the typed
    // error a caller can act on, and selection is never reached.
    const rgba = new Uint8Array(W * H * 4).fill(128);
    const fills = new Uint8Array(CAPACITY / 8);

    await expect(embedBytesStegoRgba(rgba, W, H, fills, SEED)).rejects.toMatchObject({
      name: 'StegoCapacityError',
    });
  });
});

describe('the derived stego secrets are wiped after use', () => {
  // `keystream()` is the Argon2 path, used by the fixed key-block functions
  // only. The byte helpers above take a seed the caller already has and go
  // straight to `keystreamFromSeed`, so they never derive these two secrets and
  // never wipe them. A first version of these tests drove the byte helpers and
  // measured zero wipes, which was the tests looking in the wrong place rather
  // than a missing wipe.

  /** Record the length of every `fill(0)` while `run` executes. */
  async function wipesDuring(run: () => Promise<unknown>): Promise<number[]> {
    const seen: number[] = [];
    const real = Uint8Array.prototype.fill;
    const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
      this: Uint8Array,
      ...args: Parameters<typeof real>
    ) {
      if (args[0] === 0 && args.length === 1) seen.push(this.length);
      return real.apply(this, args) as Uint8Array;
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return seen;
  }

  it('zeroizes both the Argon2 seed and the per-cover key when embedding a key block', async () => {
    // Two 32-byte wipes per derivation: the Argon2 seed once the cover key is
    // folded out of it, then the cover key once the stream is generated.
    // Counted rather than merely required to be non-zero, so deleting one of the
    // two still fails.
    const kb = await keyBlockBytes('pw');
    const rgba = makeRgbaCover();

    const wipes = await wipesDuring(() => embedKeyBlockStego(rgba, 128, 128, kb, 'pw', FAST));

    const thirtyTwos = wipes.filter((n) => n === 32).length;
    expect(thirtyTwos, `expected the seed and the cover key to be wiped, saw ${thirtyTwos}`).toBe(
      2,
    );
  });

  it('zeroizes them on the extract path too, not only on embed', async () => {
    const kb = await keyBlockBytes('pw');
    const rgba = makeRgbaCover();
    await embedKeyBlockStego(rgba, 128, 128, kb, 'pw', FAST);

    let out: Uint8Array | null = null;
    const wipes = await wipesDuring(async () => {
      out = await extractKeyBlockStego(rgba, 128, 128, 'pw', FAST);
    });

    expect(out, 'the fixture stopped round-tripping, so this measured nothing').not.toBeNull();
    expect(wipes.filter((n) => n === 32).length).toBe(2);
  });
});
