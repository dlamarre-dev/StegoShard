/**
 * Paper destination (plan §6): generate a printable PDF of the vault's images
 * using the PAPER robustness profile (high ECC), one QR per page with a
 * readable header (title / date / page x of N) and a short restore footer.
 *
 * An optional instruction sheet (first page) explains how to restore even years
 * later — which tool, where to get it, the steps, and free fields for a key
 * location and a password hint. Restoring from paper reuses the normal image
 * import: the user scans or photographs the pages and imports the picture files.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import browser from 'webextension-polyfill';
import {
  getCodec,
  exportVault,
  PROFILE_PAPER,
  decodeHeader,
  toHex,
  type KeyMode,
  type VaultKey,
} from '@core';
import { downloadBlob, imageDataToPngBlob } from './image-io';

/** Public project page — printed so the data can be restored without the store. */
const PROJECT_URL = 'https://github.com/dlamarre-dev/ImageVault';

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 42;

export interface PaperOptions {
  keyMode: KeyMode;
  title?: string | undefined;
  date?: string | undefined;
  includeInstructions?: boolean | undefined;
  passwordHint?: string | undefined;
  keyLocation?: string | undefined;
}

/** Instruction-sheet copy. Always printed in English; the browser locale is
 *  added when different (plan §6, decision 15). More locales land in Phase 5. */
interface InstructionCopy {
  heading: string;
  intro: string;
  steps: string[];
  resilience: string;
  project: string;
  keyLocation: string;
  passwordHint: string;
  preservation: string;
  warning: string;
  footer: string;
}

const INSTRUCTIONS: Record<string, InstructionCopy> = {
  en: {
    heading: 'How to restore this vault',
    intro: 'These pages hold an encrypted file, encoded as error-corrected QR images.',
    steps: [
      '1. Get ImageVault (browser extension) or the Python reference decoder from the project page below.',
      '2. Scan or photograph every page, then import the image files.',
      '3. Enter your password. The original file is restored.',
    ],
    resilience: 'You can lose or damage a few pages and still restore, as long as most survive.',
    project: 'Project and reference decoder:',
    keyLocation: 'Key location:',
    passwordHint: 'Password hint:',
    preservation:
      'Keep it safe: print with a laser printer, store away from light and moisture, and keep copies in separate places.',
    warning: 'This sheet is not encrypted. Never write your password here.',
    footer: 'Restore: ImageVault + your password, with enough pages.',
  },
  fr: {
    heading: 'Comment restaurer ce coffre',
    intro: "Ces pages contiennent un fichier chiffré, encodé en images QR corrigées d'erreurs.",
    steps: [
      '1. Procurez-vous ImageVault (extension) ou le décodeur Python de référence sur la page du projet ci-dessous.',
      '2. Numérisez ou photographiez chaque page, puis importez les fichiers image.',
      '3. Saisissez votre mot de passe. Le fichier original est restauré.',
    ],
    resilience:
      'Vous pouvez perdre ou abîmer quelques pages et restaurer quand même, tant que la plupart survivent.',
    project: 'Projet et décodeur de référence :',
    keyLocation: 'Emplacement de la clé :',
    passwordHint: 'Indice de mot de passe :',
    preservation:
      "À conserver : imprimez au laser, à l'abri de la lumière et de l'humidité, et gardez des copies en lieux distincts.",
    warning: "Cette feuille n'est pas chiffrée. N'y écrivez jamais votre mot de passe.",
    footer: 'Restaurer : ImageVault + votre mot de passe, avec assez de pages.',
  },
};

/** WinAnsi (Helvetica) cannot encode arbitrary Unicode; replace the rest. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x09\x0a\x0d\x20-\xff]/g, '?');
}

function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
): void {
  page.drawText(sanitize(text), { x, y, size, font, color: rgb(0, 0, 0) });
}

/** Word-wrap `text` to `maxWidth`, returning the y position after the block. */
function drawWrapped(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  maxWidth: number,
  lineGap = 4,
): number {
  const words = sanitize(text).split(/\s+/);
  let line = '';
  let cursorY = y;
  const flush = () => {
    if (line) drawText(page, line, x, cursorY, size, font);
    cursorY -= size + lineGap;
  };
  for (const word of words) {
    const trial = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(trial, size) > maxWidth && line) {
      flush();
      line = word;
    } else {
      line = trial;
    }
  }
  flush();
  return cursorY;
}

function instructionLangs(): InstructionCopy[] {
  const ui = browser.i18n.getUILanguage().toLowerCase();
  const primary = ui.startsWith('fr') ? INSTRUCTIONS.fr! : INSTRUCTIONS.en!;
  // Always include English as the durable fallback.
  return primary === INSTRUCTIONS.en ? [INSTRUCTIONS.en!] : [primary, INSTRUCTIONS.en!];
}

function addInstructionSheet(
  pdf: PDFDocument,
  font: PDFFont,
  bold: PDFFont,
  options: PaperOptions,
): void {
  const page = pdf.addPage([A4.w, A4.h]);
  const maxW = A4.w - MARGIN * 2;
  let y = A4.h - MARGIN;

  for (const copy of instructionLangs()) {
    drawText(page, copy.heading, MARGIN, y, 16, bold);
    y -= 24;
    y = drawWrapped(page, copy.intro, MARGIN, y, 11, font, maxW);
    y -= 4;
    for (const step of copy.steps) y = drawWrapped(page, step, MARGIN, y, 11, font, maxW);
    y -= 4;
    y = drawWrapped(page, copy.resilience, MARGIN, y, 11, font, maxW);
    y -= 6;
    drawText(page, copy.project, MARGIN, y, 11, bold);
    y -= 16;
    drawText(page, PROJECT_URL, MARGIN, y, 11, font);
    y -= 20;
    drawText(page, `${copy.keyLocation} ${options.keyLocation ?? ''}`, MARGIN, y, 11, font);
    y -= 16;
    drawText(page, `${copy.passwordHint} ${options.passwordHint ?? ''}`, MARGIN, y, 11, font);
    y -= 20;
    y = drawWrapped(page, copy.preservation, MARGIN, y, 10, font, maxW);
    y -= 4;
    y = drawWrapped(page, copy.warning, MARGIN, y, 10, bold, maxW);
    y -= 28;
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
  const total = imagePayloads.length;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  if (options.includeInstructions) addInstructionSheet(pdf, font, bold, options);

  // Bilingual short restore hint (browser locale + English) plus the URL,
  // repeated on every page so a stray page still explains itself.
  const footerLines = [...instructionLangs().map((c) => c.footer), PROJECT_URL];

  for (let i = 0; i < total; i++) {
    const img = codec.encode(imagePayloads[i]!, PROFILE_PAPER);
    const pngBytes = new Uint8Array(await (await imageDataToPngBlob(img)).arrayBuffer());
    const png = await pdf.embedPng(pngBytes);

    const page = pdf.addPage([A4.w, A4.h]);
    let y = A4.h - MARGIN;
    if (options.title) {
      drawText(page, options.title, MARGIN, y, 15, bold);
      y -= 20;
    }
    const meta = [options.date, `Page ${i + 1} / ${total}`].filter(Boolean).join('    ');
    drawText(page, meta, MARGIN, y, 10, font);
    y -= 12;

    // Square QR, centered, filling the width below the header.
    const side = Math.min(A4.w - MARGIN * 2, y - MARGIN - 30);
    const qx = (A4.w - side) / 2;
    const qy = y - side;
    page.drawImage(png, { x: qx, y: qy, width: side, height: side });

    let fy = MARGIN + (footerLines.length - 1) * 10;
    for (const line of footerLines) {
      drawText(page, line, MARGIN, fy, 8, font);
      fy -= 10;
    }
  }

  const bytes = await pdf.save();
  downloadBlob(new Blob([bytes as BufferSource], { type: 'application/pdf' }), `imagevault-${setHex}.pdf`);

  // For keyfile/stego modes the key block is not on paper — save it to disk too.
  if (keyMode !== 'embedded') {
    downloadBlob(new Blob([keyBlock as BufferSource]), `imagevault-${setHex}.key`);
  }

  return { imageCount: total, setId: setHex, keyMode };
}
