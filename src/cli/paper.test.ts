/**
 * CLI paper-PDF: generate a printable PDF, then pull the QR pages back out of it
 * (the exact `extractPdfImages` path a restore uses) and confirm byte-exact
 * recovery. Also checks the CJK font decision: which locales need one, which
 * faces they are offered, the graceful fallback to English when none is usable,
 * and that a usable one really does put the script in the PDF.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runRestore, runSave } from './commands';
import { buildCliPaperPdf, needsCjkFont, systemCjkFontCandidates } from './paper';
import { CODEC_QR_GRID, PROFILE_PAPER, getCodec, type ImageDataLike } from '@core';
import { imageDataToPng } from './node-image-io';

const SLOW = { timeout: 60_000 };
const PW = 'paper password';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ss-paper-'));
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
      inputs: [input],
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

  /**
   * Build one instruction sheet, and report both the locale decision and whether
   * the script actually reached the page.
   *
   * The rendered text is what matters: a font without the glyph draws a blank
   * rather than failing, so `effectiveLocale` alone cannot tell a correct sheet
   * from an empty one. pdf-lib writes a ToUnicode CMap for the embedded subset,
   * so the code points it carries are the characters really drawn.
   */
  async function buildSheet(
    locale: string,
    fontPath: string | undefined,
  ): Promise<{
    effectiveLocale: string;
    fontWarning: string | undefined;
    codePoints: Set<number>;
  }> {
    const encodeQr = (p: Uint8Array): ImageDataLike =>
      getCodec(CODEC_QR_GRID).encode(p, PROFILE_PAPER);
    const built = await buildCliPaperPdf([pattern(300)], encodeQr, imageDataToPng, {
      locale,
      includeInstructions: true,
      fontPath,
    });
    expect(built.pdf.length).toBeGreaterThan(0);

    const codePoints = new Set<number>();
    const pdf = Buffer.from(built.pdf);
    const latin1 = pdf.toString('latin1');
    for (const m of latin1.matchAll(/stream\r?\n/g)) {
      const start = m.index! + m[0].length;
      const end = latin1.indexOf('endstream', start);
      if (end < 0) continue;
      let text: string;
      try {
        text = inflateSync(pdf.subarray(start, end)).toString('latin1');
      } catch {
        continue; // not a deflated stream (an image XObject, say)
      }
      // ToUnicode CMap rows: <glyphId> <unicodeCodePoint>
      for (const row of text.matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4})>/g)) {
        codePoints.add(parseInt(row[2]!, 16));
      }
    }
    return { effectiveLocale: built.effectiveLocale, fontWarning: built.fontWarning, codePoints };
  }

  const isHangul = (cp: number): boolean => cp >= 0xac00 && cp <= 0xd7a3;

  it('routes ja, ko and zh to the font path, and Latin locales past it', () => {
    for (const code of ['ja', 'ko', 'ko-KR', 'ko_KR', 'zh_TW', 'zh_CN']) {
      expect(needsCjkFont(code), code).toBe(true);
    }
    for (const code of ['en', 'fr', 'de', 'es', 'it', 'pt', undefined]) {
      expect(needsCjkFont(code), String(code)).toBe(false);
    }
  });

  it('offers Korean only faces that carry Hangul', () => {
    const korean = systemCjkFontCandidates('ko').join('|');
    expect(korean.length).toBeGreaterThan(0);
    // A Japanese or Chinese face has no Hangul, and a missing glyph is drawn as
    // a blank rather than raising, so offering one here prints an empty sheet.
    for (const hangulLess of ['PingFang', 'YuGoth', 'msgothic', 'meiryo', 'msyh', 'simsun']) {
      expect(korean, hangulLess).not.toContain(hangulLess);
    }
    // The Japanese and Chinese list is still the single one it always was.
    expect(systemCjkFontCandidates('ja')).toEqual(systemCjkFontCandidates('zh_TW'));
  });

  // Deterministic on every platform: an explicit --font short-circuits system
  // font discovery, so this never depends on what the machine has installed. It
  // fails if `ko` is dropped from `needsCjkFont`, which would leave
  // effectiveLocale at 'ko' and silently print the sheet in Helvetica.
  for (const locale of ['zh_TW', 'ko']) {
    it(`a CJK locale (${locale}) with no usable font falls back to English`, SLOW, async () => {
      const built = await buildSheet(locale, join(tmp(), 'does-not-exist.ttf'));
      expect(built.effectiveLocale).toBe('en');
      expect(built.fontWarning).toMatch(/font/i);
      expect([...built.codePoints].some(isHangul)).toBe(false);
    });
  }

  it('renders Hangul when a Korean-capable font is available', SLOW, async () => {
    // Single-face files only: pdf-lib cannot embed a .ttc collection, which is
    // what most systems ship their CJK fonts as. Skipped rather than failed when
    // the machine has none, since that is a property of the host, not the code.
    const font = [
      '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
      '/Library/Fonts/Arial Unicode.ttf',
      'C:/Windows/Fonts/malgun.ttf',
      '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
      '/usr/share/fonts/opentype/noto/NotoSansKR-Regular.otf',
    ].find((p) => existsSync(p));
    if (!font) return; // no single-face Hangul font on this host

    const built = await buildSheet('ko', font);
    expect(built.effectiveLocale).toBe('ko');
    expect(built.fontWarning).toBeUndefined();
    // The real guard: the Korean text reached the page, not just the locale tag.
    expect([...built.codePoints].filter(isHangul).length).toBeGreaterThan(20);
  });
});
