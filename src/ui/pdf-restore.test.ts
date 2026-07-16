/**
 * PDF extraction round-trip: a QR image embedded in a PDF (the way paper mode
 * embeds it, and the way scanners do with JPEG) must come back out and decode
 * to the exact payload. Runs under Node — only the pure extraction layer is
 * exercised (no canvas).
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import {
  CODEC_QR_GRID,
  PROFILE_PAPER,
  createKeyBlock,
  encodeImagePayload,
  exportVault,
  getCodec,
  importVault,
  serializeKeyBlock,
} from '@core';
import type { Header } from '@core';
import { extractPdfImages } from './pdf-restore';

const codec = getCodec(CODEC_QR_GRID);

// QR encode/decode of full pages is CPU-heavy and runs several times slower
// under CI coverage instrumentation than locally — give these tests headroom.
const SLOW = { timeout: 60_000 };

function makePayload(len: number): Uint8Array {
  const header: Header = {
    version: 1,
    setId: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    shardIndex: 0,
    k: 1,
    m: 0,
    codecId: CODEC_QR_GRID,
    profile: PROFILE_PAPER,
    shardLen: len,
    blobLen: len,
    hash: Uint8Array.from([9, 9, 9, 9]),
  };
  let s = 42;
  const shard = Uint8Array.from({ length: len }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  });
  return encodeImagePayload(header, shard);
}

function toPngBytes(img: { data: Uint8ClampedArray; width: number; height: number }): Uint8Array {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return new Uint8Array(PNG.sync.write(png));
}

describe('extractPdfImages', () => {
  it('round-trips a paper-profile QR through an embedded PNG (our own PDFs)', SLOW, async () => {
    const payload = makePayload(500);
    const img = codec.encode(payload, PROFILE_PAPER);

    const pdf = await PDFDocument.create();
    const png = await pdf.embedPng(toPngBytes(img));
    const page = pdf.addPage([595, 842]);
    page.drawImage(png, { x: 40, y: 200, width: 515, height: 515 });
    const bytes = await pdf.save();

    const images = await extractPdfImages(new Uint8Array(bytes));
    const decoded: Uint8Array[] = [];
    for (const image of images) {
      if (image.kind !== 'pixels') continue;
      try {
        decoded.push(codec.decode(image.img));
      } catch {
        // e.g. the alpha SMask that pdf-lib splits off — not a QR, skipped.
      }
    }
    expect(decoded.length).toBe(1);
    expect([...decoded[0]!]).toEqual([...payload]);
  });

  it(
    'surfaces DCTDecode streams as JPEG bytes that still decode (scanner PDFs)',
    SLOW,
    async () => {
      const payload = makePayload(400);
      const img = codec.encode(payload, PROFILE_PAPER);
      const jpg = jpeg.encode(
        {
          data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
          width: img.width,
          height: img.height,
        },
        92,
      );

      const pdf = await PDFDocument.create();
      const embedded = await pdf.embedJpg(new Uint8Array(jpg.data));
      const page = pdf.addPage([595, 842]);
      page.drawImage(embedded, { x: 40, y: 200, width: 515, height: 515 });
      const bytes = await pdf.save();

      const images = await extractPdfImages(new Uint8Array(bytes));
      const jpegs = images.filter((i) => i.kind === 'jpeg');
      expect(jpegs.length).toBe(1);

      // Prove the extracted JPEG still holds the payload (browser code hands
      // these bytes to decodeImageBytes; here we decode with jpeg-js directly).
      const raw = jpeg.decode(jpegs[0]!.kind === 'jpeg' ? jpegs[0]!.bytes : new Uint8Array(), {
        useTArray: true,
        formatAsRGBA: true,
      });
      const decoded = codec.decode({
        data: new Uint8ClampedArray(raw.data),
        width: raw.width,
        height: raw.height,
      });
      expect([...decoded]).toEqual([...payload]);
    },
  );

  it('rejects a non-PDF outright and skips undersized images', SLOW, async () => {
    await expect(extractPdfImages(new Uint8Array(64))).rejects.toBeTruthy();

    const pdf = await PDFDocument.create();
    const tiny = new PNG({ width: 4, height: 4 });
    tiny.data = Buffer.alloc(4 * 4 * 4, 255);
    const png = await pdf.embedPng(new Uint8Array(PNG.sync.write(tiny)));
    const page = pdf.addPage([100, 100]);
    page.drawImage(png, { x: 0, y: 0, width: 4, height: 4 });
    const images = await extractPdfImages(new Uint8Array(await pdf.save()));
    expect(images.filter((i) => i.kind === 'pixels').length).toBe(0);
  });
});

describe('end-to-end: full vault through a PDF', () => {
  it(
    'exports a multi-page vault, embeds each page, and importVault restores it',
    SLOW,
    async () => {
      const { dek, block } = await createKeyBlock('paper pw', {
        iterations: 1,
        memoryKiB: 64,
        parallelism: 1,
      });
      const key = { dek, keyBlock: serializeKeyBlock(block) };
      let s = 7;
      const content = Uint8Array.from({ length: 1500 }, () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return (s >>> 24) & 0xff;
      });
      const { imagePayloads } = await exportVault('deed.bin', content, key, {
        profile: PROFILE_PAPER,
      });
      expect(imagePayloads.length).toBeGreaterThan(1);

      // Build the PDF the same way paper mode does: one embedded PNG per page.
      const pdf = await PDFDocument.create();
      for (const payload of imagePayloads) {
        const img = codec.encode(payload, PROFILE_PAPER);
        const png = await pdf.embedPng(toPngBytes(img));
        const page = pdf.addPage([595, 842]);
        page.drawImage(png, { x: 40, y: 200, width: 515, height: 515 });
      }
      const bytes = new Uint8Array(await pdf.save());

      // Extraction + decode, exactly what extractPdfPayloads does in the browser.
      const payloads: Uint8Array[] = [];
      for (const image of await extractPdfImages(bytes)) {
        if (image.kind !== 'pixels') continue;
        try {
          payloads.push(codec.decode(image.img));
        } catch {
          // SMask / non-QR image — skipped.
        }
      }
      expect(payloads.length).toBe(imagePayloads.length);

      const out = await importVault(payloads, 'paper pw');
      expect(out.filename).toBe('deed.bin');
      expect([...out.content]).toEqual([...content]);
    },
  );
});
