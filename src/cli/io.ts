/**
 * Everything `run()` touches outside the filesystem: two output streams, the
 * environment, whether we are on a terminal, and the two interactive prompts.
 *
 * Injected rather than reached for, so a test can drive the whole argument layer
 * with captured streams and no real TTY, and so the coming non-interactive modes
 * can withhold the prompts **structurally**. `promptHidden` and `confirm` are
 * optional for that reason: a mode that must never block on a human simply does
 * not supply them, and every call site has to handle their absence to compile.
 * An `isStdinTty` check would not be enough, because piped stdin is not a
 * terminal and `promptHidden` reads it whole.
 */

export interface CliIo {
  /** Command results. Keep machine-readable output here and nothing else. */
  out(text: string): void;
  /** Progress, warnings and diagnostics. Never results. */
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  isStdinTty: boolean;
  isStderrTty: boolean;
  /**
   * Read a secret without echoing it. Absent when the mode forbids prompting.
   * `question` is written to stderr, so stdout stays clean.
   */
  promptHidden?: (question: string) => Promise<string>;
  /**
   * Ask for a typed confirmation and return the answer verbatim. Absent when the
   * mode forbids prompting.
   */
  confirm?: (question: string) => Promise<string>;
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
        case '\x04': // Ctrl-D (EOT) submits
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(input);
          break;
        case '\x03': // Ctrl-C
          stdin.setRawMode(false);
          reject(new Error('cancelled'));
          break;
        case '\x7f': // DEL
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

async function confirm(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** The real terminal: both streams, the real environment, both prompts. */
export function nodeIo(): CliIo {
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    env: process.env,
    isStdinTty: Boolean(process.stdin.isTTY),
    isStderrTty: Boolean(process.stderr.isTTY),
    promptHidden,
    confirm,
  };
}
