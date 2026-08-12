/**
 * The help text, rendered from data.
 *
 * The flag names, command lines and examples are literals: they are what the user
 * types, so they are the same in every language. Only the descriptions come from
 * the catalog, and the two-column layout is computed here, which is the whole
 * point of doing it this way: eight hand-aligned copies of a 90-line help text
 * would drift in structure the moment one translation ran long.
 */

import { t, type CliKey } from './index';

/** Column where descriptions start, matching the width the flags need. */
const COL = 25;
/** Wrap width for the whole block, comfortable in an 80-column terminal. */
const WIDTH = 88;

/** A row of the help: a flag (or nothing, for a continuation) and its description. */
type Row = [flag: string, description: CliKey | ''];

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** `  --flag <x>   description`, wrapped to the description column. */
function row([flag, key]: Row): string {
  const label = `  ${flag}`;
  const text = key ? t(key) : '';
  if (!text) return label;
  const lines = wrap(text, WIDTH - COL);
  // A flag wider than the column keeps its own line rather than being truncated.
  const head =
    label.length + 1 > COL
      ? `${label}\n${' '.repeat(COL)}${lines[0]}`
      : `${label.padEnd(COL)}${lines[0]}`;
  return [head, ...lines.slice(1).map((l) => `${' '.repeat(COL)}${l}`)].join('\n');
}

/** A paragraph indented two spaces, wrapped. */
function para(key: CliKey, indent = '  '): string {
  return wrap(t(key), WIDTH - indent.length)
    .map((l) => `${indent}${l}`)
    .join('\n');
}

const COMMANDS = [
  'stegoshard save <file|dir ...> [options]',
  'stegoshard restore <images|folder|zip|pdf ...> [options]',
  'stegoshard estimate <file> [--paper] [--codec color|qr]',
  'stegoshard gallery-save <file> <cover-photos|folder ...> [options]',
  'stegoshard gallery-restore <photos|folder ...> [options]',
  'stegoshard ui [--port <n>] [--open]',
];

const SAVE_ROWS: Row[] = [
  ['--out <dir>', 'helpOut'],
  ['--paper', 'helpPaper'],
  ['--zip', 'helpZip'],
  ['--binary', 'helpBinary'],
  ['--disguise', 'helpDisguise'],
  ['--mode <mode>', 'helpMode'],
  ['', 'helpModeDuress'],
  ['', 'helpModeNonpossession'],
  ['--decoy <file>', 'helpDecoy'],
  ['--duress-password-file <path>', 'helpDuressPasswordFile'],
  ['--threshold <k-of-n>', 'helpThreshold'],
  ['--codec <codec>', 'helpCodec'],
  ['', 'helpCodecColor'],
  ['', 'helpCodecQr'],
  ['--key-mode <mode>', 'helpKeyMode'],
  ['--cover <image>', 'helpCover'],
  ['--title <text>', 'helpTitle'],
  ['--date <text>', 'helpDate'],
  ['--locale <code>', 'helpLocale'],
  ['--instructions', 'helpInstructions'],
  ['--password-hint <t>', 'helpPasswordHint'],
  ['--key-location <t>', 'helpKeyLocation'],
  ['--font <path>', 'helpFont'],
  ['--allow-weak-password', 'helpAllowWeakPassword'],
];

const RESTORE_ROWS: Row[] = [
  ['--out <dir>', 'helpOut'],
  ['--key <file|image>', 'helpKey'],
  ['--share <file>', 'helpShare'],
];

const COMMON_ROWS: Row[] = [
  ['--force', 'helpForce'],
  ['--quiet', 'helpQuiet'],
];

const PASSWORD_ROWS: Row[] = [
  ['--password <pw>', 'helpPasswordFlag'],
  ['--password-file <path>', 'helpPasswordFile'],
  ['STEGOSHARD_PASSWORD', 'helpPasswordEnv'],
  ['interactive prompt', 'helpPasswordPrompt'],
];

const ENTROPY_ROWS: Row[] = [
  ['--entropy <text>', 'helpEntropyFlag'],
  ['--entropy-file <path>', 'helpEntropyFile'],
  ['--entropy-prompt', 'helpEntropyPrompt'],
  ['STEGOSHARD_ENTROPY', 'helpEntropyEnv'],
];

const GALLERY_ROWS: Row[] = [
  ['--out <dir>', 'helpGalleryOut'],
  ['--key-mode <mode>', 'helpGalleryKeyMode'],
  ['--cover <image>', 'helpGalleryCover'],
  ['--key <file|image>', 'helpGalleryKey'],
  ['--mode nonpossession', 'helpGalleryMode'],
  ['--share <file>', 'helpGalleryShare'],
];

const UI_ROWS: Row[] = [
  ['--port <n>', 'helpUiPort'],
  ['--open', 'helpUiOpen'],
];

const EXAMPLES = [
  'stegoshard save secret.txt --out ./vault',
  'stegoshard save wallet.dat --key-mode stego --cover cat.jpg --out ./vault',
  'stegoshard save notes.txt --paper --instructions --locale fr --out ./print',
  'stegoshard save archive.zip --binary --disguise --out ./vault',
  'stegoshard save secret.txt --entropy-file dice.txt --out ./vault',
  'stegoshard restore ./vault --out ./restored',
  'stegoshard gallery-save note.txt ./photos --out ./album',
  'stegoshard gallery-restore ./album --out ./restored',
];

/** The full `--help` text in the active language. */
export function usage(): string {
  const blocks: string[] = [
    wrap(t('helpTagline'), WIDTH).join('\n'),
    '',
    t('helpUsageHeading'),
    ...COMMANDS.map((c) => `  ${c}`),
    '',
    t('helpSaveHeading'),
    para('helpSaveIntro'),
    ...SAVE_ROWS.map(row),
    '',
    t('helpRestoreHeading'),
    ...RESTORE_ROWS.map(row),
    '',
    t('helpCommonHeading'),
    ...COMMON_ROWS.map(row),
    '',
    ...wrap(t('helpPasswordHeading'), WIDTH),
    ...PASSWORD_ROWS.map(row),
    '',
    ...wrap(t('helpEntropyHeading'), WIDTH),
    ...ENTROPY_ROWS.map(row),
    para('helpEntropyNote'),
    '',
    ...wrap(t('helpGalleryHeading'), WIDTH),
    ...GALLERY_ROWS.map(row),
    para('helpGalleryNoDuress'),
    para('helpGalleryNote'),
    '',
    t('helpUiHeading'),
    para('helpUi'),
    ...UI_ROWS.map(row),
    '',
    t('helpExamplesHeading'),
    ...EXAMPLES.map((e) => `  ${e}`),
    '',
  ];
  return blocks.join('\n');
}
