/**
 * StegoShard CLI entry point: encrypt a file and store it as resilient images,
 * an opaque binary file, or a decoy database, and back, from a terminal.
 *
 * This file owns the process and nothing else. All the actual work lives in
 * `run(argv, io)`, which takes its streams and prompts as arguments so the whole
 * argument layer can be tested without spawning anything; the only things left
 * here are the real terminal, the exit code, and the one place an error becomes
 * text on stderr.
 *
 * Commands: `save`, `restore`, `estimate`, `gallery-save`, `gallery-restore`,
 * `ui`. Run `stegoshard --help` for usage.
 */

import { run } from './run';
import { nodeIo } from './io';
import { coverReuseHint, toCliFailure } from './errors';

const io = nodeIo();

run(process.argv.slice(2), io)
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const { message, exitCode } = toCliFailure(err);
    // The flag hint is appended here rather than in the classifier, because that
    // classifier also builds the MCP tool-error text and MCP offers no such flag.
    const hint = coverReuseHint(err);
    io.err(`${message}${hint ? ` ${hint}` : ''}\n`);
    process.exit(exitCode);
  });
