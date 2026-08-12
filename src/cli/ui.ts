/**
 * The local web UI: serve the built web app over loopback so the terminal tool
 * can offer the same guided and expert flows as the browser build, and so the
 * downloadable offline bundle can be run by double-clicking something.
 *
 * A server is not a convenience here, it is the only option: the app is ES
 * modules plus a module worker, and both are blocked on `file://`, so opening
 * `index.html` directly cannot work in any browser.
 *
 * Shared by two entry points, `stegoshard ui` and the `serve.mjs` shipped inside
 * the offline zip, so there is one implementation to reason about.
 *
 * What it deliberately does:
 *  - binds 127.0.0.1 only, never a wildcard, and offers no --host;
 *  - puts a random token in the path, so another user on a shared machine cannot
 *    reach the app by scanning loopback ports, and a page that resolves a name to
 *    127.0.0.1 (DNS rebinding) lands on a 404;
 *  - checks the Host header for the same reason;
 *  - serves from a map built at startup. Nothing joins a request path onto a
 *    directory, so path traversal is not defended against, it is impossible;
 *  - sends `Cache-Control: no-store`. The browser will still keep traces (see
 *    docs/THREAT-MODEL.md), but nothing is invited into a disk cache.
 *
 * It holds no state, exposes no endpoint, and never reads a request body: the
 * secrets live in the page, which the CSP forbids from calling back (`connect-src
 * 'none'`).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveLocale } from '../ui/locales';

/** Content types for what a Vite web build actually emits. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  return (
    (dot === -1 ? undefined : MIME[path.slice(dot).toLowerCase()]) ?? 'application/octet-stream'
  );
}

/**
 * Read a built web tree into `relative path -> bytes`.
 *
 * Every servable path is decided here, before any request exists. Source maps
 * are skipped: they are large and only useful to whoever built the tree.
 */
export function collectAssets(root: string): Map<string, Uint8Array> {
  const assets = new Map<string, Uint8Array>();
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    const rel = name.split('\\').join('/');
    if (rel.endsWith('.map')) continue;
    try {
      // The read *is* the file check. Asking `statSync` first leaves a window in
      // which the path could become something else (CodeQL js/file-system-race),
      // and `scripts/package.ts` reads its build output the same way.
      assets.set(rel, new Uint8Array(readFileSync(join(root, name))));
    } catch (err) {
      // A recursive listing yields directories too, and those are all this is
      // allowed to skip: anything else would silently drop an asset the app
      // needs, and 404 at run time instead.
      if ((err as NodeJS.ErrnoException).code !== 'EISDIR') throw err;
    }
  }
  return assets;
}

export interface UiServer {
  /** The one URL that serves the app, token included. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Where the app is mounted. The trailing slash matters, see `handle`. */
const mount = (token: string): string => `/s/${token}/`;

/**
 * Serve `assets` on loopback. `port` 0 asks the OS for a free one, which is the
 * default: a fixed port is a fixed target and one more thing to collide with.
 */
export function startUiServer(
  assets: Map<string, Uint8Array>,
  port = 0,
  token = randomBytes(12).toString('hex'),
): Promise<UiServer> {
  const base = mount(token);
  const server = createServer((req, res) => handle(req, res, assets, base));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Explicit host: `listen(port)` alone binds every interface, which would put
    // the app on the LAN.
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${bound}${base}`,
        port: bound,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  assets: Map<string, Uint8Array>,
  base: string,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  // Only the loopback names. A request arriving under any other name is either a
  // rebinding attempt or a proxy, and neither should reach the app.
  const host = (req.headers.host ?? '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') {
    res.writeHead(404).end();
    return;
  }

  const path = decodeURIComponent((req.url ?? '/').split('?')[0]!.split('#')[0]!);
  // The build uses relative asset URLs, which resolve against the *page* URL, so
  // the mount point has to end in a slash or every `./assets/…` lands a level up.
  if (`${path}/` === base) {
    res.writeHead(301, { location: base }).end();
    return;
  }
  if (!path.startsWith(base)) {
    res.writeHead(404).end();
    return;
  }

  const rel = path.slice(base.length) || 'index.html';
  const body = assets.get(rel);
  if (!body) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'content-type': mimeFor(rel),
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // The app refuses to run framed anyway; this says so before it loads.
    'x-frame-options': 'DENY',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

/**
 * The built web tree, or null when this build has none.
 *
 * `dist-cli/web-ui/` is what `npm run build:cli` puts beside the bundle and what
 * the npm package ships. The repo checkout is the fallback so `npm run cli ui`
 * works from source after a web build. A `deno compile` binary has neither, which
 * is the case the caller turns into an explanation.
 */
export function findWebRoot(moduleUrl: string): string | null {
  const candidates = [
    new URL('./web-ui/', moduleUrl), // dist-cli/web-ui (published layout)
    new URL('../../web-dist-offline/', moduleUrl), // repo checkout, from src/cli/
  ];
  for (const candidate of candidates) {
    const dir = fileURLToPath(candidate);
    try {
      if (statSync(join(dir, 'index.html')).isFile()) return dir;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/** Best-effort browser launch. Failing to open is not failing to serve. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command!, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined); // no browser, or no permission to run one
    child.unref();
  } catch {
    // Same: the URL is on screen either way.
  }
}

/**
 * The startup notice, per locale.
 *
 * Held here rather than in `public/_locales`, which is the home for *UI* strings:
 * those catalogs are ~40KB each and importing eight of them would put 320KB of
 * JSON into a 7KB launcher, for four lines of terminal output. The keys are the
 * codes from `locales.ts`, so the same eight languages as the app.
 *
 * `$URL$` is substituted rather than concatenated: the address does not come last
 * in every language.
 */
const NOTICE: Record<string, readonly string[]> = {
  en: [
    'StegoShard UI at $URL$',
    'Serving on this machine only; nothing is sent anywhere.',
    "Your browser's cache, history and download folder will hold traces of this session, which the command line on its own does not. See docs/THREAT-MODEL.md.",
    'Leave this running while the tab is open. Ctrl+C to stop.',
  ],
  fr: [
    "Interface StegoShard à l'adresse $URL$",
    "Servie sur cette machine uniquement ; rien n'est envoyé ailleurs.",
    "Le cache, l'historique et le dossier de téléchargement de votre navigateur garderont des traces de cette session, ce que la ligne de commande seule ne fait pas. Voir docs/THREAT-MODEL.md.",
    "Laissez ceci en marche pendant que l'onglet est ouvert. Ctrl+C pour arrêter.",
  ],
  de: [
    'StegoShard-Oberfläche unter $URL$',
    'Wird nur auf diesem Rechner bereitgestellt; nichts wird irgendwohin gesendet.',
    'Cache, Verlauf und Download-Ordner Ihres Browsers behalten Spuren dieser Sitzung, was die Kommandozeile allein nicht tut. Siehe docs/THREAT-MODEL.md.',
    'Lassen Sie dies laufen, solange der Tab offen ist. Ctrl+C zum Beenden.',
  ],
  es: [
    'Interfaz de StegoShard en $URL$',
    'Se sirve solo en este equipo; no se envía nada a ninguna parte.',
    'La caché, el historial y la carpeta de descargas de tu navegador guardarán rastros de esta sesión, algo que la línea de comandos por sí sola no hace. Consulta docs/THREAT-MODEL.md.',
    'Deja esto en ejecución mientras la pestaña esté abierta. Ctrl+C para detener.',
  ],
  it: [
    'Interfaccia StegoShard su $URL$',
    'Servita solo su questa macchina; nulla viene inviato altrove.',
    'La cache, la cronologia e la cartella dei download del browser conserveranno tracce di questa sessione, cosa che la riga di comando da sola non fa. Vedi docs/THREAT-MODEL.md.',
    'Lascia questo in esecuzione mentre la scheda è aperta. Ctrl+C per fermare.',
  ],
  pt: [
    'Interface StegoShard em $URL$',
    'Servida apenas nesta máquina; nada é enviado para fora.',
    'A cache, o histórico e a pasta de transferências do seu navegador guardarão vestígios desta sessão, o que a linha de comandos por si só não faz. Consulte docs/THREAT-MODEL.md.',
    'Deixe isto em execução enquanto o separador estiver aberto. Ctrl+C para parar.',
  ],
  ja: [
    'StegoShard の画面: $URL$',
    'このマシン上でのみ提供されます。どこにも送信されません。',
    'ブラウザーのキャッシュ、履歴、ダウンロードフォルダーにこのセッションの痕跡が残ります。コマンドラインだけでは残りません。docs/THREAT-MODEL.md を参照してください。',
    'タブを開いている間は実行したままにしてください。停止するには Ctrl+C。',
  ],
  zh_TW: [
    'StegoShard 介面：$URL$',
    '僅在這台電腦上提供服務；不會傳送到任何地方。',
    '瀏覽器的快取、瀏覽記錄與下載資料夾會留下這次工作階段的痕跡，只用命令列則不會。請參閱 docs/THREAT-MODEL.md。',
    '請在分頁開啟期間保持執行。按 Ctrl+C 停止。',
  ],
};

/**
 * The language to speak in the terminal.
 *
 * `Intl`'s default locale is the only portable view of this: on Windows it
 * follows the user's regional settings (there is no `LANG` there), and elsewhere
 * it follows `LC_ALL`/`LANG`. `STEGOSHARD_LANG` overrides it, for a user whose
 * system language is not the one they read, and for tests.
 */
export function noticeLocale(env: NodeJS.ProcessEnv = process.env): string {
  let ambient = 'en';
  try {
    ambient = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    // No ICU data: English it is.
  }
  return resolveLocale(env.STEGOSHARD_LANG, ambient);
}

/**
 * What the user is told when the server comes up, in the system language.
 *
 * Only Node prints this, and Node writes to a Windows console through
 * `WriteConsoleW`, so accented and CJK text is not at the mercy of the console's
 * code page (cp850 here). The `.cmd` wrapper's own `echo` output *is*, which is
 * one reason its "install Node" message stays ASCII.
 */
export function startupNotice(url: string, locale = noticeLocale()): string {
  const lines = NOTICE[locale] ?? NOTICE.en!;
  return [...lines.map((line) => line.replace('$URL$', url)), ''].join('\n');
}
