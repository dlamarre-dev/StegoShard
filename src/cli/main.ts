/**
 * StegoShard CLI — encrypt a file and store it as resilient images, an opaque
 * binary file, or a decoy database (and back) from a terminal. Reuses the exact
 * `@core` format as the extension and web app, so vaults are interchangeable
 * across all three (and the Python decoder).
 *
 * Commands: `save`, `restore`, `estimate`. Run `stegoshard --help` for usage.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import {
  type AccessMode,
  MissingKeyError,
  WrongPasswordError,
  runEstimate,
  runGalleryRestore,
  runGallerySave,
  runRestore,
  runSave,
  codecArgError,
  entropyArgError,
  type CodecChoice,
  type SaveOptions,
} from './commands';
import {
  CredentialsNotIndependentError,
  GalleryRestoreError,
  collapseManifest,
  installUserEntropy,
  type FilePurpose,
  type KeyMode,
  type ManifestEntry,
  type OnProgress,
  type Progress,
} from '@core';
import { isStrongNewPassword, passwordStrength } from '../ui/password';

const ACCESS_MODES: AccessMode[] = ['plain', 'duress', 'nonpossession'];

/** Parse a `k-of-n` threshold spec. */
function parseThreshold(spec: string): { k: number; n: number } {
  const m = /^(\d+)-of-(\d+)$/.exec(spec.trim());
  if (!m) fail(`--threshold must look like "2-of-3" (got "${spec}")`);
  const k = Number(m[1]);
  const n = Number(m[2]);
  if (k < 1 || n < k || n > 255) fail(`--threshold out of range: ${spec} (need 1 ≤ k ≤ n ≤ 255)`);
  return { k, n };
}

/** Plain-English purpose for each produced file (the app localizes the same set). */
const PURPOSE_TEXT: Record<FilePurpose, string> = {
  vault: 'the vault — holds your file',
  archive: 'all images bundled in one .zip',
  document: 'printable sheet',
  photos: 'fragment photos — keep the whole set',
  keyfile: 'separate key — needed with your password',
  stegoCover: 'photo holding the hidden key',
  share: 'recovery share — for one holder',
};

/**
 * "Files created" block for the end of a save.
 *
 * Every destination gets one, not just the deniable ones: `cache.db` and
 * `recovery-1.txt` are anonymous by design, and `stegoshard-a1b2-07.png` still
 * does not say which file holds the key. Numbered runs collapse to first … last
 * so a 40-image save stays readable.
 */
function manifestLines(manifest: readonly ManifestEntry[]): string {
  if (manifest.length === 0) return '';
  const groups = collapseManifest(manifest);
  const rendered = groups.map((g) => ({
    name: g.count > 1 ? `${g.first} … ${g.last}` : g.first,
    text: g.count > 1 ? `${PURPOSE_TEXT[g.purpose]} (${g.count})` : PURPOSE_TEXT[g.purpose],
  }));
  const width = Math.max(...rendered.map((r) => r.name.length));
  return `Files created:\n${rendered
    .map((r) => `  ${r.name.padEnd(width)}  ${r.text}`)
    .join('\n')}\n`;
}

const USAGE = `StegoShard — encrypt a file into resilient images, an opaque binary
file, or a decoy database, and restore it.

Usage:
  stegoshard save <file> [options]
  stegoshard restore <images|folder|zip|pdf ...> [options]
  stegoshard estimate <file> [--paper] [--codec color|qr]
  stegoshard gallery-save <file> <cover-photos|folder ...> [options]
  stegoshard gallery-restore <photos|folder ...> [options]

Save options:
  --out <dir>            Output directory (default: current directory)
  --paper                Produce a printable PDF (high-ECC) instead of PNGs
  --zip                  Bundle the PNG set into a single .zip (disk mode)
  --binary               Output one opaque file instead of images (up to 1 GiB)
  --disguise             With --binary: give it a SQLite-database header (.db)
  --mode <mode>          plain | duress | nonpossession   (.db only; default: plain)
                         duress:        a decoy that opens under a 2nd password
                         nonpossession: gate the vault on threshold shares you can't reach
  --decoy <file>         --mode duress: the plausible decoy file
  --duress-password-file <path>  --mode duress: the 2nd (duress) password
  --threshold <k-of-n>   --mode nonpossession: e.g. 2-of-3 (writes n share files)
  --codec <codec>        color | qr   (default: color; images only, not --paper)
                         color: 8-colour grid, ~3x the bytes per image
                         qr:    plain QR, readable by any phone
  --key-mode <mode>      embedded | keyfile | stego   (default: embedded)
  --cover <image>        Cover photo for --key-mode stego (key hidden in it)
  --title <text>         Human-readable label / PDF title
  --date <text>          Date shown on the pages (default: today)
  --locale <code>        Instruction-sheet language, e.g. fr, ja, zh_TW
  --instructions         Include the restore instruction sheet (paper)
  --password-hint <t>    Password hint printed on the instruction sheet
  --key-location <t>     Where the key is kept, printed on the sheet
  --font <path>          A .ttf/.otf for CJK instruction text (paper)
  --allow-weak-password  Acknowledge and allow a weak password for a new vault

Restore options:
  --out <dir>            Output directory (default: current directory)
  --key <file|image>     A .key file, a stego image, or a binary key container
  --share <file>         A threshold share file (repeatable) for a nonpossession vault

Common:
  --force                Overwrite existing output files (default: refuse)
  --quiet                Suppress the progress indicator on stderr

Password (any command that needs one), in order of precedence:
  --password <pw>        Discouraged: visible in shell history / process list
  --password-file <path> Read the password from a file (first line)
  STEGOSHARD_PASSWORD    Environment variable
  interactive prompt     Asked (hidden) when none of the above is set

Extra entropy for save / gallery-save (optional, expert; affects generation
only — nothing to re-enter on restore, and the OS CSPRNG is always used
regardless), in order of precedence:
  --entropy <text>       Discouraged: visible in shell history / process list
  --entropy-file <path>  Read it from a file (whole contents, e.g. dice rolls)
  --entropy-prompt       Ask for it (hidden) at the terminal (needs a TTY)
  STEGOSHARD_ENTROPY     Environment variable
  Your text is XORed in as a second source: it can only add uncertainty, never
  replace the CSPRNG, so a weak string cannot weaken the vault.

Gallery Mode (a secret hidden, fragmented, across many ordinary photos):
  --out <dir>            Output directory for the modified photos
  --key-mode <mode>      embedded (default) | keyfile | stego   (gallery-save)
  --cover <image>        Cover photo for --key-mode stego (gallery-save)
  --key <file|image>     External key for a keyfile/stego gallery (gallery-restore)
  --mode nonpossession   Gate the gallery on threshold shares (with --threshold k-of-n)
  --share <file>         A threshold share file (repeatable) for gallery-restore
  (duress is not available on gallery — use --binary --disguise --mode duress)
  Every photo is modified; the best K+M carry Reed-Solomon fragments and the
  rest become decoys (min 5 photos total, at least 2 decoys). Restore is blind:
  any photos that authenticate are used, and any K fragments reconstruct.

Examples:
  stegoshard save secret.txt --out ./vault
  stegoshard save wallet.dat --key-mode stego --cover cat.jpg --out ./vault
  stegoshard save notes.txt --paper --instructions --locale fr --out ./print
  stegoshard save archive.zip --binary --disguise --out ./vault
  stegoshard save secret.txt --entropy-file dice.txt --out ./vault
  stegoshard restore ./vault --out ./restored
  stegoshard gallery-save note.txt ./photos --out ./album
  stegoshard gallery-restore ./album --out ./restored
`;

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const PHASE_LABELS: Record<Progress['phase'], string> = {
  compress: 'Compressing',
  encrypt: 'Encrypting',
  decrypt: 'Decrypting',
  verify: 'Verifying',
  unlock: 'Unlocking',
  render: 'Rendering',
};

/**
 * A progress reporter on stderr (results stay on stdout, so piping is unaffected).
 * On a TTY it redraws a single line with a live percentage; when piped it emits one
 * plain line per phase change. Returns undefined when quiet, plus a `done()` to
 * finish the line. The core drives it through the shared `onProgress` callback.
 */
function makeProgress(quiet: boolean): { onProgress?: OnProgress; done: () => void } {
  if (quiet) return { done: () => {} };
  const tty = Boolean(process.stderr.isTTY);
  let lastLabel = '';
  let wroteTty = false;
  const onProgress: OnProgress = (p) => {
    const label = PHASE_LABELS[p.phase] ?? p.phase;
    if (tty) {
      const suffix = p.total > 0 ? `… ${Math.floor((p.done / p.total) * 100)}%` : '…';
      process.stderr.write(`\r\x1b[2K${label}${suffix}`);
      wroteTty = true;
    } else if (label !== lastLabel) {
      process.stderr.write(`${label}…\n`);
      lastLabel = label;
    }
  };
  return {
    onProgress,
    done: () => {
      if (tty && wroteTty) process.stderr.write('\r\x1b[2K');
    },
  };
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
  let pw: string;
  if (typeof values.password === 'string') {
    process.stderr.write(
      'Warning: --password is visible in your shell history and the process list; ' +
        'prefer STEGOSHARD_PASSWORD, --password-file, or the interactive prompt.\n',
    );
    pw = values.password;
  } else if (typeof values['password-file'] === 'string') {
    pw = readFileSync(values['password-file'], 'utf8').split(/\r?\n/)[0] ?? '';
  } else if (process.env.STEGOSHARD_PASSWORD) {
    pw = process.env.STEGOSHARD_PASSWORD;
  } else {
    pw = await promptHidden('Password: ');
  }
  // Reject an empty password from every source, not just the interactive prompt
  // (an empty --password/--password-file/env var would silently gut the KDF).
  if (!pw) fail('no password provided (an empty password is not allowed)');
  return pw;
}

/** The second (duress) password for Mode A: file, env, or an interactive prompt. */
async function resolveDuressPassword(values: Record<string, unknown>): Promise<string> {
  let pw: string;
  if (typeof values['duress-password-file'] === 'string') {
    pw = readFileSync(values['duress-password-file'], 'utf8').split(/\r?\n/)[0] ?? '';
  } else if (process.env.STEGOSHARD_DURESS_PASSWORD) {
    pw = process.env.STEGOSHARD_DURESS_PASSWORD;
  } else {
    pw = await promptHidden('Duress password: ');
  }
  if (!pw) fail('no duress password provided (an empty password is not allowed)');
  return pw;
}

async function requireStrongOrAcknowledged(
  password: string,
  values: Record<string, unknown>,
  label = 'password',
): Promise<void> {
  if (isStrongNewPassword(password)) return;
  const estimate = passwordStrength(password);
  const warning =
    `Warning: the ${label} is weak (estimated ${estimate.bits} bits). ` +
    'Offline vaults can be guessed without contacting you.';
  if (values['allow-weak-password'] === true) {
    process.stderr.write(`${warning}\n`);
    return;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    fail(`${warning} Re-run with --allow-weak-password to acknowledge this risk.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${warning}\nType ALLOW to continue: `);
    if (answer !== 'ALLOW') fail('cancelled: weak password was not acknowledged');
  } finally {
    rl.close();
  }
}

/**
 * True when an entropy *flag* was typed. The environment variable is deliberately
 * excluded: it is ambient (a user may export it in their shell profile), so it
 * must never turn a restore into an error — while a typed flag on a command that
 * generates nothing is a mistake worth naming.
 */
function entropyFlagGiven(values: Record<string, unknown>): boolean {
  return (
    typeof values.entropy === 'string' ||
    typeof values['entropy-file'] === 'string' ||
    values['entropy-prompt'] === true
  );
}

/**
 * Optional extra entropy for this run (expert). Called only by the commands that
 * actually generate key material, and only *after* the password has been read —
 * two prompts cannot share a piped stdin, and the password must win it.
 */
async function installEntropy(values: Record<string, unknown>): Promise<void> {
  const problem = entropyArgError({
    text: values.entropy as string | undefined,
    file: values['entropy-file'] as string | undefined,
    prompt: values['entropy-prompt'] as boolean | undefined,
  });
  if (problem) fail(problem);

  let text: string;
  if (typeof values.entropy === 'string') {
    process.stderr.write(
      'Warning: --entropy is visible in your shell history and the process list; ' +
        'prefer STEGOSHARD_ENTROPY, --entropy-file, or --entropy-prompt.\n',
    );
    text = values.entropy;
  } else if (typeof values['entropy-file'] === 'string') {
    // Whole file, not just the first line: a page of dice rolls is the point.
    const path = values['entropy-file'];
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // A missing or unreadable file must name itself, not surface as a raw
      // ENOENT stack — this runs after the password prompt, deep into the run.
      fail(`--entropy-file: cannot read "${path}"`);
    }
  } else if (values['entropy-prompt']) {
    // Without a terminal, a "hidden prompt" would swallow whatever is piped in —
    // including a password meant for the password prompt. Refuse instead.
    if (!process.stdin.isTTY) {
      fail('--entropy-prompt needs a terminal; use --entropy-file or STEGOSHARD_ENTROPY');
    }
    text = await promptHidden('Extra entropy (type randomly, or paste dice rolls): ');
    if (!text) fail('--entropy-prompt: nothing entered');
  } else if (process.env.STEGOSHARD_ENTROPY) {
    text = process.env.STEGOSHARD_ENTROPY;
  } else {
    return; // no extra layer: plain CSPRNG, exactly as before
  }
  if (!text.trim()) fail('extra entropy was empty (omit it if you do not want the extra layer)');
  await installUserEntropy(text);
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
      mode: { type: 'string' },
      decoy: { type: 'string' },
      threshold: { type: 'string' },
      'duress-password-file': { type: 'string' },
      share: { type: 'string', multiple: true },
      'key-mode': { type: 'string' },
      codec: { type: 'string' },
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
      entropy: { type: 'string' },
      'entropy-file': { type: 'string' },
      'entropy-prompt': { type: 'boolean' },
      force: { type: 'boolean' },
      quiet: { type: 'boolean' },
      'allow-weak-password': { type: 'boolean' },
    },
  });

  // Only `save` and `gallery-save` generate key material. Say so rather than
  // accepting the flags and quietly doing nothing with them.
  if (command !== 'save' && command !== 'gallery-save' && entropyFlagGiven(values)) {
    fail(`${command}: the --entropy options apply to save and gallery-save only`);
  }

  const force = Boolean(values.force);

  const outDir = (values.out as string) ?? '.';

  if (command === 'save') {
    const inputFile = positionals[0];
    if (!inputFile) fail('save: missing <file>');
    const keyMode = ((values['key-mode'] as string) ?? 'embedded') as KeyMode;
    if (!KEY_MODES.includes(keyMode)) fail(`save: invalid --key-mode "${keyMode}"`);
    if (keyMode === 'stego' && !values.cover)
      fail('save: --key-mode stego requires --cover <image>');
    const requestedCodec = values.codec as string | undefined;
    const codecProblem = codecArgError(requestedCodec, Boolean(values.paper));
    if (codecProblem) fail(`save: ${codecProblem}`);
    const codec = (requestedCodec ?? 'color') as CodecChoice;
    if (values.binary && values.paper) fail('save: --binary and --paper are mutually exclusive');
    if (values.disguise && !values.binary) fail('save: --disguise requires --binary');
    const binary = values.binary ? (values.disguise ? 'disguised' : 'branded') : undefined;

    // §10 access mode (supported only on the disguised .db path for now).
    const mode = ((values.mode as string | undefined) ?? 'plain') as AccessMode;
    if (!ACCESS_MODES.includes(mode)) fail(`save: invalid --mode "${mode}"`);
    if (mode !== 'plain' && binary !== 'disguised') {
      fail(`save: --mode ${mode} requires --binary --disguise`);
    }
    let duressPassword: string | undefined;
    let threshold: { k: number; n: number } | undefined;
    if (mode === 'duress' && !values.decoy) fail('save: --mode duress requires --decoy <file>');
    if (mode === 'nonpossession') {
      if (!values.threshold) fail('save: --mode nonpossession requires --threshold k-of-n');
      threshold = parseThreshold(values.threshold as string);
    }

    const password = await resolvePassword(values);
    await requireStrongOrAcknowledged(password, values);
    if (mode === 'duress') {
      duressPassword = await resolveDuressPassword(values);
      await requireStrongOrAcknowledged(duressPassword, values, 'duress password');
    }
    // After the passwords (they get first claim on stdin), before anything is
    // generated.
    await installEntropy(values);
    const opts: SaveOptions = {
      inputFile,
      outDir,
      password,
      paper: Boolean(values.paper),
      zip: Boolean(values.zip),
      binary,
      mode,
      duressPassword,
      decoyFile: values.decoy as string | undefined,
      threshold,
      keyMode,
      codec,
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
      force,
    };

    const progress = makeProgress(Boolean(values.quiet));
    const res = await runSave(opts, progress.onProgress);
    progress.done();
    if (res.fontWarning) process.stderr.write(`${res.fontWarning}\n`);
    if (res.sizeWarning) process.stderr.write(`Warning: ${res.sizeWarning}\n`);
    const what = res.binary
      ? `binary vault (${res.binary}) [${res.keyMode}]`
      : `${res.imageCount} image(s) [${res.keyMode}]`;
    process.stdout.write(`Saved ${what}.\n${manifestLines(res.manifest)}`);
    if (res.keyMode !== 'embedded') {
      process.stdout.write('Keep the separate key artifact AND your password to restore.\n');
    }
    return 0;
  }

  if (command === 'restore') {
    if (positionals.length === 0) fail('restore: missing input images/folder/zip/pdf');
    const password = await resolvePassword(values);
    const progress = makeProgress(Boolean(values.quiet));
    const res = await runRestore(
      {
        inputs: positionals,
        outDir,
        password,
        keyPath: values.key as string | undefined,
        sharePaths: values.share as string[] | undefined,
        force,
      },
      progress.onProgress,
    );
    progress.done();
    process.stderr.write(`decoded ${res.decoded} of ${res.seen} image(s)\n`);
    process.stdout.write(`Restored ${res.filename} -> ${res.outPath}\n`);
    return 0;
  }

  if (command === 'gallery-save') {
    const secretFile = positionals[0];
    if (!secretFile) fail('gallery-save: missing <file>');
    const covers = positionals.slice(1);
    if (covers.length === 0) fail('gallery-save: give cover photos or a folder');
    const keyMode = ((values['key-mode'] as string) ?? 'embedded') as KeyMode;
    if (!KEY_MODES.includes(keyMode)) fail(`gallery-save: invalid --key-mode "${keyMode}"`);
    if (keyMode === 'stego' && !values.cover)
      fail('gallery-save: --key-mode stego requires --cover <image>');
    // §10 mode: gallery supports plain + nonpossession; duress is blocked (§10.11).
    const gMode = ((values.mode as string | undefined) ?? 'plain') as AccessMode;
    if (gMode === 'duress') {
      fail(
        'gallery-save: duress mode is not available on gallery; use --binary --disguise --mode duress',
      );
    }
    if (!ACCESS_MODES.includes(gMode)) fail(`gallery-save: invalid --mode "${gMode}"`);
    let gThreshold: { k: number; n: number } | undefined;
    if (gMode === 'nonpossession') {
      if (!values.threshold) fail('gallery-save: --mode nonpossession requires --threshold k-of-n');
      gThreshold = parseThreshold(values.threshold as string);
    }
    const password = await resolvePassword(values);
    await requireStrongOrAcknowledged(password, values);
    await installEntropy(values);
    const res = await runGallerySave({
      secretFile,
      covers,
      outDir,
      password,
      keyMode,
      keyCover: values.cover as string | undefined,
      mode: gMode as 'plain' | 'nonpossession',
      threshold: gThreshold,
      force,
    });
    process.stdout.write(
      `Saved gallery across ${res.files.length} file(s) ` +
        `(${res.k} data + ${res.m} parity + ${res.decoys} decoy) [${res.keyMode}].\n` +
        manifestLines(res.manifest),
    );
    process.stdout.write(`Keep your password; any ${res.k} of the fragment photos restore it.\n`);
    if (res.keyMode !== 'embedded') {
      process.stdout.write('Keep the separate key artifact too (restore with --key).\n');
    }
    return 0;
  }

  if (command === 'gallery-restore') {
    if (positionals.length === 0) fail('gallery-restore: missing photos/folder');
    const password = await resolvePassword(values);
    const res = await runGalleryRestore({
      inputs: positionals,
      outDir,
      password,
      keyPath: values.key as string | undefined,
      sharePaths: values.share as string[] | undefined,
      force,
    });
    process.stderr.write(`scanned ${res.seen} photo(s)\n`);
    process.stdout.write(`Restored ${res.filename} -> ${res.outPath}\n`);
    return 0;
  }

  if (command === 'estimate') {
    const inputFile = positionals[0];
    if (!inputFile) fail('estimate: missing <file>');
    const estProblem = codecArgError(values.codec as string | undefined, Boolean(values.paper));
    if (estProblem) fail(`estimate: ${estProblem}`);
    const estCodec = ((values.codec as string | undefined) ?? 'color') as CodecChoice;
    const { images, k, m } = await runEstimate(inputFile, Boolean(values.paper), estCodec);
    process.stdout.write(`${images} image(s)  (k=${k} data + m=${m} parity)\n`);
    return 0;
  }

  fail(`unknown command "${command}" (try: stegoshard --help)`, 2);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof WrongPasswordError) fail('wrong password');
    if (err instanceof GalleryRestoreError) {
      fail('no restorable gallery found (wrong password or these are not gallery photos)');
    }
    if (err instanceof MissingKeyError) {
      fail('this image set needs a separate key (use --key <file|image>)');
    }
    if (err instanceof CredentialsNotIndependentError) {
      fail(
        `the duress password is too similar to the real one (${err.reason}); ` +
          'choose an unrelated duress password',
      );
    }
    fail(err instanceof Error ? err.message : String(err));
  });
