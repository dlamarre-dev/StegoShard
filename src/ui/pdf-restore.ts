/**
 * Restore-from-PDF: pull the QR images back out of a PDF and decode them.
 *
 * Covers the PDFs StegoShard's paper mode generates (FlateDecode RGB/Gray
 * image XObjects) plus the common scanner output (DCTDecode = plain JPEG).
 * Anything else (exotic color spaces, JBIG2, CCITT) is skipped — a lost page
 * is tolerated by the erasure coding, and foreign images simply fail to decode.
 *
 * Split in two layers so the PDF walking is testable under Node:
 *  - `extractPdfImages`: pure pdf-lib + stream decoding → raw pixels / JPEG bytes
 *  - `extractPdfPayloads`: browser-only, turns those into codec payloads
 */

import { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFArray, PDFStream } from 'pdf-lib';
import { unzlibSync } from 'fflate';
import { CODEC_QR_GRID, getCodec, type ImageDataLike } from '@core';

/** Resource guards for an untrusted PDF (mirrors the .zip restore bounds). */
const MAX_PDF_IMAGES = 400; // pages + SMasks + logos in a generous scan
const MAX_PIXELS = 30_000_000; // ~30 MP per image

export type PdfImage = { kind: 'pixels'; img: ImageDataLike } | { kind: 'jpeg'; bytes: Uint8Array };

function asName(v: unknown): string | undefined {
  return v instanceof PDFName ? v.decodeText() : undefined;
}

/** Number of color components for the XObject's color space (0 = unsupported). */
function componentsFor(dict: PDFRawStream['dict']): number {
  const cs = dict.get(PDFName.of('ColorSpace'));
  const name = asName(cs);
  if (name === 'DeviceRGB') return 3;
  if (name === 'DeviceGray') return 1;
  // ICCBased: [ /ICCBased <stream with /N 1|3> ] — treat by component count.
  if (cs instanceof PDFArray && asName(cs.get(0)) === 'ICCBased') {
    const streamRef = cs.get(1);
    const stream = streamRef ? dict.context.lookup(streamRef) : undefined;
    if (stream instanceof PDFStream) {
      const n = stream.dict.get(PDFName.of('N'));
      if (n instanceof PDFNumber && (n.asNumber() === 1 || n.asNumber() === 3)) {
        return n.asNumber();
      }
    }
  }
  return 0;
}

/** Gray/RGB rows → RGBA pixels the codec can read. */
function toImageData(raw: Uint8Array, width: number, height: number, comps: number): ImageDataLike {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, o = 0; p < width * height; p++, o += 4) {
    const i = p * comps;
    out[o] = raw[i]!;
    out[o + 1] = raw[comps === 3 ? i + 1 : i]!;
    out[o + 2] = raw[comps === 3 ? i + 2 : i]!;
    out[o + 3] = 255;
  }
  return { data: out, width, height };
}

/**
 * Enumerate the PDF's image XObjects and return the ones we can materialize.
 * Never throws on a malformed *image* — it is skipped; throws only when the
 * document itself is not a readable PDF.
 */
export async function extractPdfImages(bytes: Uint8Array): Promise<PdfImage[]> {
  const pdf = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  const images: PdfImage[] = [];

  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (images.length >= MAX_PDF_IMAGES) break;
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (asName(dict.get(PDFName.of('Subtype'))) !== 'Image') continue;

    try {
      const width = (dict.get(PDFName.of('Width')) as PDFNumber).asNumber();
      const height = (dict.get(PDFName.of('Height')) as PDFNumber).asNumber();
      if (!Number.isInteger(width) || !Number.isInteger(height)) continue;
      if (width < 16 || height < 16 || width * height > MAX_PIXELS) continue;

      const filter = dict.get(PDFName.of('Filter'));
      const filterName =
        asName(filter) ?? (filter instanceof PDFArray ? asName(filter.get(0)) : undefined);

      if (filterName === 'DCTDecode') {
        // The stream body IS a JPEG file; let the browser's decoder handle it.
        images.push({ kind: 'jpeg', bytes: obj.getContents() });
        continue;
      }
      // Only FlateDecode is materialized here; anything else is skipped (a lost
      // page is tolerated by the erasure coding).
      if (filterName !== 'FlateDecode') continue;

      const bpc = dict.get(PDFName.of('BitsPerComponent'));
      if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 8) continue;
      const comps = componentsFor(dict);
      if (comps === 0) continue;

      // Inflate with the output hard-capped at the declared pixel size, so a
      // crafted stream (tiny declared dimensions, huge FlateDecode body) cannot
      // inflate to gigabytes and OOM the tab. Our paper PDFs store un-predicted
      // FlateDecode samples, which match this exactly; predicted or foreign
      // streams overflow the cap (or decode wrong) and are simply dropped.
      const needed = width * height * comps;
      let raw: Uint8Array;
      try {
        raw = unzlibSync(obj.getContents(), { out: new Uint8Array(needed) });
      } catch {
        continue; // over-cap (potential bomb), predicted, or corrupt — skip
      }
      if (raw.length < needed) continue;
      images.push({ kind: 'pixels', img: toImageData(raw, width, height, comps) });
    } catch {
      // Unsupported or corrupt XObject — skip it.
    }
  }
  return images;
}

/** Downscale pixels so the longer side is at most `maxSide` (browser-only). */
function downscale(img: ImageDataLike, maxSide: number): ImageDataLike {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale === 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const src = new OffscreenCanvas(img.width, img.height);
  const sctx = src.getContext('2d')!;
  sctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const dst = new OffscreenCanvas(w, h);
  const dctx = dst.getContext('2d')!;
  dctx.drawImage(src, 0, 0, w, h);
  const data = dctx.getImageData(0, 0, w, h);
  return { data: data.data, width: data.width, height: data.height };
}

/**
 * Decode every readable QR payload out of a PDF (browser entry point).
 * Unreadable images are dropped — erasure coding tolerates losses.
 */
export async function extractPdfPayloads(bytes: Uint8Array): Promise<Uint8Array[]> {
  const codec = getCodec(CODEC_QR_GRID);
  // Lazy import keeps image-io (and its canvas helpers) off this module's
  // node-testable path; the function itself is browser-only anyway.
  const { decodeImageBytes } = await import('./image-io');

  const payloads: Uint8Array[] = [];
  for (const image of await extractPdfImages(bytes)) {
    if (image.kind === 'jpeg') {
      const payload = await decodeImageBytes(image.bytes);
      if (payload) payloads.push(payload);
      continue;
    }
    for (const maxSide of [Infinity, 1400, 1000]) {
      try {
        payloads.push(codec.decode(downscale(image.img, maxSide)));
        break;
      } catch {
        // Try the next scale; give up after the last.
      }
    }
  }
  return payloads;
}
