/**
 * CLI paper-PDF generation: the headless counterpart to `src/ui/paper.ts`.
 *
 * Reuses the neutral `buildPaperPdf` with a Node text engine. No fonts are
 * bundled: Latin locales (en/fr/de/es/it/pt) render with pdf-lib's built-in
 * Helvetica (WinAnsi), exactly like the browser's vector path. CJK locales
 * (ja/ko/zh) need a real font, resolved from `--font` or the OS's system fonts and
 * embedded via fontkit as vector text. If no usable CJK font is found, the
 * instruction sheet falls back to English (the QR payload is unaffected). This
 * stays fully offline; nothing is ever downloaded.
 */

import { existsSync, readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import {
  A4,
  BLACK,
  LEADING,
  MARGIN,
  type PreparedText,
  TextEngine,
  type TextBlockOpts,
  buildPaperPdf,
} from '../ui/paper-build';
import { wrapText } from '../ui/text-wrap';

/** Replace characters Helvetica (WinAnsi) cannot encode. */
function sanitizeWinAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x09\x0a\x0d\x20-\xff]/g, '?');
}

/**
 * Node text engine: vector text via an embedded Unicode font when one is
 * available (CJK), otherwise pdf-lib's built-in Helvetica with WinAnsi
 * sanitization (Latin scripts). No canvas, deterministic, subset by pdf-lib.
 */
class NodeTextEngine extends TextEngine {
  constructor(
    private regular: PDFFont,
    private boldFont: PDFFont,
    private unicode: PDFFont | null,
  ) {
    super();
  }

  async prepare(text: string, size: number, opts: TextBlockOpts = {}): Promise<PreparedText> {
    const bold = opts.bold ?? false;
    const maxWidth = opts.maxWidth ?? A4.w - MARGIN * 2;
    const lineH = size * LEADING;
    const font = this.unicode ?? (bold ? this.boldFont : this.regular);
    const content = this.unicode ? text : sanitizeWinAnsi(text);

    const lines = wrapText(content, maxWidth, (s) => font.widthOfTextAtSize(s, size));
    return {
      height: lines.length * lineH,
      draw: (page, x, yTop) => {
        lines.forEach((line, i) => {
          page.drawText(line, { x, y: yTop - size - i * lineH, size, font, color: BLACK });
        });
      },
    };
  }
}

/**
 * Known per-OS system font locations to try for CJK coverage.
 *
 * Korean gets its own list rather than sharing one: a Japanese or Chinese face
 * such as PingFang or Yu Gothic carries no Hangul, and a font missing a glyph
 * draws a blank rather than failing, so offering those for `ko` would print an
 * empty sheet instead of falling back to English. Only faces that actually cover
 * Hangul are offered for Korean; the pan-CJK ones (Arial Unicode, Noto CJK) do,
 * and appear in both.
 */
export function systemCjkFontCandidates(locale: string): string[] {
  const korean = /^ko/i.test(locale.replace('_', '-'));
  switch (process.platform) {
    case 'win32':
      return korean
        ? ['C:/Windows/Fonts/malgun.ttf', 'C:/Windows/Fonts/gulim.ttc']
        : [
            'C:/Windows/Fonts/YuGothM.ttc',
            'C:/Windows/Fonts/msgothic.ttc',
            'C:/Windows/Fonts/msyh.ttc',
            'C:/Windows/Fonts/simsun.ttc',
            'C:/Windows/Fonts/meiryo.ttc',
          ];
    case 'darwin':
      return korean
        ? ['/System/Library/Fonts/AppleSDGothicNeo.ttc', '/Library/Fonts/Arial Unicode.ttf']
        : [
            '/System/Library/Fonts/PingFang.ttc',
            '/System/Library/Fonts/Hiragino Sans GB.ttc',
            '/Library/Fonts/Arial Unicode.ttf',
          ];
    default:
      // Noto CJK is one family across all four scripts, Hangul included.
      return [
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
      ];
  }
}

/**
 * True when the locale needs a CJK-capable font.
 *
 * Exported with `systemCjkFontCandidates` as a testing seam: whether a locale
 * reaches the font path at all, and which faces it is offered, are decisions no
 * end-to-end assertion can pin down on a machine whose system fonts are unknown.
 */
export function needsCjkFont(locale?: string): boolean {
  return /^(ja|ko|zh)/i.test((locale ?? '').replace('_', '-'));
}

/**
 * Resolve Unicode font bytes for a CJK locale: an explicit `--font` path first,
 * then system fonts. Returns null when none is found (caller falls back to
 * English). Only the file is read here; embeddability is validated later.
 */
function resolveCjkFontBytes(fontPath: string | undefined, locale: string): Uint8Array | null {
  const candidates = fontPath ? [fontPath] : systemCjkFontCandidates(locale);
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return new Uint8Array(readFileSync(path));
      } catch {
        // unreadable, so try the next
      }
    }
  }
  return null;
}

/** Embed the font into `pdf` (fontkit). Throws on an unsupported file. */
async function embedUnicode(pdf: PDFDocument, bytes: Uint8Array): Promise<PDFFont> {
  pdf.registerFontkit(fontkit);
  return pdf.embedFont(bytes, { subset: true });
}

/** Validate embeddability up front (a throwaway doc), so the locale decision is
 *  final before the real PDF; some system fonts are .ttc collections pdf-lib
 *  cannot embed. */
async function canEmbed(bytes: Uint8Array): Promise<boolean> {
  try {
    const probe = await PDFDocument.create();
    await embedUnicode(probe, bytes);
    return true;
  } catch {
    return false;
  }
}

export interface CliPaperOptions {
  title?: string | undefined;
  date?: string | undefined;
  locale?: string | undefined;
  includeInstructions?: boolean | undefined;
  passwordHint?: string | undefined;
  keyLocation?: string | undefined;
  /** Explicit font file for CJK instruction text (.ttf/.otf/.ttc). */
  fontPath?: string | undefined;
}

/** Result of building a paper PDF: the bytes plus which locale actually printed. */
export interface CliPaperResult {
  pdf: Uint8Array;
  /** The locale used for instructions (may downgrade to 'en' if no CJK font). */
  effectiveLocale: string;
  /** Set when a CJK locale was requested but no usable font was found. */
  fontWarning?: string;
}

/**
 * Build a paper PDF from image payloads. `encodeQr`/`pngEncode` are injected so
 * this stays decoupled from the codec import site.
 */
export async function buildCliPaperPdf(
  imagePayloads: Uint8Array[],
  encodeQr: (payload: Uint8Array) => import('@core').ImageDataLike,
  pngEncode: (img: import('@core').ImageDataLike) => Uint8Array,
  options: CliPaperOptions,
): Promise<CliPaperResult> {
  let effectiveLocale = options.locale ?? 'en';
  let fontWarning: string | undefined;
  let unicodeBytes: Uint8Array | null = null;

  // Decide the font (and thus the effective locale) BEFORE building, so the
  // instruction sheet's language and its glyphs are guaranteed consistent.
  if (needsCjkFont(effectiveLocale)) {
    const bytes = resolveCjkFontBytes(options.fontPath, effectiveLocale);
    if (bytes && (await canEmbed(bytes))) {
      unicodeBytes = bytes;
    } else {
      effectiveLocale = 'en';
      fontWarning = bytes
        ? 'The chosen font could not be embedded (single-face .ttf/.otf works best); ' +
          'printed the instructions in English.'
        : 'No CJK font found for the instruction sheet; printed it in English. ' +
          'Pass --font <path-to-a-.ttf/.otf> to render it in your language.';
    }
  }

  const pdf = await buildPaperPdf({
    imagePayloads,
    encodeQr,
    pngEncode,
    createTextEngine: async (doc) => {
      const regular = await doc.embedFont(StandardFonts.Helvetica);
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const unicode = unicodeBytes ? await embedUnicode(doc, unicodeBytes) : null;
      return new NodeTextEngine(regular, bold, unicode);
    },
    title: options.title,
    date: options.date,
    locale: effectiveLocale,
    includeInstructions: options.includeInstructions,
    passwordHint: options.passwordHint,
    keyLocation: options.keyLocation,
  });

  return fontWarning ? { pdf, effectiveLocale, fontWarning } : { pdf, effectiveLocale };
}
