/**
 * The locally served UI, through both entry points that offer it: the CLI's
 * `stegoshard ui` and the `serve.mjs` inside the downloadable offline bundle.
 *
 * The point of the feature is that the browser app runs from a local server, so
 * the test that matters is a real browser loading it: the app is ES modules plus a
 * module worker, which is exactly what cannot be loaded from `file://` and what a
 * misconfigured `base` or content type would break.
 *
 * The server is spawned here rather than through Playwright's `webServer` because
 * its URL is chosen at runtime (free port, random path token) and printed to
 * stdout, which `webServer` cannot hand back.
 */

import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

const ENTRY_POINTS = [
  { name: 'stegoshard ui', args: ['dist-cli/stegoshard.js', 'ui'], needs: 'dist-cli/web-ui' },
  { name: 'offline serve.mjs', args: ['web-dist-offline/serve.mjs'], needs: 'web-dist-offline' },
] as const;

/** Start one of them and wait for the URL it prints. */
async function start(args: readonly string[]): Promise<{ url: string; stop: () => void }> {
  // `['ignore', 'pipe', 'pipe']` types stdout/stderr as non-null, which is what
  // the URL is read from; nothing is written to the process.
  const child = spawn('node', [...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = (): void => void child.kill();
  const url = await new Promise<string>((ok, no) => {
    let out = '';
    const timer = setTimeout(() => no(new Error(`no URL printed; got: ${out}`)), 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const match = /(http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]+\/)/.exec(out);
      if (match) {
        clearTimeout(timer);
        ok(match[1]!);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      no(new Error(`exited with ${code}: ${out}`));
    });
  });
  return { url, stop };
}

for (const entry of ENTRY_POINTS) {
  test(`${entry.name} serves an app that runs`, async ({ page }) => {
    const built = existsSync(resolve(ROOT, entry.needs));
    // Locally this is a convenience: run the suite without building the CLI
    // first. In CI it would be a hole, so the workflow builds it and a miss is a
    // failure rather than a quiet skip.
    if (process.env.CI) expect(built, `${entry.needs} must be built in CI`).toBe(true);
    test.skip(!built, `${entry.needs} not built`);
    const { url, stop } = await start(entry.args);
    try {
      const offMachine: string[] = [];
      const cspViolations: string[] = [];
      page.on('request', (request) => {
        const target = new URL(request.url());
        if (target.hostname !== '127.0.0.1') offMachine.push(request.url());
      });
      page.on('console', (message) => {
        if (message.text().includes('Content Security Policy')) cspViolations.push(message.text());
      });

      await page.goto(url);
      await expect(page).toHaveTitle(/StegoShard/);
      // Past the chooser: reaching the expert view proves the module graph loaded
      // and ran, which is the whole reason a server is needed at all.
      await page.locator('#choose-expert').click();
      await expect(page.locator('#expert-view')).toBeVisible();
      await expect(page.locator('#file-drop .dz-title')).not.toBeEmpty(); // i18n ran

      expect(offMachine, 'nothing may leave the machine').toEqual([]);
      expect(cspViolations).toEqual([]);

      // The token is the only address the app answers on.
      const origin = new URL(url).origin;
      const wrongToken = `${origin}/s/${'0'.repeat(24)}/`;
      expect((await page.request.get(wrongToken)).status(), 'wrong token').toBe(404);
      expect((await page.request.get(`${origin}/`)).status(), 'bare root').toBe(404);
      expect((await page.request.get(`${url}nope.js`)).status(), 'unknown asset').toBe(404);
      expect(
        (await page.request.get(`${url}../../package.json`, { maxRedirects: 0 })).status(),
        'traversal',
      ).toBe(404);
      // Loopback only: any other Host is a proxy or a rebinding attempt.
      expect(
        (await page.request.get(url, { headers: { host: 'evil.example' } })).status(),
        'foreign Host header',
      ).toBe(404);
    } finally {
      stop();
    }
  });
}
