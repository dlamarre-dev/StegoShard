/**
 * `serve.mjs`: the entry point shipped inside the downloadable offline web
 * bundle, built from this file by `vite.serve.config.ts`.
 *
 * It exists because the bundle cannot be opened by double-clicking `index.html`
 * (ES modules and module workers are blocked on `file://`), which left every user
 * to discover that for themselves and then find an HTTP server. It serves its own
 * directory with the same loopback server the CLI's `ui` command uses, and needs
 * nothing installed beyond Node.
 *
 * Usage: node serve.mjs [--port <n>] [--open]
 */

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { collectAssets, openInBrowser, startUiServer, startupNotice } from './ui';

const { values } = parseArgs({
  options: { port: { type: 'string' }, open: { type: 'boolean' } },
  allowPositionals: false,
});

const port = values.port === undefined ? 0 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`serve: --port must be a port number (got "${values.port}")\n`);
  process.exit(2);
}

// This file sits at the root of the unzipped bundle, beside index.html.
const root = fileURLToPath(new URL('./', import.meta.url));
let assets;
try {
  assets = collectAssets(root);
} catch {
  process.stderr.write(`serve: cannot read the bundle at ${root}\n`);
  process.exit(1);
}
if (!assets.has('index.html')) {
  process.stderr.write(
    `serve: no index.html in ${root}\nRun this from inside the unzipped StegoShard web bundle.\n`,
  );
  process.exit(1);
}

const server = await startUiServer(assets, port);
process.stdout.write(startupNotice(server.url));
if (values.open) openInBrowser(server.url);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
