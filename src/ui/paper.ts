/**
 * Paper destination (SPEC §6), browser side. Encodes a file into a printable
 * PDF (high-ECC QR per page + a localized instruction sheet) and downloads it.
 *
 * The PDF assembly lives in the environment-neutral `paper-build.ts`; this file
 * supplies the browser pieces: a canvas-based `TextEngine` (system fonts cover
 * every script, so any language renders without shipping font files), canvas
 * PNG encoding, the File input, and the download. The CLI reuses the same
 * `buildPaperPdf` with a fontkit text engine instead.
 */

import { StandardFonts, type PDFDocument, type PDFFont, type PDFImage } from 'pdf-lib';
import {
  getCodec,
  exportVault,
  PROFILE_PAPER,
  decodeHeader,
  toHex,
  type KeyMode,
  type VaultKey,
} from '@core';
import { downloadBlob, embedKeyImage, imageDataToPngBlob } from './image-io';
import { wrapText } from './text-wrap';
import {
  A4,
  BLACK,
  LEADING,
  MARGIN,
  type PreparedText,
  TextEngine,
  type TextBlockOpts,
  buildPaperPdf,
} from './paper-build';

export interface PaperOptions {
  keyMode: KeyMode;
  title?: string | undefined;
  date?: string | undefined;
  includeInstructions?: boolean | undefined;
  passwordHint?: string | undefined;
  keyLocation?: string | undefined;
  /** For the 'stego' key mode: cover photo + the password that keys embedding. */
  stego?: { cover: File; password: string } | undefined;
  /** Active UI locale, so the instruction sheet matches the chosen language. */
  locale?: string | undefined;
}

/** Canvas pixels per PDF point — 3× keeps printed text crisp. */
const TEXT_SCALE = 3;

/**
 * Browser text engine: vector Helvetica when the text is WinAnsi-safe, otherwise
 * a canvas rendering embedded as an opaque image (any script, no shipped fonts).
 */
class CanvasTextEngine extends TextEngine {
  constructor(
    private pdf: PDFDocument,
    private regular: PDFFont,
    private boldFont: PDFFont,
  ) {
    super();
  }

  private canEncode(text: string, font: PDFFont): boolean {
    try {
      font.widthOfTextAtSize(text, 10);
      return true;
    } catch {
      return false;
    }
  }

  async prepare(text: string, size: number, opts: TextBlockOpts = {}): Promise<PreparedText> {
    const bold = opts.bold ?? false;
    const maxWidth = opts.maxWidth ?? A4.w - MARGIN * 2;
    const lineH = size * LEADING;
    const font = bold ? this.boldFont : this.regular;

    if (this.canEncode(text, font)) {
      const lines = wrapText(text, maxWidth, (s) => font.widthOfTextAtSize(s, size));
      return {
        height: lines.length * lineH,
        draw: (page, x, yTop) => {
          lines.forEach((line, i) => {
            page.drawText(line, { x, y: yTop - size - i * lineH, size, font, color: BLACK });
          });
        },
      };
    }
    return this.renderCanvasText(text, size, bold, maxWidth);
  }

  private async renderCanvasText(
    text: string,
    size: number,
    bold: boolean,
    maxWidthPt: number,
  ): Promise<PreparedText> {
    const px = size * TEXT_SCALE;
    const fontSpec = `${bold ? '600 ' : ''}${px}px system-ui, sans-serif`;
    const scratch = new OffscreenCanvas(1, 1).getContext('2d');
    if (!scratch) throw new Error('paper: 2D canvas context unavailable');
    scratch.font = fontSpec;

    const maxPx = maxWidthPt * TEXT_SCALE;
    const lines = wrapText(text, maxPx, (s) => scratch.measureText(s).width);
    const lineH = Math.ceil(px * LEADING);
    const widest = Math.max(1, ...lines.map((l) => Math.ceil(scratch.measureText(l).width)));
    const w = Math.min(Math.ceil(maxPx), widest);
    const h = lines.length * lineH;

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('paper: 2D canvas context unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#000000';
    ctx.font = fontSpec;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => ctx.fillText(line, 0, i * lineH + px * 0.08));

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const ref: PDFImage = await this.pdf.embedPng(new Uint8Array(await blob.arrayBuffer()));
    const width = w / TEXT_SCALE;
    const height = h / TEXT_SCALE;
    return {
      height,
      draw: (page, x, yTop) => page.drawImage(ref, { x, y: yTop - height, width, height }),
    };
  }
}

/** Encode a file into a printable PDF and download it. */
export async function saveFileToPaper(
  file: File,
  key: VaultKey,
  options: PaperOptions,
): Promise<{ imageCount: number; setId: string; keyMode: KeyMode }> {
  const content = new Uint8Array(await file.arrayBuffer());
  const { imagePayloads, setId, keyBlock, keyMode } = await exportVault(file.name, content, key, {
    profile: PROFILE_PAPER,
    keyMode: options.keyMode,
  });
  const codec = getCodec(decodeHeader(imagePayloads[0]!).codecId);
  const setHex = toHex(setId);

  const pdfBytes = await buildPaperPdf({
    imagePayloads,
    encodeQr: (p) => codec.encode(p, PROFILE_PAPER),
    pngEncode: async (img) => new Uint8Array(await (await imageDataToPngBlob(img)).arrayBuffer()),
    createTextEngine: async (pdf) =>
      new CanvasTextEngine(
        pdf,
        await pdf.embedFont(StandardFonts.Helvetica),
        await pdf.embedFont(StandardFonts.HelveticaBold),
      ),
    title: options.title,
    date: options.date,
    locale: options.locale,
    includeInstructions: options.includeInstructions,
    passwordHint: options.passwordHint,
    keyLocation: options.keyLocation,
  });

  downloadBlob(
    new Blob([pdfBytes as BufferSource], { type: 'application/pdf' }),
    `imagevault-${setHex}.pdf`,
  );

  // For keyfile/stego modes the key block is not on paper — deliver it too:
  // hidden in the cover photo (stego) or as a plain .key file (keyfile).
  if (keyMode === 'stego') {
    if (!options.stego) throw new Error('stego mode requires a cover image and password');
    const png = await embedKeyImage(options.stego.cover, keyBlock, options.stego.password);
    downloadBlob(png, `imagevault-${setHex}-key.png`);
  } else if (keyMode !== 'embedded') {
    downloadBlob(new Blob([keyBlock as BufferSource]), `imagevault-${setHex}.key`);
  }

  return { imageCount: imagePayloads.length, setId: setHex, keyMode };
}
