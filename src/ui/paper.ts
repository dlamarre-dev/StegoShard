/**
 * Paper destination (plan §6): generate a printable PDF of the vault's images
 * using the PAPER robustness profile (high ECC), one QR per page with a
 * readable header (title / date / page x of N) and a short restore footer.
 *
 * An optional instruction sheet (first page) explains how to restore even years
 * later — which tool, where to get it, the steps, and free fields for a key
 * location and a password hint. Restoring from paper works from photos/scans of
 * the pages or from the PDF file itself (see pdf-restore.ts).
 *
 * Text handling: the PDF standard fonts (Helvetica) only cover WinAnsi. Text
 * that fits is drawn as vector text; anything else — CJK instructions,
 * user-entered titles/hints in any language — is rendered by the browser onto
 * a canvas (system fonts cover every script) and embedded as an image, so no
 * font files ship with the app and no language turns into "?????".
 */

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
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

/** Public project page — printed so the data can be restored without the store. */
const PROJECT_URL = 'https://github.com/dlamarre-dev/ImageVault';

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 42;
const LEADING = 1.35; // line height, in ems

export interface PaperOptions {
  keyMode: KeyMode;
  title?: string | undefined;
  date?: string | undefined;
  includeInstructions?: boolean | undefined;
  passwordHint?: string | undefined;
  keyLocation?: string | undefined;
  /** For the 'stego' key mode: cover photo + the password that keys embedding. */
  stego?: { cover: File; password: string } | undefined;
}

// --- Localized instruction copy ----------------------------------------------

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

/** Instruction-sheet copy for every app locale (plus both Chinese scripts).
 *  English is always printed as the durable fallback. */
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
  de: {
    heading: 'So stellen Sie diesen Tresor wieder her',
    intro:
      'Diese Seiten enthalten eine verschlüsselte Datei, kodiert als fehlerkorrigierte QR-Bilder.',
    steps: [
      '1. Holen Sie sich ImageVault (Browser-Erweiterung) oder den Python-Referenzdecoder von der unten angegebenen Projektseite.',
      '2. Scannen oder fotografieren Sie jede Seite und importieren Sie dann die Bilddateien.',
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
      '1. Obtenga ImageVault (extensión de navegador) o el decodificador Python de referencia en la página del proyecto indicada abajo.',
      '2. Escanee o fotografíe cada página y luego importe los archivos de imagen.',
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
      '1. Procurati ImageVault (estensione del browser) o il decodificatore Python di riferimento dalla pagina del progetto qui sotto.',
      '2. Scansiona o fotografa ogni pagina, poi importa i file immagine.',
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
      '1. Obtenha o ImageVault (extensão de navegador) ou o decodificador Python de referência na página do projeto abaixo.',
      '2. Digitalize ou fotografe cada página e depois importe os arquivos de imagem.',
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
      '1. 下記のプロジェクトページから ImageVault(ブラウザ拡張機能)または Python リファレンスデコーダーを入手します。',
      '2. すべてのページをスキャンまたは撮影し、画像ファイルを読み込みます。',
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
      '1. 从下方的项目页面获取 ImageVault(浏览器扩展)或 Python 参考解码器。',
      '2. 扫描或拍摄每一页，然后导入图像文件。',
      '3. 输入您的密码，即可恢复原始文件。',
    ],
    resilience: '只要大多数页面完好，即使丢失或损坏几页也能恢复。',
    project: '项目与参考解码器:',
    keyLocation: '密钥位置:',
    passwordHint: '密码提示:',
    preservation: '妥善保存:使用激光打印机打印，避光防潮存放，并在不同地点保留副本。',
    warning: '本页未加密。切勿在此写下您的密码。',
    footer: '恢复:ImageVault + 您的密码，以及足够的页面。',
  },
  zh_TW: {
    heading: '如何還原此保險庫',
    intro: '這些頁面包含一個加密檔案，以帶錯誤更正的 QR 圖像編碼。',
    steps: [
      '1. 從下方的專案頁面取得 ImageVault(瀏覽器擴充功能)或 Python 參考解碼器。',
      '2. 掃描或拍攝每一頁，然後匯入圖像檔案。',
      '3. 輸入您的密碼，即可還原原始檔案。',
    ],
    resilience: '只要大多數頁面完好，即使遺失或損壞幾頁也能還原。',
    project: '專案與參考解碼器:',
    keyLocation: '金鑰位置:',
    passwordHint: '密碼提示:',
    preservation: '妥善保存:使用雷射印表機列印，避光防潮存放，並在不同地點保留副本。',
    warning: '本頁未加密。切勿在此寫下您的密碼。',
    footer: '還原:ImageVault + 您的密碼，以及足夠的頁面。',
  },
};

/** The browser locale's copy first, then English as the durable fallback. */
function instructionLangs(): InstructionCopy[] {
  const tag = (navigator.language || 'en').toLowerCase();
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

// --- Unicode-safe text drawing -------------------------------------------------

/** Canvas pixels per PDF point — 3× keeps printed text crisp. */
const TEXT_SCALE = 3;

interface TextBlockOpts {
  bold?: boolean;
  /** Wrap width in points; unset = single line (still wrapped if canvas-drawn). */
  maxWidth?: number;
}

/** A measured, reusable piece of text (footers/titles repeat on every page). */
interface PreparedText {
  height: number;
  draw(page: PDFPage, x: number, yTop: number): void;
}

/**
 * Draws text into PDF pages: vector Helvetica when the text is WinAnsi-safe,
 * otherwise a canvas rendering embedded as an opaque image (any script).
 */
class PdfText {
  constructor(
    private pdf: PDFDocument,
    private regular: PDFFont,
    private boldFont: PDFFont,
  ) {}

  private fontFor(bold: boolean): PDFFont {
    return bold ? this.boldFont : this.regular;
  }

  private canEncode(text: string, bold: boolean): boolean {
    try {
      this.fontFor(bold).widthOfTextAtSize(text, 10);
      return true;
    } catch {
      return false;
    }
  }

  /** Prepare a text block; `draw` can then stamp it on any page, any position. */
  async prepare(text: string, size: number, opts: TextBlockOpts = {}): Promise<PreparedText> {
    const bold = opts.bold ?? false;
    const maxWidth = opts.maxWidth ?? A4.w - MARGIN * 2;
    const lineH = size * LEADING;

    if (this.canEncode(text, bold)) {
      const font = this.fontFor(bold);
      const lines = wrapText(text, maxWidth, (s) => font.widthOfTextAtSize(s, size));
      return {
        height: lines.length * lineH,
        draw: (page, x, yTop) => {
          lines.forEach((line, i) => {
            page.drawText(line, { x, y: yTop - size - i * lineH, size, font, color: rgb(0, 0, 0) });
          });
        },
      };
    }

    const image = await this.renderCanvasText(text, size, bold, maxWidth);
    return {
      height: image.height,
      draw: (page, x, yTop) => {
        page.drawImage(image.ref, {
          x,
          y: yTop - image.height,
          width: image.width,
          height: image.height,
        });
      },
    };
  }

  /** Convenience: prepare + draw once, returning the y below the block. */
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

  /** Browser text rendering: system fonts cover every script. */
  private async renderCanvasText(
    text: string,
    size: number,
    bold: boolean,
    maxWidthPt: number,
  ): Promise<{ ref: PDFImage; width: number; height: number }> {
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
    // Opaque white keeps the PDF free of alpha masks and prints identically.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#000000';
    ctx.font = fontSpec;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => ctx.fillText(line, 0, i * lineH + px * 0.08));

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const ref = await this.pdf.embedPng(new Uint8Array(await blob.arrayBuffer()));
    return { ref, width: w / TEXT_SCALE, height: h / TEXT_SCALE };
  }
}

// --- Sheet assembly --------------------------------------------------------------

async function addInstructionSheet(
  pdf: PDFDocument,
  text: PdfText,
  options: PaperOptions,
): Promise<void> {
  const page = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - MARGIN;

  for (const copy of instructionLangs()) {
    y = (await text.block(page, copy.heading, MARGIN, y, 16, { bold: true })) - 8;
    y = await text.block(page, copy.intro, MARGIN, y, 11);
    y -= 4;
    for (const step of copy.steps) y = await text.block(page, step, MARGIN, y, 11);
    y -= 4;
    y = await text.block(page, copy.resilience, MARGIN, y, 11);
    y -= 6;
    y = await text.block(page, copy.project, MARGIN, y, 11, { bold: true });
    y = (await text.block(page, PROJECT_URL, MARGIN, y, 11)) - 6;
    y = await text.block(page, `${copy.keyLocation} ${options.keyLocation ?? ''}`, MARGIN, y, 11);
    y =
      (await text.block(
        page,
        `${copy.passwordHint} ${options.passwordHint ?? ''}`,
        MARGIN,
        y,
        11,
      )) - 6;
    y = await text.block(page, copy.preservation, MARGIN, y, 10);
    y = (await text.block(page, copy.warning, MARGIN, y, 10, { bold: true })) - 24;
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
  const text = new PdfText(
    pdf,
    await pdf.embedFont(StandardFonts.Helvetica),
    await pdf.embedFont(StandardFonts.HelveticaBold),
  );

  if (options.includeInstructions) await addInstructionSheet(pdf, text, options);

  // Per-page furniture is identical on every page — prepare it once so canvas
  // renderings (e.g. a CJK title) embed a single image reused across pages.
  const title = options.title ? await text.prepare(options.title, 15, { bold: true }) : undefined;
  const footers: PreparedText[] = [];
  for (const line of [...instructionLangs().map((c) => c.footer), PROJECT_URL]) {
    footers.push(await text.prepare(line, 8));
  }
  const footerHeight = footers.reduce((n, f) => n + f.height + 2, 0);

  for (let i = 0; i < total; i++) {
    const img = codec.encode(imagePayloads[i]!, PROFILE_PAPER);
    const pngBytes = new Uint8Array(await (await imageDataToPngBlob(img)).arrayBuffer());
    const png = await pdf.embedPng(pngBytes);

    const page = pdf.addPage([A4.w, A4.h]);
    let y = A4.h - MARGIN;
    if (title) {
      title.draw(page, MARGIN, y);
      y -= title.height + 4;
    }
    const meta = [options.date, `Page ${i + 1} / ${total}`].filter(Boolean).join('    ');
    y = (await text.block(page, meta, MARGIN, y, 10)) - 4;

    // Square QR, centered, filling the space between header and footer.
    const footerTop = MARGIN + footerHeight;
    const side = Math.min(A4.w - MARGIN * 2, y - footerTop - 10);
    const qx = (A4.w - side) / 2;
    page.drawImage(png, { x: qx, y: y - side, width: side, height: side });

    let fy = footerTop;
    for (const f of footers) {
      f.draw(page, MARGIN, fy);
      fy -= f.height + 2;
    }
  }

  const bytes = await pdf.save();
  downloadBlob(
    new Blob([bytes as BufferSource], { type: 'application/pdf' }),
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

  return { imageCount: total, setId: setHex, keyMode };
}
