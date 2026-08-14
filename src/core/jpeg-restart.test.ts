/**
 * JPEG files with restart intervals, which nothing in this repository exercised.
 *
 * Every JPEG the suite saw was synthesised by `jpeg-js`, which emits 4:4:4
 * baseline with three components and no DRI segment. The 23 `.jpg` files in the
 * repository are all SOF0 and none carries a `0xDD` marker. So four independent
 * code paths were dead in CI:
 *
 *   - the DRI parse (jpeg-coeff.ts)
 *   - the restart consumption in decodeScan, and BitReader.consumeRestart
 *   - the RSTn emission in encode
 *   - the `0xd0..0xd7` leg of findScanEnd
 *
 * And with them the whole reason stego.ts carries a full re-encode fallback: it
 * runs only when `restartInterval > 0`, so that branch had never executed.
 *
 * Restart markers are not exotic. Many camera and scanner JPEGs use them, since
 * they let a decoder resynchronise after a corrupt run. A user handing the app a
 * photo straight off a Canon body was reaching code no test had ever run.
 *
 * Building the fixture rather than committing one keeps its construction
 * readable: a jpeg-js baseline file, a DRI segment spliced in before the scan,
 * then re-encoded through this project's own encoder, which emits the RSTn
 * markers from `model.restartInterval`.
 */

import { describe, it, expect } from 'vitest';
import jpeg from 'jpeg-js';
import { decode, encode } from './jpeg-coeff';

function baseJpeg(width: number, height: number, quality = 80, seed = 1): Uint8Array {
  const data = Buffer.alloc(width * height * 4);
  let s = seed >>> 0;
  for (let i = 0; i < width * height; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = (i * 9) & 0xff;
    data[i * 4 + 1] = (i * 5) & 0xff;
    data[i * 4 + 2] = (s >>> 24) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width, height }, quality).data);
}

/** Splice `FFDD 0004 <interval>` in just before the SOS marker. */
function insertDri(bytes: Uint8Array, interval: number): Uint8Array {
  let o = 2;
  while (o < bytes.length - 1) {
    if (bytes[o] !== 0xff) throw new Error('lost marker alignment building the fixture');
    const marker = bytes[o + 1]!;
    if (marker === 0xda) break; // SOS
    o += 2 + ((bytes[o + 2]! << 8) | bytes[o + 3]!);
  }
  const dri = Uint8Array.of(0xff, 0xdd, 0x00, 0x04, (interval >> 8) & 0xff, interval & 0xff);
  const out = new Uint8Array(bytes.length + dri.length);
  out.set(bytes.subarray(0, o), 0);
  out.set(dri, o);
  out.set(bytes.subarray(o), o + dri.length);
  return out;
}

/**
 * A JPEG that genuinely carries restart markers: the DRI segment in the header
 * and RSTn markers in the entropy stream, written by this project's encoder.
 *
 * The order matters and is not the obvious one. Splicing the DRI segment in
 * first produces a file the decoder is right to refuse: it is told to expect a
 * marker every N MCUs, finds none, and desynchronises into "bad Huffman code in
 * scan". So the markers are written first, by setting `restartInterval` on a
 * model decoded from a plain file and re-encoding, and the header segment is
 * spliced into that output afterwards.
 */
function jpegWithRestarts(interval: number, width = 64, height = 64): Uint8Array {
  const model = decode(baseJpeg(width, height));
  model.restartInterval = interval; // makes encode() emit RSTn
  return insertDri(encode(model), interval);
}

function coefficients(model: ReturnType<typeof decode>): number[] {
  const out: number[] = [];
  for (const c of model.components) for (const b of c.blocks) out.push(...b);
  return out;
}

describe('JPEG restart intervals', () => {
  it('parses the DRI segment', () => {
    expect(decode(jpegWithRestarts(4)).restartInterval).toBe(4);
  });

  it('refuses a DRI segment whose markers are not in the scan', () => {
    // Worth pinning, because it is what made building this fixture awkward and
    // it is the right behaviour: a file claiming restarts that its entropy data
    // does not contain is inconsistent, and the decoder desynchronises rather
    // than inventing coefficients.
    expect(() => decode(insertDri(baseJpeg(64, 64), 4))).toThrow();
  });

  it('leaves restartInterval at zero when there is no DRI segment', () => {
    // The other half. A parser that reported a restart interval on every file
    // would satisfy the test above and be wrong about every real photo.
    expect(decode(baseJpeg(64, 64)).restartInterval).toBe(0);
  });

  for (const interval of [1, 2, 8]) {
    it(`round-trips a file with restart interval ${interval}`, () => {
      // The full loop: DRI parsed, RSTn emitted on encode, RSTn consumed and the
      // DC predictor reset on decode. Coefficients must survive all of it.
      const original = decode(baseJpeg(64, 64));
      const rebuilt = decode(jpegWithRestarts(interval));
      expect(rebuilt.restartInterval).toBe(interval);
      expect(coefficients(rebuilt)).toEqual(coefficients(original));
    });
  }

  it('actually writes RSTn markers into the entropy stream', () => {
    // Without this, an encoder that silently dropped the markers would still
    // pass the round-trip above, because a decoder reading a stream with no
    // restarts and a predictor never reset produces the same coefficients only
    // if the encoder also never reset it. Assert the bytes.
    const bytes = jpegWithRestarts(2);
    const model = decode(bytes);
    let found = 0;
    for (let i = model.scanStart; i < model.scanEnd - 1; i++) {
      if (bytes[i] === 0xff && bytes[i + 1]! >= 0xd0 && bytes[i + 1]! <= 0xd7) found++;
    }
    expect(found, 'no RSTn markers in the re-encoded scan').toBeGreaterThan(0);
  });

  it('cycles the restart marker through RST0..RST7 and wraps', () => {
    // The `rstn = (rstn + 1) & 7` wrap. A file with interval 1 on a 64x64 image
    // has 64 MCUs, so the counter wraps seven times.
    const bytes = jpegWithRestarts(1);
    const model = decode(bytes);
    const seen = new Set<number>();
    for (let i = model.scanStart; i < model.scanEnd - 1; i++) {
      if (bytes[i] === 0xff && bytes[i + 1]! >= 0xd0 && bytes[i + 1]! <= 0xd7) {
        seen.add(bytes[i + 1]!);
      }
    }
    expect(seen.size, `only saw markers ${[...seen].map((m) => m.toString(16))}`).toBe(8);
  });

  it('finds the end of a scan that contains restart markers', () => {
    // findScanEnd has to step over RSTn rather than treat one as the end of the
    // entropy data. If it stopped at the first, scanEnd would land early and the
    // coefficients after it would be lost.
    const bytes = jpegWithRestarts(2);
    const model = decode(bytes);
    // The scan must run to the EOI, not stop at the first restart marker.
    expect(bytes[model.scanEnd]).toBe(0xff);
    expect(bytes[model.scanEnd + 1]).toBe(0xd9); // EOI
  });
});

describe('stego on a JPEG with restart intervals', () => {
  /**
   * The fallback that had never run.
   *
   * `stego.ts` embeds by toggling bits in the entropy stream in place when
   * `restartInterval === 0`, and falls back to a full re-encode of the scan when
   * it is not. Every JPEG the suite had was restart-free, so that fallback was
   * dead in CI, and the encoder path it depends on was broken: restart markers
   * were written through the bit writer, whose byte-stuffing turned `FF D0` into
   * `FF 00 D0`. A user embedding into a camera JPEG that uses restart intervals
   * would have got a file no decoder could read.
   */
  it('embeds and recovers a key block through the re-encode fallback', async () => {
    const { createKeyBlock, serializeKeyBlock } = await import('./crypto');
    const { embedKeyBlockStegoJpeg, extractKeyBlockStegoJpeg } = await import('./stego');
    const fast = { iterations: 1, memoryKiB: 8, parallelism: 1 } as const;

    // Large enough to carry a 92-byte key block: 736 bits need eligible AC
    // coefficients, so a 64x64 image is not sufficient.
    const cover = jpegWithRestarts(4, 256, 256);
    expect(decode(cover).restartInterval).toBe(4); // the fallback's trigger

    const block = serializeKeyBlock((await createKeyBlock('pw', fast)).block);
    const stego = await embedKeyBlockStegoJpeg(cover, block, 'pw', fast);

    // The carrier is still a decodable JPEG that kept its restart interval.
    expect(decode(stego).restartInterval).toBe(4);

    const recovered = await extractKeyBlockStegoJpeg(stego, 'pw', fast);
    expect(recovered).not.toBeNull();
    expect([...recovered!]).toEqual([...block]);
  });

  it('finds nothing under a wrong password, as on any other cover', async () => {
    const { createKeyBlock, serializeKeyBlock } = await import('./crypto');
    const { embedKeyBlockStegoJpeg, extractKeyBlockStegoJpeg } = await import('./stego');
    const fast = { iterations: 1, memoryKiB: 8, parallelism: 1 } as const;
    const block = serializeKeyBlock((await createKeyBlock('pw', fast)).block);
    const stego = await embedKeyBlockStegoJpeg(jpegWithRestarts(4, 256, 256), block, 'pw', fast);
    expect(await extractKeyBlockStegoJpeg(stego, 'wrong', fast)).toBeNull();
  });
});
