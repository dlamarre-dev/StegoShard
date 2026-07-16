/**
 * CLI paper-PDF: generate a printable PDF, then pull the QR pages back out of it
 * (the exact `extractPdfImages` path a restore uses) and confirm byte-exact
 * recovery. Also checks the CJK-without-a-font graceful fallback to English.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runRestore, runSave } from './commands';
import { buildCliPaperPdf } from './paper';
import { CODEC_QR_GRID, PROFILE_PAPER, getCodec, type ImageDataLike } from '@core';
import { imageDataToPng } from './node-image-io';

const SLOW = { timeout: 60_000 };
const PW = 'paper password';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'iv-paper-'));
}

function pattern(len: number, seed = 7): Uint8Array {
  let s = seed >>> 0;
  return Uint8Array.from({ length: len }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  });
}

describe('CLI paper PDF', () => {
  it('save --paper (French instructions) → restore from the PDF', SLOW, async () => {
    const dir = tmp();
    const content = pattern(1600);
    const input = join(dir, 'notes.bin');
    writeFileSync(input, content);

    const { files } = await runSave({
      inputFile: input,
      outDir: join(dir, 'out'),
      password: PW,
      paper: true,
      zip: false,
      keyMode: 'embedded',
      instructions: true,
      locale: 'fr',
    });
    const pdf = files.find((f) => f.endsWith('.pdf'))!;
    expect(pdf).toBeTruthy();

    const { outPath } = await runRestore({
      inputs: [pdf],
      outDir: join(dir, 'restored'),
      password: PW,
    });
    expect([...readFileSync(outPath)]).toEqual([...content]);
  });

  it('a CJK locale with no font falls back to English but still builds', SLOW, async () => {
    // No --font and (in CI) no system CJK font → effectiveLocale downgrades.
    const payload = pattern(300);
    const encodeQr = (p: Uint8Array): ImageDataLike =>
      getCodec(CODEC_QR_GRID).encode(p, PROFILE_PAPER);
    const built = await buildCliPaperPdf([payload], encodeQr, imageDataToPng, {
      locale: 'zh_TW',
      includeInstructions: true,
      fontPath: undefined,
    });
    // Either a CJK font was found (rendered zh_TW) or it fell back to English
    // with a warning — both are valid; the PDF must always be produced.
    expect(built.pdf.length).toBeGreaterThan(0);
    if (built.effectiveLocale === 'en') {
      expect(built.fontWarning).toMatch(/font/i);
    }
  });
});
