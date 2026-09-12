/**
 * The StegoShard command line, minus the process.
 *
 * `run(argv, io)` parses arguments, resolves credentials, calls the orchestration
 * layer and formats the result, but it never touches `process` directly and never
 * exits: every stream, the environment, the TTY flags and the two interactive
 * prompts arrive as a {@link CliIo}, and failures leave as a {@link CliError}.
 * `main.ts` is the only file that owns the process, which is what makes this
 * whole layer testable and what lets a non-interactive mode withhold the prompts.
 *
 * Commands: `save`, `restore`, `estimate`, `gallery-save`, `gallery-restore`,
 * `ui`. Run `stegoshard --help` for usage. The format is the exact same `@core`
 * one the extension, the web app and the Python decoder use.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  type AccessMode,
  runEstimate,
  runGalleryRestore,
  runGallerySave,
  runRestore,
  runSave,
  type CodecChoice,
  type SaveOptions,
} from '../api/node/commands';
import { codecArgError, entropyArgError, exportNumberArgError } from './argcheck';
import { identityLine, mintVaultId } from './identity';
import { CliError, type CliErrorCode, toCliFailure } from './errors';
import type { CliIo } from './io';
import { humanPresenter, type Presenter } from './present';
import { jsonPresenter } from './json';
import { MAX_FILE_BYTES_BINARY_CLI, installUserEntropy, type KeyMode } from '@core';
import {
  MIN_PASSWORD_LENGTH,
  isStrongNewPassword,
  meetsPasswordFloor,
  passwordStrength,
} from '../ui/password';
import { collectAssets, findWebRoot, openInBrowser, startUiServer, startupNotice } from './ui';
import { runMcp } from '../mcp/server';
import { t } from './i18n';
import { usage } from './i18n/usage';

const ACCESS_MODES: AccessMode[] = ['plain', 'duress', 'nonpossession'];

/**
 * Abandon the command with an already-localized message.
 *
 * Throws rather than exiting, so the argument layer is testable: this used to
 * call `process.exit`, which took the test runner down with the first bad flag.
 * The bootstrap in `main.ts` is now the only thing that exits, and under `--json`
 * `run()` catches instead, so the failure becomes the document on stdout. Kept as
 * a `never`-returning helper so it still narrows control flow at its ~40 call
 * sites, none of which had to change.
 */
function fail(message: string, code: CliErrorCode = 'USAGE', exitCode = 1): never {
  throw new CliError(code, message, exitCode);
}

/** Parse a `k-of-n` threshold spec. */
function parseThreshold(spec: string): { k: number; n: number } {
  const m = /^(\d+)-of-(\d+)$/.exec(spec.trim());
  if (!m) fail(t('errThresholdShape', { spec }));
  const k = Number(m[1]);
  const n = Number(m[2]);
  if (k < 1 || n < k || n > 255) fail(t('errThresholdRange', { spec }));
  return { k, n };
}

async function resolvePassword(
  io: CliIo,
  present: Presenter,
  values: Record<string, unknown>,
): Promise<string> {
  let pw: string;
  if (typeof values.password === 'string') {
    present.warn({ code: 'PASSWORD_FLAG_VISIBLE', message: t('warnPasswordFlag') });
    pw = values.password;
  } else if (typeof values['password-file'] === 'string') {
    pw = readFileSync(values['password-file'], 'utf8').split(/\r?\n/)[0] ?? '';
  } else if (io.env.STEGOSHARD_PASSWORD) {
    pw = io.env.STEGOSHARD_PASSWORD;
  } else if (io.promptHidden) {
    pw = await io.promptHidden(t('promptPassword'));
  } else {
    // A mode that withholds the prompt (a machine-readable one) has no business
    // blocking on a human, and must not fall back to reading stdin: piped stdin
    // is not a terminal, so a bare pipe would hang with no prompt to see.
    fail(t('errNoPassword'), 'PASSWORD_REQUIRED');
  }
  // Reject an empty password from every source, not just the interactive prompt
  // (an empty --password/--password-file/env var would silently gut the KDF).
  if (!pw) fail(t('errNoPassword'), 'PASSWORD_REQUIRED');
  return pw;
}

/** The second (duress) password for Mode A: file, env, or an interactive prompt. */
async function resolveDuressPassword(io: CliIo, values: Record<string, unknown>): Promise<string> {
  let pw: string;
  if (typeof values['duress-password-file'] === 'string') {
    pw = readFileSync(values['duress-password-file'], 'utf8').split(/\r?\n/)[0] ?? '';
  } else if (io.env.STEGOSHARD_DURESS_PASSWORD) {
    pw = io.env.STEGOSHARD_DURESS_PASSWORD;
  } else if (io.promptHidden) {
    pw = await io.promptHidden(t('promptDuressPassword'));
  } else {
    fail(t('errNoDuressPassword'), 'PASSWORD_REQUIRED');
  }
  if (!pw) fail(t('errNoDuressPassword'), 'PASSWORD_REQUIRED');
  return pw;
}

async function requireStrongOrAcknowledged(
  io: CliIo,
  present: Presenter,
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
      'PASSWORD_TOO_SHORT',
    );
  }
  const estimate = passwordStrength(password);
  const warning = t('warnWeakPassword', { label, bits: estimate.bits });
  if (values['allow-weak-password'] === true) {
    present.warn({ code: 'WEAK_PASSWORD', message: warning, details: { bits: estimate.bits } });
    return;
  }
  // No confirmation available (piped, or a mode that withholds prompting): refuse
  // rather than accept a weak password silently.
  if (!io.confirm || !io.isStdinTty || !io.isStderrTty) {
    fail(t('errWeakAcknowledge', { warning }), 'PASSWORD_WEAK');
  }
  const answer = await io.confirm(`${warning}\n${t('promptAllow')}`);
  if (answer !== 'ALLOW') fail(t('errWeakCancelled'), 'PASSWORD_WEAK');
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
async function installEntropy(
  io: CliIo,
  present: Presenter,
  values: Record<string, unknown>,
): Promise<void> {
  const problem = entropyArgError({
    text: values.entropy as string | undefined,
    file: values['entropy-file'] as string | undefined,
    prompt: values['entropy-prompt'] as boolean | undefined,
  });
  if (problem) fail(problem, 'ENTROPY_ARG');

  let text: string;
  if (typeof values.entropy === 'string') {
    present.warn({ code: 'ENTROPY_FLAG_VISIBLE', message: t('warnEntropyFlag') });
    text = values.entropy;
  } else if (typeof values['entropy-file'] === 'string') {
    // Whole file, not just the first line: a page of dice rolls is the point.
    const path = values['entropy-file'];
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // A missing or unreadable file must name itself, not surface as a raw
      // ENOENT stack; this runs after the password prompt, deep into the run.
      fail(t('errEntropyFile', { path }), 'ENTROPY_ARG');
    }
  } else if (values['entropy-prompt']) {
    // Without a terminal, a "hidden prompt" would swallow whatever is piped in,
    // including a password meant for the password prompt. Refuse instead. Same
    // answer when the mode withholds prompting altogether.
    if (!io.promptHidden || !io.isStdinTty) {
      fail(t('errEntropyPromptTty'), 'ENTROPY_ARG');
    }
    text = await io.promptHidden(t('promptEntropy'));
    if (!text) fail(t('errEntropyPromptEmpty'), 'ENTROPY_ARG');
  } else if (io.env.STEGOSHARD_ENTROPY) {
    text = io.env.STEGOSHARD_ENTROPY;
  } else {
    return; // no extra layer: plain CSPRNG, exactly as before
  }
  if (!text.trim()) fail(t('errEntropyEmpty'), 'ENTROPY_ARG');
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
async function runUi(io: CliIo, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: { port: { type: 'string' }, open: { type: 'boolean' } },
  });
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(t('errUiPort', { value: String(values.port) }), 'USAGE');
  }

  const root = findWebRoot(import.meta.url);
  // The standalone binaries embed only this bundle, and are compiled without
  // --allow-net so they could not listen anyway. One check covers both: say where
  // the UI does live rather than failing on a missing directory.
  if (!root) {
    io.err(`${t('errUiNoWebApp')}\n`);
    return 1;
  }

  const server = await startUiServer(collectAssets(root), port);
  io.out(startupNotice(server.url));
  if (values.open) openInBrowser(server.url);
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => void server.close().then(resolve));
    }
  });
  return 0;
}

/**
 * Every option the save/restore family accepts.
 *
 * Hoisted out of `run()` so `wantsJson` can derive which ones take a value from
 * the same table `parseArgs` uses. Two copies of that list would drift the first
 * time an option was added, and the drift would be silent.
 */

const OPTIONS = {
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
  'export-number': { type: 'string' },
  quiet: { type: 'boolean' },
  'allow-weak-password': { type: 'boolean' },
  'allow-cover-reuse': { type: 'boolean' },
  json: { type: 'boolean' },
} as const;

/** `--name` for every option above that consumes the next argument. */
const VALUE_FLAGS = new Set(
  Object.entries(OPTIONS)
    .filter(([, spec]) => spec.type === 'string')
    .map(([name]) => `--${name}`),
);

/**
 * Whether this invocation asked for JSON, decided before anything is parsed.
 *
 * It has to be known first, because a *parse* failure must also be reportable as
 * JSON: a caller that asked for a document should never get a bare line of prose
 * because it mistyped a flag. Scanning rather than reading the parsed value
 * costs one subtlety, which is why the value-flag skip exists: in
 * `--title --json`, the `--json` is the title, not a request for JSON, and
 * `--` ends the options.
 */
export function wantsJson(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') return false;
    if (arg === '--json') return true;
    if (VALUE_FLAGS.has(arg)) i++;
  }
  return false;
}

async function runCommand(argv: string[], io: CliIo, present: Presenter): Promise<number> {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    io.out(usage());
    return 0;
  }
  if (command === 'ui') return runUi(io, argv.slice(1));
  // Handled beside `ui` and for the same reason: it takes none of the save or
  // restore flags and would otherwise have to declare them all to reject them.
  if (command === 'mcp') return runMcp(io, argv.slice(1));

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: OPTIONS,
  });

  // Only `save` and `gallery-save` generate key material. Say so rather than
  // accepting the flags and quietly doing nothing with them.
  if (command !== 'save' && command !== 'gallery-save' && entropyFlagGiven(values)) {
    fail(t('errEntropyWrongCommand', { command }));
  }

  // Only `save` writes an identity into an envelope, so `--export-number` means
  // nothing anywhere else. `save` and `gallery-save` run this check inside their
  // own branches, where the destination is known and deniability is the better
  // complaint.
  if (command !== 'save' && command !== 'gallery-save') {
    const wrongCommand = exportNumberArgError({
      value: values['export-number'] as string | undefined,
      command,
    });
    if (wrongCommand) fail(wrongCommand.message, wrongCommand.code);
    // Same rule for --allow-cover-reuse, and for the same reason: only a save
    // embeds into a cover, so accepting it on `restore` would be a flag that
    // quietly does nothing. That is the exact bug this project has now shipped
    // twice -- `--track` on restore, and this -- so it is worth refusing by
    // construction rather than by memory.
    if (values['allow-cover-reuse']) {
      fail(t('errCoverReuseWrongCommand', { command }), 'USAGE');
    }
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

    // Refuse --export-number on a deniable destination BEFORE the mode's own
    // requirements are checked. A user who asked for both has made a mistake
    // about what the tool is for, and telling them "--duress needs --decoy"
    // first would send them off to satisfy a requirement for a command that was
    // never going to run.
    const exportNumber = values['export-number'] as string | undefined;
    const numberError = exportNumberArgError({ value: exportNumber, command, binary, mode });
    if (numberError) fail(numberError.message, numberError.code);
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

    const password = await resolvePassword(io, present, values);
    await requireStrongOrAcknowledged(io, present, password, values);
    if (mode === 'duress') {
      duressPassword = await resolveDuressPassword(io, values);
      await requireStrongOrAcknowledged(io, present, duressPassword, values, 'duress password');
    }
    // After the passwords (they get first claim on stdin), before anything is
    // generated.
    await installEntropy(io, present, values);

    // `!== undefined`, matching the guard above rather than truthiness: that is
    // what stops `--export-number 0` from quietly meaning "no number". The value
    // is already validated, so `Number` here cannot produce NaN or a value
    // `buildPayload` would reject.
    const identity =
      exportNumber !== undefined
        ? { vaultId: mintVaultId(), sequence: Number(exportNumber) }
        : undefined;

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
        ((io.env.LC_ALL || io.env.LANG || '').split(/[.@]/)[0] || undefined),
      instructions: Boolean(values.instructions),
      passwordHint: values['password-hint'] as string | undefined,
      keyLocation: values['key-location'] as string | undefined,
      fontPath: values.font as string | undefined,
      force,
      allowCoverReuse: Boolean(values['allow-cover-reuse']),
      // The terminal is headless and bounded only by the machine's RAM, so it
      // asks for the full 1 GiB budget. The orchestration layer defaults to the
      // conservative 256 MiB figure for embedded callers, so this has to be said
      // out loud rather than inherited.
      maxBytes: MAX_FILE_BYTES_BINARY_CLI,
      identity,
    };

    const progress = present.progress(Boolean(values.quiet));
    const res = await runSave(opts, progress.onProgress);
    progress.done();
    // Nothing to commit and nothing that can fail here: the number came from the
    // user and the tag was minted in memory, so once the artifact exists the line
    // is simply printed. The registry this replaced had a reserve/commit split, a
    // failure mode of its own, and a warning code for when the vault was written
    // but the record was not.
    if (identity) present.note(identityLine(identity.vaultId, identity.sequence));
    // Both of these are English-only at the source (paper.ts and commands.ts
    // build them from literals; only the `warnPrefix` wrapper was localized), so
    // JSON callers key on the code and read the message as a hint.
    if (res.fontWarning) {
      present.warn({ code: 'FONT_FALLBACK', message: res.fontWarning });
    }
    if (res.sizeWarning) {
      present.warn({
        code: 'LARGE_SECRET',
        message: t('warnPrefix', { message: res.sizeWarning }),
      });
    }
    present.save(res);
    return 0;
  }

  if (command === 'restore') {
    if (positionals.length === 0) fail(t('errRestoreMissing'));
    const password = await resolvePassword(io, present, values);
    const progress = present.progress(Boolean(values.quiet));
    const res = await runRestore(
      {
        inputs: positionals,
        outDir,
        password,
        keyPath: values.key as string | undefined,
        sharePaths: values.share as string[] | undefined,
        force,
        maxBytes: MAX_FILE_BYTES_BINARY_CLI, // see the save path above
      },
      progress.onProgress,
    );
    progress.done();

    // Print the number whenever the vault carries one, and compare nothing: the
    // person who chose it is the only thing that knows what it should be. A tool
    // that compared would need a durable record of vault identifiers and access
    // times, which is the artifact docs/THREAT-MODEL.md refuses on every deniable
    // path -- so it is not kept on this path either.
    if (res.identity) present.note(identityLine(res.identity.vaultId, res.identity.sequence));

    present.restore(res);
    return 0;
  }

  if (command === 'gallery-save') {
    // Before the positional requirements, for the same reason as on `save`:
    // gallery is a deniable destination, so --export-number is a category error
    // and asking for cover photos first would answer the wrong question.
    const galleryNumberError = exportNumberArgError({
      value: values['export-number'] as string | undefined,
      command,
    });
    if (galleryNumberError) fail(galleryNumberError.message, galleryNumberError.code);

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
    const password = await resolvePassword(io, present, values);
    await requireStrongOrAcknowledged(io, present, password, values);
    await installEntropy(io, present, values);
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
      allowCoverReuse: Boolean(values['allow-cover-reuse']),
    });
    present.gallerySave(res);
    return 0;
  }

  if (command === 'gallery-restore') {
    if (positionals.length === 0) fail(t('errGalleryRestoreMissing'));
    const password = await resolvePassword(io, present, values);
    const res = await runGalleryRestore({
      inputs: positionals,
      outDir,
      password,
      keyPath: values.key as string | undefined,
      sharePaths: values.share as string[] | undefined,
      force,
    });
    present.galleryRestore(res);
    return 0;
  }

  if (command === 'estimate') {
    const inputFile = positionals[0];
    if (!inputFile) fail(t('errEstimateMissing'));
    const estProblem = codecArgError(values.codec as string | undefined, Boolean(values.paper));
    if (estProblem) fail(`estimate: ${estProblem}`);
    const estCodec = ((values.codec as string | undefined) ?? 'color') as CodecChoice;
    const { images, k, m } = await runEstimate(inputFile, Boolean(values.paper), estCodec);
    present.estimate({ images, k, m });
    return 0;
  }

  fail(t('errUnknownCommand', { command }), 'USAGE', 2);
}

/**
 * Run one invocation of the command line.
 *
 * Two modes, one body. The human mode leaves failures to the bootstrap, which
 * prints them to stderr; the JSON mode catches them here, because under `--json`
 * a failure is itself the document a caller reads off stdout, and letting it
 * escape would hand them a bare line of prose instead.
 *
 * JSON mode also strips the interactive prompts from the io it passes down. That
 * is what makes non-interactivity structural rather than a check that could be
 * forgotten: with no `promptHidden`, the password resolver cannot reach stdin,
 * so a caller with an inherited idle pipe gets `PASSWORD_REQUIRED` instead of
 * hanging forever on a prompt it cannot see.
 */
export async function run(argv: string[], io: CliIo): Promise<number> {
  if (!wantsJson(argv)) return runCommand(argv, io, humanPresenter(io));

  const present = jsonPresenter(io, argv[0] ?? null);
  // `ui` and `mcp` are long-running servers, not commands that produce a result.
  // There is no envelope that could describe either, and `mcp` additionally owns
  // stdout as its JSON-RPC channel, so a second document there would corrupt the
  // protocol. Asking for both is a usage error rather than a silent downgrade.
  if (argv[0] === 'ui' || argv[0] === 'mcp') {
    const failure = new CliError('USAGE', t('errJsonUiUnsupported', { command: argv[0] }));
    present.failure(toCliFailure(failure), failure);
    return failure.exitCode;
  }
  const quiet: CliIo = {
    out: io.out,
    err: io.err,
    env: io.env,
    isStdinTty: io.isStdinTty,
    isStderrTty: io.isStderrTty,
  };
  try {
    return await runCommand(argv, quiet, present);
  } catch (err) {
    const failure = toCliFailure(err);
    present.failure(failure, err);
    return failure.exitCode;
  }
}
