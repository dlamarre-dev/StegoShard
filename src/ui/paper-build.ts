/**
 * Environment-neutral paper-PDF builder (SPEC §6 paper destination). Shared by
 * the browser (`paper.ts`, canvas text) and the CLI (`src/cli/paper.ts`, fontkit
 * vector text). Like `pdf-restore.ts`, this module is Node-safe: it imports only
 * pdf-lib, the codec-neutral types, and the pure text wrapper — no canvas, no
 * `navigator`, no file/blob APIs. Callers inject:
 *   - a `TextEngine` (how instruction/label text becomes PDF content), and
 *   - `encodeQr` + `pngEncode` (how a payload becomes an embeddable PNG).
 */

import { type PDFDocument, type PDFPage, rgb } from 'pdf-lib';
import type { ImageDataLike } from '@core';
import { wrapText } from './text-wrap';

/** Public project page — printed so the data can be restored without the store. */
export const PROJECT_URL = 'https://github.com/dlamarre-dev/ImageVault';

export const A4 = { w: 595.28, h: 841.89 };
export const MARGIN = 42;
export const LEADING = 1.35; // line height, in ems

// --- Localized instruction copy ----------------------------------------------

export interface InstructionCopy {
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

/** Instruction-sheet copy for every app locale (plus both Chinese scripts).
 *  English is always printed as the durable fallback. */
export const INSTRUCTIONS: Record<string, InstructionCopy> = {
  en: {
    heading: 'How to restore this vault',
    intro: 'These pages hold an encrypted file, encoded as error-corrected QR images.',
    steps: [
      '1. Get ImageVault (browser extension or CLI) or the Python reference decoder from the project page below.',
      '2. Scan or photograph every page, then import the image files (or the PDF).',
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
      '1. Procurez-vous ImageVault (extension ou CLI) ou le décodeur Python de référence sur la page du projet ci-dessous.',
      '2. Numérisez ou photographiez chaque page, puis importez les fichiers image (ou le PDF).',
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
  de: {
    heading: 'So stellen Sie diesen Tresor wieder her',
    intro:
      'Diese Seiten enthalten eine verschlüsselte Datei, kodiert als fehlerkorrigierte QR-Bilder.',
    steps: [
      '1. Holen Sie sich ImageVault (Erweiterung oder CLI) oder den Python-Referenzdecoder von der unten angegebenen Projektseite.',
      '2. Scannen oder fotografieren Sie jede Seite und importieren Sie dann die Bilddateien (oder das PDF).',
      '3. Geben Sie Ihr Passwort ein. Die Originaldatei wird wiederhergestellt.',
    ],
    resilience:
      'Auch wenn einige Seiten verloren gehen oder beschädigt sind, ist die Wiederherstellung möglich, solange die meisten erhalten bleiben.',
    project: 'Projekt und Referenzdecoder:',
    keyLocation: 'Schlüssel-Speicherort:',
    passwordHint: 'Passwort-Hinweis:',
    preservation:
      'Sicher aufbewahren: mit einem Laserdrucker drucken, vor Licht und Feuchtigkeit schützen und Kopien an getrennten Orten aufbewahren.',
    warning: 'Dieses Blatt ist nicht verschlüsselt. Schreiben Sie hier niemals Ihr Passwort auf.',
    footer: 'Wiederherstellung: ImageVault + Ihr Passwort, mit genügend Seiten.',
  },
  es: {
    heading: 'Cómo restaurar esta bóveda',
    intro:
      'Estas páginas contienen un archivo cifrado, codificado como imágenes QR con corrección de errores.',
    steps: [
      '1. Obtenga ImageVault (extensión o CLI) o el decodificador Python de referencia en la página del proyecto indicada abajo.',
      '2. Escanee o fotografíe cada página y luego importe los archivos de imagen (o el PDF).',
      '3. Introduzca su contraseña. El archivo original se restaurará.',
    ],
    resilience:
      'Puede perder o dañar algunas páginas y aun así restaurar, siempre que la mayoría sobreviva.',
    project: 'Proyecto y decodificador de referencia:',
    keyLocation: 'Ubicación de la clave:',
    passwordHint: 'Pista de la contraseña:',
    preservation:
      'Consérvelo bien: imprima con láser, guárdelo lejos de la luz y la humedad, y mantenga copias en lugares separados.',
    warning: 'Esta hoja no está cifrada. Nunca escriba aquí su contraseña.',
    footer: 'Restaurar: ImageVault + su contraseña, con suficientes páginas.',
  },
  it: {
    heading: 'Come ripristinare questa cassaforte',
    intro:
      'Queste pagine contengono un file cifrato, codificato in immagini QR con correzione degli errori.',
    steps: [
      '1. Procurati ImageVault (estensione o CLI) o il decodificatore Python di riferimento dalla pagina del progetto qui sotto.',
      '2. Scansiona o fotografa ogni pagina, poi importa i file immagine (o il PDF).',
      '3. Inserisci la tua password. Il file originale viene ripristinato.',
    ],
    resilience:
      'Puoi perdere o danneggiare alcune pagine e ripristinare comunque, purché la maggior parte sopravviva.',
    project: 'Progetto e decodificatore di riferimento:',
    keyLocation: 'Posizione della chiave:',
    passwordHint: 'Suggerimento password:',
    preservation:
      'Conservalo con cura: stampa con stampante laser, tieni al riparo da luce e umidità e conserva copie in luoghi separati.',
    warning: 'Questo foglio non è cifrato. Non scrivere mai qui la tua password.',
    footer: 'Ripristino: ImageVault + la tua password, con abbastanza pagine.',
  },
  pt: {
    heading: 'Como restaurar este cofre',
    intro:
      'Estas páginas contêm um arquivo criptografado, codificado como imagens QR com correção de erros.',
    steps: [
      '1. Obtenha o ImageVault (extensão ou CLI) ou o decodificador Python de referência na página do projeto abaixo.',
      '2. Digitalize ou fotografe cada página e depois importe os arquivos de imagem (ou o PDF).',
      '3. Digite sua senha. O arquivo original será restaurado.',
    ],
    resilience:
      'Você pode perder ou danificar algumas páginas e ainda restaurar, desde que a maioria sobreviva.',
    project: 'Projeto e decodificador de referência:',
    keyLocation: 'Local da chave:',
    passwordHint: 'Dica de senha:',
    preservation:
      'Guarde com cuidado: imprima a laser, mantenha longe de luz e umidade e guarde cópias em locais separados.',
    warning: 'Esta folha não é criptografada. Nunca escreva sua senha aqui.',
    footer: 'Restaurar: ImageVault + sua senha, com páginas suficientes.',
  },
  ja: {
    heading: 'この保管庫を復元する方法',
    intro:
      'これらのページには、誤り訂正付きQR画像として符号化された暗号化ファイルが含まれています。',
    steps: [
      '1. 下記のプロジェクトページから ImageVault(拡張機能または CLI)または Python リファレンスデコーダーを入手します。',
      '2. すべてのページをスキャンまたは撮影し、画像ファイル(または PDF)を読み込みます。',
      '3. パスワードを入力すると、元のファイルが復元されます。',
    ],
    resilience: '大部分のページが残っていれば、数ページを失ったり傷んだりしても復元できます。',
    project: 'プロジェクトとリファレンスデコーダー:',
    keyLocation: '鍵の保管場所:',
    passwordHint: 'パスワードのヒント:',
    preservation:
      '保管上の注意: レーザープリンターで印刷し、光と湿気を避けて保管し、複数の場所にコピーを保管してください。',
    warning: 'この用紙は暗号化されていません。ここにパスワードを書かないでください。',
    footer: '復元: ImageVault + パスワード、十分なページ数が必要です。',
  },
  zh_CN: {
    heading: '如何恢复此保险库',
    intro: '这些页面包含一个加密文件，以带纠错的二维码图像编码。',
    steps: [
      '1. 从下方的项目页面获取 ImageVault（浏览器扩展或 CLI）或 Python 参考解码器。',
      '2. 扫描或拍摄每一页，然后导入图像文件（或 PDF）。',
      '3. 输入您的密码，即可恢复原始文件。',
    ],
    resilience: '只要大多数页面完好，即使丢失或损坏几页也能恢复。',
    project: '项目与参考解码器:',
    keyLocation: '密钥位置:',
    passwordHint: '密码提示:',
    preservation: '妥善保存：使用激光打印机打印，避光防潮存放，并在不同地点保留副本。',
    warning: '本页未加密。切勿在此写下您的密码。',
    footer: '恢复：ImageVault + 您的密码，以及足够的页面。',
  },
  zh_TW: {
    heading: '如何還原此保險庫',
    intro: '這些頁面包含一個加密檔案，以帶錯誤更正的 QR 圖像編碼。',
    steps: [
      '1. 從下方的專案頁面取得 ImageVault（瀏覽器擴充功能或 CLI）或 Python 參考解碼器。',
      '2. 掃描或拍攝每一頁，然後匯入圖像檔案（或 PDF）。',
      '3. 輸入您的密碼，即可還原原始檔案。',
    ],
    resilience: '只要大多數頁面完好，即使遺失或損壞幾頁也能還原。',
    project: '專案與參考解碼器:',
    keyLocation: '金鑰位置:',
    passwordHint: '密碼提示:',
    preservation: '妥善保存：使用雷射印表機列印，避光防潮存放，並在不同地點保留副本。',
    warning: '本頁未加密。切勿在此寫下您的密碼。',
    footer: '還原：ImageVault + 您的密碼，以及足夠的頁面。',
  },
};

/** The chosen UI locale's copy first, then English as the durable fallback. */
export function instructionLangs(locale?: string): InstructionCopy[] {
  const tag = (locale || 'en').toLowerCase().replace('_', '-');
  let key = 'en';
  if (tag.startsWith('zh')) {
    const traditional = ['tw', 'hk', 'mo', 'hant'].some((t) => tag.includes(t));
    key = traditional ? 'zh_TW' : 'zh_CN';
  } else {
    const prefix = tag.split('-')[0] ?? 'en';
    if (prefix in INSTRUCTIONS) key = prefix;
  }
  const primary = INSTRUCTIONS[key]!;
  return key === 'en' ? [primary] : [primary, INSTRUCTIONS.en!];
}

// --- Text engine seam ----------------------------------------------------------

export interface TextBlockOpts {
  bold?: boolean;
  /** Wrap width in points; unset = the page's text column. */
  maxWidth?: number;
}

/** A measured, reusable piece of text (footers/titles repeat on every page). */
export interface PreparedText {
  height: number;
  draw(page: PDFPage, x: number, yTop: number): void;
}

/**
 * How instruction/label text becomes PDF content. The browser injects a canvas
 * engine (system fonts, any script); the CLI injects a fontkit engine (embedded
 * font, vector). Subclasses implement `prepare`; `block` is a prepare+draw mixin.
 */
export abstract class TextEngine {
  abstract prepare(text: string, size: number, opts?: TextBlockOpts): Promise<PreparedText>;

  async block(
    page: PDFPage,
    text: string,
    x: number,
    yTop: number,
    size: number,
    opts: TextBlockOpts = {},
  ): Promise<number> {
    const prepared = await this.prepare(text, size, opts);
    prepared.draw(page, x, yTop);
    return yTop - prepared.height;
  }
}

/** Vector text via a pdf-lib font; the WinAnsi/black colour helper both engines share. */
export const BLACK = rgb(0, 0, 0);

/** Word-wrap `text` for a pdf-lib font. Re-exported convenience for engines. */
export function wrapForFont(
  text: string,
  size: number,
  maxWidth: number,
  widthOf: (s: string, size: number) => number,
): string[] {
  return wrapText(text, maxWidth, (s) => widthOf(s, size));
}

// --- Sheet assembly ------------------------------------------------------------

export interface BuildPaperInput {
  /** One payload per image (header || shard). */
  imagePayloads: Uint8Array[];
  /** Encode a payload to pixels (codec.encode bound to the paper profile). */
  encodeQr: (payload: Uint8Array) => ImageDataLike;
  /** Encode pixels to embeddable PNG bytes (canvas in browser, fast-png in CLI). */
  pngEncode: (img: ImageDataLike) => Uint8Array | Promise<Uint8Array>;
  /** Build the text engine once the PDFDocument exists (embeds fonts). */
  createTextEngine: (pdf: PDFDocument) => Promise<TextEngine>;
  title?: string | undefined;
  date?: string | undefined;
  locale?: string | undefined;
  includeInstructions?: boolean | undefined;
  passwordHint?: string | undefined;
  keyLocation?: string | undefined;
}

async function addInstructionSheet(
  pdf: PDFDocument,
  text: TextEngine,
  input: BuildPaperInput,
): Promise<void> {
  const page = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - MARGIN;

  for (const copy of instructionLangs(input.locale)) {
    y = (await text.block(page, copy.heading, MARGIN, y, 16, { bold: true })) - 8;
    y = await text.block(page, copy.intro, MARGIN, y, 11);
    y -= 4;
    for (const step of copy.steps) y = await text.block(page, step, MARGIN, y, 11);
    y -= 4;
    y = await text.block(page, copy.resilience, MARGIN, y, 11);
    y -= 6;
    y = await text.block(page, copy.project, MARGIN, y, 11, { bold: true });
    y = (await text.block(page, PROJECT_URL, MARGIN, y, 11)) - 6;
    y = await text.block(page, `${copy.keyLocation} ${input.keyLocation ?? ''}`, MARGIN, y, 11);
    y =
      (await text.block(page, `${copy.passwordHint} ${input.passwordHint ?? ''}`, MARGIN, y, 11)) -
      6;
    y = await text.block(page, copy.preservation, MARGIN, y, 10);
    y = (await text.block(page, copy.warning, MARGIN, y, 10, { bold: true })) - 24;
  }
}

/** Assemble the printable PDF and return its bytes. Fully environment-neutral. */
export async function buildPaperPdf(input: BuildPaperInput): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const text = await input.createTextEngine(pdf);

  if (input.includeInstructions) await addInstructionSheet(pdf, text, input);

  // Per-page furniture is identical on every page — prepare it once.
  const title = input.title ? await text.prepare(input.title, 15, { bold: true }) : undefined;
  const footers: PreparedText[] = [];
  for (const line of [...instructionLangs(input.locale).map((c) => c.footer), PROJECT_URL]) {
    footers.push(await text.prepare(line, 8));
  }
  const footerHeight = footers.reduce((n, f) => n + f.height + 2, 0);

  const total = input.imagePayloads.length;
  for (let i = 0; i < total; i++) {
    const img = input.encodeQr(input.imagePayloads[i]!);
    const png = await pdf.embedPng(await input.pngEncode(img));

    const page = pdf.addPage([A4.w, A4.h]);
    let y = A4.h - MARGIN;
    if (title) {
      title.draw(page, MARGIN, y);
      y -= title.height + 4;
    }
    const meta = [input.date, `Page ${i + 1} / ${total}`].filter(Boolean).join('    ');
    y = (await text.block(page, meta, MARGIN, y, 10)) - 4;

    const footerTop = MARGIN + footerHeight;
    const side = Math.min(A4.w - MARGIN * 2, y - footerTop - 10);
    page.drawImage(png, { x: (A4.w - side) / 2, y: y - side, width: side, height: side });

    let fy = footerTop;
    for (const f of footers) {
      f.draw(page, MARGIN, fy);
      fy -= f.height + 2;
    }
  }

  return pdf.save();
}
