/**
 * The local UI server. The e2e spec (`tests/e2e/cli-ui.spec.ts`) proves the app
 * runs from it in a real browser; this covers the parts a browser will not
 * exercise, which are the ones that keep it safe to run.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectAssets, findWebRoot, startUiServer, startupNotice, type UiServer } from './ui';

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
  it('says where it is and what it costs', () => {
    const notice = startupNotice('http://127.0.0.1:1234/s/x/');
    expect(notice).toContain('http://127.0.0.1:1234/s/x/');
    // The trade-off is the whole reason a CLI user needs telling.
    expect(notice).toMatch(/cache, history and download folder/);
    expect(notice).toContain('Ctrl+C');
  });
});
