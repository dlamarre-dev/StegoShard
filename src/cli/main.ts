/**
 * StegoShard CLI: encrypt a file and store it as resilient images, an opaque
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
import {
  MIN_PASSWORD_LENGTH,
  isStrongNewPassword,
  meetsPasswordFloor,
  passwordStrength,
} from '../ui/password';
import { collectAssets, findWebRoot, openInBrowser, startUiServer, startupNotice } from './ui';
import { t, type CliKey } from './i18n';
import { usage } from './i18n/usage';

const ACCESS_MODES: AccessMode[] = ['plain', 'duress', 'nonpossession'];

/** Parse a `k-of-n` threshold spec. */
function parseThreshold(spec: string): { k: number; n: number } {
  const m = /^(\d+)-of-(\d+)$/.exec(spec.trim());
  if (!m) fail(t('errThresholdShape', { spec }));
  const k = Number(m[1]);
  const n = Number(m[2]);
  if (k < 1 || n < k || n > 255) fail(t('errThresholdRange', { spec }));
  return { k, n };
}

/** Plain-English purpose for each produced file (the app localizes the same set). */
const PURPOSE_KEYS = {
  vault: 'purposeVault',
  archive: 'purposeArchive',
  document: 'purposeDocument',
  photos: 'purposePhotos',
  keyfile: 'purposeKeyfile',
  stegoCover: 'purposeStegoCover',
  share: 'purposeShare',
} as const satisfies Record<FilePurpose, CliKey>;

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
    text: g.count > 1 ? `${t(PURPOSE_KEYS[g.purpose])} (${g.count})` : t(PURPOSE_KEYS[g.purpose]),
  }));
  const width = Math.max(...rendered.map((r) => r.name.length));
  return `${t('outFilesCreated')}\n${rendered
    .map((r) => `  ${r.name.padEnd(width)}  ${r.text}`)
    .join('\n')}\n`;
}

/**
 * What a restore produced. A bundle unpacks to several files, so naming the
 * envelope ("bundle.zip") and one output path would describe neither.
 */
function restoredLine(res: { filename: string; outPath: string; files?: string[] }): string {
  const files = res.files ?? [res.outPath];
  if (files.length === 1) {
    return `${t('outRestoredOne', { name: res.filename, path: files[0]! })}\n`;
  }
  return `${t('outRestoredMany', { count: files.length })}\n${files
    .map((f) => `  ${f}`)
    .join('\n')}\n`;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const PHASE_KEYS = {
  compress: 'phaseCompress',
  encrypt: 'phaseEncrypt',
  decrypt: 'phaseDecrypt',
  verify: 'phaseVerify',
  unlock: 'phaseUnlock',
  render: 'phaseRender',
} as const satisfies Record<Progress['phase'], CliKey>;

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
    const key = PHASE_KEYS[p.phase];
    const label = key ? t(key) : p.phase;
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
    process.stderr.write(`${t('warnPasswordFlag')}\n`);
    pw = values.password;
  } else if (typeof values['password-file'] === 'string') {
    pw = readFileSync(values['password-file'], 'utf8').split(/\r?\n/)[0] ?? '';
  } else if (process.env.STEGOSHARD_PASSWORD) {
    pw = process.env.STEGOSHARD_PASSWORD;
  } else {
    pw = await promptHidden(t('promptPassword'));
  }
  // Reject an empty password from every source, not just the interactive prompt
  // (an empty --password/--password-file/env var would silently gut the KDF).
  if (!pw) fail(t('errNoPassword'));
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
    pw = await promptHidden(t('promptDuressPassword'));
  }
  if (!pw) fail(t('errNoDuressPassword'));
  return pw;
}

async function requireStrongOrAcknowledged(
  password: string,
  values: Record<string, unknown>,
  label = t('labelPassword'),
): Promise<void> {
  if (isStrongNewPassword(password)) return;
  // The hard floor is checked before --allow-weak-password is even consulted: a
  // minimum a flag can switch off is not a minimum. Scripted callers that hit
  // this need a longer password, not another flag.
  if (!meetsPasswordFloor(password)) {
    fail(
      t('errPasswordShort', {
        label,
        length: password.length,
        min: MIN_PASSWORD_LENGTH,
      }),
    );
  }
  const estimate = passwordStrength(password);
  const warning = t('warnWeakPassword', { label, bits: estimate.bits });
  if (values['allow-weak-password'] === true) {
    process.stderr.write(`${warning}\n`);
    return;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    fail(t('errWeakAcknowledge', { warning }));
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${warning}\n${t('promptAllow')}`);
    if (answer !== 'ALLOW') fail(t('errWeakCancelled'));
  } finally {
    rl.close();
  }
}

/**
 * True when an entropy *flag* was typed. The environment variable is deliberately
 * excluded: it is ambient (a user may export it in their shell profile), so it
 * must never turn a restore into an error, while a typed flag on a command that
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
 * actually generate key material, and only *after* the password has been read.
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
    process.stderr.write(`${t('warnEntropyFlag')}\n`);
    text = values.entropy;
  } else if (typeof values['entropy-file'] === 'string') {
    // Whole file, not just the first line: a page of dice rolls is the point.
    const path = values['entropy-file'];
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // A missing or unreadable file must name itself, not surface as a raw
      // ENOENT stack; this runs after the password prompt, deep into the run.
      fail(t('errEntropyFile', { path }));
    }
  } else if (values['entropy-prompt']) {
    // Without a terminal, a "hidden prompt" would swallow whatever is piped in,
    // including a password meant for the password prompt. Refuse instead.
    if (!process.stdin.isTTY) {
      fail(t('errEntropyPromptTty'));
    }
    text = await promptHidden(t('promptEntropy'));
    if (!text) fail(t('errEntropyPromptEmpty'));
  } else if (process.env.STEGOSHARD_ENTROPY) {
    text = process.env.STEGOSHARD_ENTROPY;
  } else {
    return; // no extra layer: plain CSPRNG, exactly as before
  }
  if (!text.trim()) fail(t('errEntropyEmpty'));
  await installUserEntropy(text);
}

const KEY_MODES: KeyMode[] = ['embedded', 'keyfile', 'stego'];

/**
 * Serve the browser UI locally.
 *
 * Handled before the shared option parsing, because it takes none of the save or
 * restore flags and would otherwise have to declare them all to be rejected.
 * Bare `stegoshard` still prints usage: a browser opening itself out of an SSH
 * session or a cron job is the wrong surprise, so this is asked for explicitly.
 */
async function runUi(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: { port: { type: 'string' }, open: { type: 'boolean' } },
  });
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(t('errUiPort', { value: String(values.port) }));
  }

  const root = findWebRoot(import.meta.url);
  // The standalone binaries embed only this bundle, and are compiled without
  // --allow-net so they could not listen anyway. One check covers both: say where
  // the UI does live rather than failing on a missing directory.
  if (!root) {
    process.stderr.write(`${t('errUiNoWebApp')}\n`);
    return 1;
  }

  const server = await startUiServer(collectAssets(root), port);
  process.stdout.write(startupNotice(server.url));
  if (values.open) openInBrowser(server.url);
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => void server.close().then(resolve));
    }
  });
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage());
    return 0;
  }
  if (command === 'ui') return runUi(argv.slice(1));

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
    fail(t('errEntropyWrongCommand', { command }));
  }

  const force = Boolean(values.force);

  const outDir = (values.out as string) ?? '.';

  if (command === 'save') {
    const inputs = positionals;
    if (inputs.length === 0) fail(t('errSaveMissingInputs'));
    const keyMode = ((values['key-mode'] as string) ?? 'embedded') as KeyMode;
    if (!KEY_MODES.includes(keyMode)) fail(t('errSaveKeyMode', { value: keyMode }));
    if (keyMode === 'stego' && !values.cover) fail(t('errSaveStegoCover'));
    const requestedCodec = values.codec as string | undefined;
    const codecProblem = codecArgError(requestedCodec, Boolean(values.paper));
    if (codecProblem) fail(`save: ${codecProblem}`);
    const codec = (requestedCodec ?? 'color') as CodecChoice;
    if (values.binary && values.paper) fail(t('errSaveBinaryPaper'));
    if (values.disguise && !values.binary) fail(t('errSaveDisguise'));
    const binary = values.binary ? (values.disguise ? 'disguised' : 'branded') : undefined;

    // §10 access mode (supported only on the disguised .db path for now).
    const mode = ((values.mode as string | undefined) ?? 'plain') as AccessMode;
    if (!ACCESS_MODES.includes(mode)) fail(t('errSaveMode', { value: mode }));
    if (mode !== 'plain' && binary !== 'disguised') {
      fail(t('errSaveModeNeedsDisguise', { mode }));
    }
    let duressPassword: string | undefined;
    let threshold: { k: number; n: number } | undefined;
    if (mode === 'duress' && !values.decoy) fail(t('errSaveDuressDecoy'));
    if (mode === 'nonpossession') {
      if (!values.threshold) fail(t('errSaveThreshold'));
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
      inputs,
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
    if (res.sizeWarning) {
      process.stderr.write(`${t('warnPrefix', { message: res.sizeWarning })}\n`);
    }
    const what = res.binary
      ? t('outSavedBinary', { variant: res.binary, keyMode: res.keyMode })
      : t('outSavedImages', { count: res.imageCount, keyMode: res.keyMode });
    process.stdout.write(`${t('outSaved', { what })}\n${manifestLines(res.manifest)}`);
    if (res.keyMode !== 'embedded') {
      process.stdout.write(`${t('outKeepKeyArtifact')}\n`);
    }
    return 0;
  }

  if (command === 'restore') {
    if (positionals.length === 0) fail(t('errRestoreMissing'));
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
    process.stderr.write(`${t('outDecoded', { decoded: res.decoded, seen: res.seen })}\n`);
    process.stdout.write(restoredLine(res));
    return 0;
  }

  if (command === 'gallery-save') {
    const secretFile = positionals[0];
    if (!secretFile) fail(t('errGalleryMissingFile'));
    const covers = positionals.slice(1);
    if (covers.length === 0) fail(t('errGalleryNoCovers'));
    const keyMode = ((values['key-mode'] as string) ?? 'embedded') as KeyMode;
    if (!KEY_MODES.includes(keyMode)) fail(t('errGalleryKeyMode', { value: keyMode }));
    if (keyMode === 'stego' && !values.cover) fail(t('errGalleryStegoCover'));
    // §10 mode: gallery supports plain + nonpossession; duress is blocked (§10.11).
    const gMode = ((values.mode as string | undefined) ?? 'plain') as AccessMode;
    if (gMode === 'duress') {
      fail(t('errGalleryDuress'));
    }
    if (!ACCESS_MODES.includes(gMode)) fail(t('errGalleryMode', { value: gMode }));
    let gThreshold: { k: number; n: number } | undefined;
    if (gMode === 'nonpossession') {
      if (!values.threshold) fail(t('errGalleryThreshold'));
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
      `${t('outSavedGallery', {
        files: res.files.length,
        k: res.k,
        m: res.m,
        decoys: res.decoys,
        keyMode: res.keyMode,
      })}\n${manifestLines(res.manifest)}`,
    );
    process.stdout.write(`${t('outGalleryKeep', { k: res.k })}\n`);
    if (res.keyMode !== 'embedded') {
      process.stdout.write(`${t('outGalleryKeepKey')}\n`);
    }
    return 0;
  }

  if (command === 'gallery-restore') {
    if (positionals.length === 0) fail(t('errGalleryRestoreMissing'));
    const password = await resolvePassword(values);
    const res = await runGalleryRestore({
      inputs: positionals,
      outDir,
      password,
      keyPath: values.key as string | undefined,
      sharePaths: values.share as string[] | undefined,
      force,
    });
    process.stderr.write(`${t('outScanned', { seen: res.seen })}\n`);
    process.stdout.write(restoredLine(res));
    return 0;
  }

  if (command === 'estimate') {
    const inputFile = positionals[0];
    if (!inputFile) fail(t('errEstimateMissing'));
    const estProblem = codecArgError(values.codec as string | undefined, Boolean(values.paper));
    if (estProblem) fail(`estimate: ${estProblem}`);
    const estCodec = ((values.codec as string | undefined) ?? 'color') as CodecChoice;
    const { images, k, m } = await runEstimate(inputFile, Boolean(values.paper), estCodec);
    process.stdout.write(`${t('outEstimate', { images, k, m })}\n`);
    return 0;
  }

  fail(t('errUnknownCommand', { command }), 2);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof WrongPasswordError) fail(t('errWrongPassword'));
    if (err instanceof GalleryRestoreError) {
      fail(t('errNoGallery'));
    }
    if (err instanceof MissingKeyError) {
      fail(t('errNeedsKey'));
    }
    if (err instanceof CredentialsNotIndependentError) {
      fail(t('errDuressTooSimilar', { reason: err.reason }));
    }
    fail(err instanceof Error ? err.message : String(err));
  });
