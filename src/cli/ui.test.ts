/**
 * The local UI server. The e2e spec (`tests/e2e/cli-ui.spec.ts`) proves the app
 * runs from it in a real browser; this covers the parts a browser will not
 * exercise, which are the ones that keep it safe to run.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectAssets,
  findWebRoot,
  noticeLocale,
  startUiServer,
  startupNotice,
  type UiServer,
} from './ui';
import { LOCALE_CODES, resolveLocale } from '../ui/locales';

function fixtureTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'stegoshard-ui-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'main.js'), 'export const x = 1;\n');
  writeFileSync(join(root, 'assets', 'main.js.map'), '{"version":3}');
  writeFileSync(join(root, 'secret-sibling.txt'), 'not served from outside the root');
  return root;
}

let server: UiServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('asset map', () => {
  it('keys every file by its relative path and drops source maps', () => {
    const assets = collectAssets(fixtureTree());
    expect([...assets.keys()].sort()).toEqual([
      'assets/main.js',
      'index.html',
      'secret-sibling.txt',
    ]);
    // Forward slashes on every platform: the keys are compared against URL paths.
    for (const key of assets.keys()) expect(key).not.toContain('\\');
  });

  it('finds no web root when a build carries none', () => {
    // What a `deno compile` binary looks like: no ./web-ui/ beside it, and no
    // repo checkout above it.
    const nowhere = mkdtempSync(join(tmpdir(), 'stegoshard-empty-'));
    expect(findWebRoot(`file:///${nowhere.split('\\').join('/')}/stegoshard.js`)).toBeNull();
  });
});

describe('serving', () => {
  const get = async (
    url: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> => {
    const res = await fetch(url, { headers, redirect: 'manual' });
    return { status: res.status, body: await res.text() };
  };

  it('answers only on its token path, and never outside the map', async () => {
    server = await startUiServer(collectAssets(fixtureTree()), 0, 'a'.repeat(24));
    const { url } = server;
    const origin = new URL(url).origin;

    expect((await get(url)).body).toContain('<!doctype html>');
    expect((await get(`${url}assets/main.js`)).status).toBe(200);
    // A map is not in the map.
    expect((await get(`${url}assets/main.js.map`)).status).toBe(404);
    // Nothing addressable without the token, and nothing above the root. The
    // server never joins a request path onto a directory, so these are misses in
    // a lookup table rather than paths that have to be sanitised.
    expect((await get(`${origin}/`)).status).toBe(404);
    expect((await get(`${origin}/index.html`)).status).toBe(404);
    expect((await get(`${origin}/s/${'b'.repeat(24)}/`)).status).toBe(404);
    expect((await get(`${url}../secret-sibling.txt`)).status).toBe(404);
    expect((await get(`${url}%2e%2e%2fsecret-sibling.txt`)).status).toBe(404);
  });

  it('redirects the mount point to its trailing slash', async () => {
    // The build uses relative asset URLs, so without the slash every `./assets/…`
    // would resolve one level too high and 404.
    server = await startUiServer(collectAssets(fixtureTree()), 0, 'c'.repeat(24));
    const bare = server.url.replace(/\/$/, '');
    const res = await fetch(bare, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(new URL(server.url).pathname);
  });

  it('refuses a request that arrives under any other name', async () => {
    server = await startUiServer(collectAssets(fixtureTree()), 0, 'd'.repeat(24));
    // `fetch` cannot do this: undici treats Host as a forbidden header and drops
    // the override, so the check would silently pass against the real Host.
    const withHost = (host: string): Promise<number> =>
      new Promise((ok, no) => {
        const target = new URL(server!.url);
        const req = request(
          {
            host: '127.0.0.1',
            port: Number(target.port),
            path: target.pathname,
            headers: { host },
          },
          (res) => {
            res.resume();
            ok(res.statusCode ?? 0);
          },
        );
        req.on('error', no);
        req.end();
      });

    expect(await withHost('evil.example')).toBe(404);
    expect(await withHost('127.0.0.1')).toBe(200);
    expect(await withHost('localhost')).toBe(200);
  });

  /**
   * A raw socket, because no HTTP client will send this: `fetch` and
   * `node:http` both reject or normalise a malformed path client-side, so a test
   * written with either would pass while the server still died.
   */
  const rawRequest = (port: number, line: string): Promise<string> =>
    new Promise((ok, no) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`${line} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      let out = '';
      socket.setTimeout(4000, () => no(new Error(`no response to ${line}`)));
      socket.on('data', (chunk: Buffer) => (out += chunk.toString()));
      socket.on('close', () => ok(out.split('\r\n')[0] ?? ''));
      socket.on('error', no);
    });

  it('survives a malformed URL instead of dying on it', async () => {
    server = await startUiServer(collectAssets(fixtureTree()), 0, 'g'.repeat(24));
    // `GET /%` used to throw URIError out of the request callback, which is an
    // uncaught exception: the process exited, ending the user's session. Anything
    // on the machine could send it.
    expect(await rawRequest(server.port, 'GET /%')).toContain('400');
    expect(await rawRequest(server.port, 'GET /%zz/index.html')).toContain('400');
    expect(await rawRequest(server.port, `GET ${new URL(server.url).pathname}%e0%a4%a`)).toContain(
      '400',
    );
    // Still serving, which is the whole point.
    expect((await fetch(server.url)).status).toBe(200);
  });

  it('accepts no method that could carry a body', async () => {
    server = await startUiServer(collectAssets(fixtureTree()), 0, 'e'.repeat(24));
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(server.url, { method, redirect: 'manual' });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    }
  });

  it('sends headers that keep the page out of a disk cache and out of a frame', async () => {
    server = await startUiServer(collectAssets(fixtureTree()), 0, 'f'.repeat(24));
    const res = await fetch(server.url);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('binds loopback only', async () => {
    server = await startUiServer(collectAssets(fixtureTree()), 0);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{24}\/$/);
  });
});

describe('startup notice', () => {
  const URL_ = 'http://127.0.0.1:1234/s/x/';

  it('says where it is and what it costs', () => {
    const notice = startupNotice(URL_, 'en');
    expect(notice).toContain(URL_);
    // The trade-off is the whole reason a CLI user needs telling.
    expect(notice).toMatch(/cache, history and download folder/);
    expect(notice).toContain('Ctrl+C');
  });

  it('speaks every language the app does', () => {
    // A tenth locale added to the list without a notice would otherwise show up
    // as silent English for those users.
    for (const code of LOCALE_CODES) {
      const notice = startupNotice(URL_, code);
      expect(notice, code).toContain(URL_);
      expect(notice, code).toContain('Ctrl+C');
      if (code !== 'en') {
        expect(notice, `${code} is still the English text`).not.toContain(
          'Serving on this machine',
        );
      }
    }
    // The address is placed, not appended: it comes mid-sentence in some.
    expect(startupNotice(URL_, 'ja').split('\n')[0]).toBe(`StegoShard の画面: ${URL_}`);
    expect(startupNotice(URL_, 'fr')).toContain("à l'adresse " + URL_);
    // Substituted exactly once, and no placeholder survives.
    for (const code of LOCALE_CODES) {
      expect(startupNotice(URL_, code).split(URL_).length - 1, code).toBe(1);
      expect(startupNotice(URL_, code), code).not.toContain('$URL$');
    }
  });

  it('falls back to English for a locale it does not carry', () => {
    expect(startupNotice(URL_, 'sv')).toContain('Serving on this machine');
  });
});

describe('notice language', () => {
  it('follows the system, and lets the environment override it', () => {
    // `Intl`'s default is the only portable source: Windows sets no LANG.
    const ambient = Intl.DateTimeFormat().resolvedOptions().locale;
    expect(noticeLocale({})).toBe(resolveLocale(null, ambient));
    expect(noticeLocale({ STEGOSHARD_LANG: 'ja' })).toBe('ja');
    expect(noticeLocale({ STEGOSHARD_LANG: 'pt-BR' })).toBe('pt');
    // An unsupported override is ignored rather than fatal.
    expect(noticeLocale({ STEGOSHARD_LANG: 'sv' })).toBe(resolveLocale(null, ambient));
  });
});
