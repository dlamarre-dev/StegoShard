/**
 * StegoShard CLI — encrypt a file into resilient QR images (and back) from a
 * terminal. Reuses the exact `@core` format as the extension and web app, so
 * vaults are interchangeable across all three (and the Python decoder).
 *
 * Commands: `save`, `restore`, `estimate`. Run `stegoshard --help` for usage.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  MissingKeyError,
  WrongPasswordError,
  runEstimate,
  runRestore,
  runSave,
  type SaveOptions,
} from './commands';
import type { KeyMode } from '@core';

const USAGE = `StegoShard — encrypt a file into resilient QR images, and restore it.

Usage:
  stegoshard save <file> [options]
  stegoshard restore <images|folder|zip|pdf ...> [options]
  stegoshard estimate <file> [--paper]

Save options:
  --out <dir>            Output directory (default: current directory)
  --paper                Produce a printable PDF (high-ECC) instead of PNGs
  --zip                  Bundle the PNG set into a single .zip (disk mode)
  --binary               Output one opaque file instead of images (up to 100 MB)
  --disguise             With --binary: give it a SQLite-database header (.db)
  --key-mode <mode>      embedded | keyfile | stego   (default: embedded)
  --cover <image>        Cover photo for --key-mode stego (key hidden in it)
  --title <text>         Human-readable label / PDF title
  --date <text>          Date shown on the pages (default: today)
  --locale <code>        Instruction-sheet language, e.g. fr, ja, zh_TW
  --instructions         Include the restore instruction sheet (paper)
  --password-hint <t>    Password hint printed on the instruction sheet
  --key-location <t>     Where the key is kept, printed on the sheet
  --font <path>          A .ttf/.otf for CJK instruction text (paper)

Restore options:
  --out <dir>            Output directory (default: current directory)
  --key <file|image>     A .key file, a stego image, or a binary key container

Password (any command that needs one), in order of precedence:
  --password <pw>        Discouraged: visible in shell history / process list
  --password-file <path> Read the password from a file (first line)
  STEGOSHARD_PASSWORD    Environment variable
  interactive prompt     Asked (hidden) when none of the above is set

Examples:
  stegoshard save secret.txt --out ./vault
  stegoshard save wallet.dat --key-mode stego --cover cat.jpg --out ./vault
  stegoshard save notes.txt --paper --instructions --locale fr --out ./print
  stegoshard save archive.zip --binary --disguise --out ./vault
  stegoshard restore ./vault --out ./restored
`;

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Read a hidden line from a TTY; fall back to plain stdin when piped. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Piped input: read all of stdin as the password (e.g. `echo pw | stegoshard`).
    return new Promise((resolve) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => (data += c));
      stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      stdin.resume();
    });
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(question);
    let input = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      switch (ch) {
        case '\n':
        case '\r':
        case '': // Ctrl-D (EOT) submits
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(input);
          break;
        case '': // Ctrl-C
          stdin.setRawMode(false);
          reject(new Error('cancelled'));
          break;
        case '': // DEL
        case '\b':
          input = input.slice(0, -1);
          break;
        default:
          input += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function resolvePassword(values: Record<string, unknown>): Promise<string> {
  if (typeof values.password === 'string') {
    process.stderr.write(
      'Warning: --password is visible in your shell history and the process list; ' +
        'prefer STEGOSHARD_PASSWORD, --password-file, or the interactive prompt.\n',
    );
    return values.password;
  }
  if (typeof values['password-file'] === 'string') {
    return readFileSync(values['password-file'], 'utf8').split(/\r?\n/)[0] ?? '';
  }
  if (process.env.STEGOSHARD_PASSWORD) return process.env.STEGOSHARD_PASSWORD;
  const pw = await promptHidden('Password: ');
  if (!pw) fail('no password provided');
  return pw;
}

const KEY_MODES: KeyMode[] = ['embedded', 'keyfile', 'stego'];

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      paper: { type: 'boolean' },
      zip: { type: 'boolean' },
      binary: { type: 'boolean' },
      disguise: { type: 'boolean' },
      'key-mode': { type: 'string' },
      cover: { type: 'string' },
      title: { type: 'string' },
      date: { type: 'string' },
      locale: { type: 'string' },
      instructions: { type: 'boolean' },
      'password-hint': { type: 'string' },
      'key-location': { type: 'string' },
      font: { type: 'string' },
      key: { type: 'string' },
      password: { type: 'string' },
      'password-file': { type: 'string' },
    },
  });

  const outDir = (values.out as string) ?? '.';

  if (command === 'save') {
    const inputFile = positionals[0];
    if (!inputFile) fail('save: missing <file>');
    const keyMode = ((values['key-mode'] as string) ?? 'embedded') as KeyMode;
    if (!KEY_MODES.includes(keyMode)) fail(`save: invalid --key-mode "${keyMode}"`);
    if (keyMode === 'stego' && !values.cover)
      fail('save: --key-mode stego requires --cover <image>');
    if (values.binary && values.paper) fail('save: --binary and --paper are mutually exclusive');
    if (values.disguise && !values.binary) fail('save: --disguise requires --binary');
    const binary = values.binary ? (values.disguise ? 'disguised' : 'branded') : undefined;

    const password = await resolvePassword(values);
    const opts: SaveOptions = {
      inputFile,
      outDir,
      password,
      paper: Boolean(values.paper),
      zip: Boolean(values.zip),
      binary,
      keyMode,
      cover: values.cover as string | undefined,
      title: values.title as string | undefined,
      date: (values.date as string | undefined) ?? new Date().toISOString().slice(0, 10),
      locale:
        (values.locale as string | undefined) ??
        ((process.env.LC_ALL || process.env.LANG || '').split(/[.@]/)[0] || undefined),
      instructions: Boolean(values.instructions),
      passwordHint: values['password-hint'] as string | undefined,
      keyLocation: values['key-location'] as string | undefined,
      fontPath: values.font as string | undefined,
    };

    const res = await runSave(opts);
    if (res.fontWarning) process.stderr.write(`${res.fontWarning}\n`);
    if (res.sizeWarning) process.stderr.write(`Warning: ${res.sizeWarning}\n`);
    const what = res.binary
      ? `binary vault (${res.binary}) [${res.keyMode}]`
      : `${res.imageCount} image(s) [${res.keyMode}]`;
    process.stdout.write(`Saved ${what} to:\n${res.files.map((f) => `  ${f}`).join('\n')}\n`);
    if (res.keyMode !== 'embedded') {
      process.stdout.write('Keep the separate key artifact AND your password to restore.\n');
    }
    return 0;
  }

  if (command === 'restore') {
    if (positionals.length === 0) fail('restore: missing input images/folder/zip/pdf');
    const password = await resolvePassword(values);
    const res = await runRestore({
      inputs: positionals,
      outDir,
      password,
      keyPath: values.key as string | undefined,
    });
    process.stderr.write(`decoded ${res.decoded} of ${res.seen} image(s)\n`);
    process.stdout.write(`Restored ${res.filename} -> ${res.outPath}\n`);
    return 0;
  }

  if (command === 'estimate') {
    const inputFile = positionals[0];
    if (!inputFile) fail('estimate: missing <file>');
    const { images, k, m } = await runEstimate(inputFile, Boolean(values.paper));
    process.stdout.write(`${images} image(s)  (k=${k} data + m=${m} parity)\n`);
    return 0;
  }

  fail(`unknown command "${command}" (try: stegoshard --help)`, 2);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof WrongPasswordError) fail('wrong password');
    if (err instanceof MissingKeyError) {
      fail('this image set needs a separate key (use --key <file|image>)');
    }
    fail(err instanceof Error ? err.message : String(err));
  });
