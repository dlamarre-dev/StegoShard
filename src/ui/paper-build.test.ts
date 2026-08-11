/**
 * Instruction-sheet localization data (shared by the web app, extension, and
 * CLI paper output). Guards that every locale is complete, including the
 * `page` word used for the "Page x / N" line, and that locale selection maps
 * as expected.
 *
 * Also guards the page *geometry*, which nothing did before: the brand mark must
 * not shrink the QR, and the instruction sheet must not overflow the page.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { unzlibSync } from 'fflate';
import { qrGridCodec, PROFILE_PAPER } from '@core';
import { encode as encodePng } from 'fast-png';
import {
  A4,
  INSTRUCTIONS,
  MARGIN,
  type InstructionCopy,
  TextEngine,
  type PreparedText,
  type TextBlockOpts,
  buildPaperPdf,
  instructionLangs,
} from './paper-build';

const REQUIRED: (keyof InstructionCopy)[] = [
  'heading',
  'intro',
  'steps',
  'resilience',
  'project',
  'keyLocation',
  'passwordHint',
  'preservation',
  'warning',
  'footer',
  'page',
];

describe('instruction copy', () => {
  it('ships all nine locales, each complete', () => {
    expect(Object.keys(INSTRUCTIONS).sort()).toEqual(
      ['de', 'en', 'es', 'fr', 'it', 'ja', 'pt', 'zh_CN', 'zh_TW'].sort(),
    );
    for (const [code, copy] of Object.entries(INSTRUCTIONS)) {
      for (const field of REQUIRED) {
        expect(copy[field], `${code}.${field}`).toBeTruthy();
      }
      expect(copy.steps.length).toBe(3);
      expect(typeof copy.page).toBe('string');
      expect(copy.page.length).toBeGreaterThan(0);
    }
  });

  it('localizes the page word per locale', () => {
    expect(instructionLangs('en')[0]!.page).toBe('Page');
    expect(instructionLangs('de')[0]!.page).toBe('Seite');
    expect(instructionLangs('es')[0]!.page).toBe('Página');
    expect(instructionLangs('ja')[0]!.page).toBe('ページ');
    expect(instructionLangs('zh_TW')[0]!.page).toBe('頁');
    expect(instructionLangs('zh-CN')[0]!.page).toBe('页');
  });

  it('prints the chosen locale first, English as the durable fallback', () => {
    expect(instructionLangs('en')).toEqual([INSTRUCTIONS.en]);
    const fr = instructionLangs('fr');
    expect(fr[0]).toBe(INSTRUCTIONS.fr);
    expect(fr[1]).toBe(INSTRUCTIONS.en);
    // Traditional vs Simplified Chinese routing.
    expect(instructionLangs('zh-Hant')[0]).toBe(INSTRUCTIONS.zh_TW);
    expect(instructionLangs('zh')[0]).toBe(INSTRUCTIONS.zh_CN);
    // Unknown → English only.
    expect(instructionLangs('kl')).toEqual([INSTRUCTIONS.en]);
  });
});

/**
 * A measuring-only text engine. It approximates Helvetica's advance width well
 * enough to reproduce the real line counts, and records the lowest point any
 * text reached so the tests can assert nothing ran off the page.
 */
class MeasuringEngine extends TextEngine {
  lowestY = A4.h;

  prepare(text: string, size: number, opts: TextBlockOpts = {}): Promise<PreparedText> {
    const maxWidth = opts.maxWidth ?? A4.w - MARGIN * 2;
    const perChar = size * 0.52;
    const lines = Math.max(1, Math.ceil((text.length * perChar) / maxWidth));
    const height = lines * size * 1.35;
    return Promise.resolve({
      height,
      draw: (_page, _x, yTop) => {
        this.lowestY = Math.min(this.lowestY, yTop - height);
      },
    });
  }
}

async function build(payloads: number, locale: string, instructions: boolean) {
  const engine = new MeasuringEngine();
  const bytes = await buildPaperPdf({
    imagePayloads: Array.from({ length: payloads }, (_, i) =>
      Uint8Array.from({ length: 80 }, (_, j) => (i * 31 + j) & 0xff),
    ),
    encodeQr: (p) => qrGridCodec.encode(p, PROFILE_PAPER),
    pngEncode: (img) =>
      encodePng({
        width: img.width,
        height: img.height,
        data: Uint8Array.from(img.data),
        channels: 4,
        depth: 8,
      }),
    createTextEngine: () => Promise.resolve(engine),
    title: 'Test vault',
    date: '2026-08-02',
    locale,
    includeInstructions: instructions,
  });
  return { bytes, engine, pdf: await PDFDocument.load(bytes) };
}

/** Concatenated content streams of a saved PDF (pdf-lib flate-compresses them). */
function contentStreams(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const text = raw.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      out += Buffer.from(unzlibSync(raw.subarray(start, end))).toString('latin1');
    } catch {
      // Not a deflate stream (e.g. raw image data), so skip it.
    }
  }
  return out;
}

type Mat = [number, number, number, number, number, number];

/** Compose two 2x3 affine matrices: `a` applied first, then `b`. */
function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/**
 * Every image placement in the document's content streams.
 *
 * pdf-lib emits a chain of `cm` transforms before each `Do`, so the effective
 * placement is their composition; reading a single `cm` gives the wrong answer.
 * Requiring the trailing `Do` is also what separates an image from the brand
 * mark's vector paths, which emit `cm` transforms of their own.
 */
function imagePlacements(bytes: Uint8Array): { side: number; x: number; y: number }[] {
  const out: { side: number; x: number; y: number }[] = [];
  const block = /q\n((?:[-\d. ]+cm\n)+)\/\S+ Do/g;
  const text = contentStreams(bytes);
  for (let m = block.exec(text); m; m = block.exec(text)) {
    let ctm: Mat = [1, 0, 0, 1, 0, 0];
    for (const line of m[1]!.trim().split('\n')) {
      const n = line.trim().split(/\s+/).slice(0, 6).map(Number) as Mat;
      ctm = mul(n, ctm);
    }
    out.push({ side: ctm[0], x: ctm[4], y: ctm[5] });
  }
  return out;
}

describe('paper page geometry', () => {
  it('keeps A4 pages, one per payload', async () => {
    const { pdf } = await build(3, 'en', false);
    expect(pdf.getPageCount()).toBe(3);
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo(A4.w, 1);
      expect(page.getHeight()).toBeCloseTo(A4.h, 1);
    }
  });

  it('adds an instruction sheet as the first page when asked', async () => {
    const { pdf } = await build(2, 'en', true);
    expect(pdf.getPageCount()).toBe(3); // sheet + 2 QR pages
  });

  it('the brand mark does not shrink the QR — it stays width-clamped', async () => {
    const { bytes } = await build(1, 'en', false);
    const placements = imagePlacements(bytes);
    expect(placements.length).toBeGreaterThan(0);
    const qr = placements.at(-1)!;
    // Width-clamped: page width minus both margins, centred.
    expect(qr.side).toBeCloseTo(A4.w - MARGIN * 2, 1);
    expect(qr.x).toBeCloseTo(MARGIN, 1);
  });

  it('draws the mark as vector, adding no image XObject for restore to sift', async () => {
    // One page, one payload → exactly one embedded image. A logo PNG would make
    // it two, and pdf-restore.ts would try to decode the logo on every restore.
    const { bytes } = await build(1, 'en', false);
    expect(imagePlacements(bytes)).toHaveLength(1);
    expect(
      Buffer.from(bytes)
        .toString('latin1')
        .match(/\/Subtype \/Image/g),
    ).toHaveLength(1);
  });

  it(
    'the instruction sheet fits the page in the most verbose locale pairs',
    { timeout: 30_000 },
    async () => {
      // de and pt are the longest, and each prints alongside the English fallback.
      for (const locale of ['de', 'pt', 'fr', 'es', 'it']) {
        const { engine } = await build(1, locale, true);
        expect(engine.lowestY, `${locale} instruction sheet overflows`).toBeGreaterThan(0);
      }
    },
  );
});
