import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * The discovery and preview layer, checked on built artifacts and on the served
 * site rather than on the plugin that produces them.
 *
 * It lives in the browser suite rather than in vitest for a practical reason:
 * `npm run ci:node` runs the unit tests *before* anything is built, so a unit
 * test asserting on `web-dist/` would skip in CI and pass locally, which is the
 * worst of both. This job builds the Pages output and the offline bundle first.
 *
 * The part that breaks silently is the gating. `seoMeta` injects absolute URLs
 * and must run for the Pages build and not for the offline bundle, where a
 * canonical would point a file:// copy at a website it is not. Both are on disk
 * here, so both can be asserted.
 */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const PAGES_DIR = resolve(ROOT, 'web-dist');
const OFFLINE_DIR = resolve(ROOT, 'web-dist-offline');
const SITE = 'https://dlamarre-dev.github.io/StegoShard/';

const PAGES = [
  { file: 'index.html', canonical: SITE },
  { file: 'privacy.html', canonical: `${SITE}privacy.html` },
  { file: 'terms.html', canonical: `${SITE}terms.html` },
];

const read = (dir: string, file: string): string => readFileSync(resolve(dir, file), 'utf8');
const attr = (html: string, re: RegExp): string | undefined => re.exec(html)?.[1];
const DESCRIPTION = /name="description"\s+content="([^"]*)"/;

for (const page of PAGES) {
  test(`${page.file} carries its search and preview metadata`, () => {
    const html = read(PAGES_DIR, page.file);

    // Exactly one: the page source carries the description, and an earlier
    // version of the plugin injected a second, different one.
    expect([...html.matchAll(/name="description"/g)]).toHaveLength(1);
    const description = attr(html, DESCRIPTION);
    expect(description!.length).toBeGreaterThan(50);

    expect(attr(html, /rel="canonical"\s+href="([^"]*)"/)).toBe(page.canonical);
    expect(attr(html, /property="og:url"\s+content="([^"]*)"/)).toBe(page.canonical);
    expect(attr(html, /name="twitter:card"\s+content="([^"]*)"/)).toBe('summary_large_image');
    expect(attr(html, /property="og:image"\s+content="([^"]*)"/)).toBe(`${SITE}og.png`);

    // Read out of the page for this reason: drift between the three is invisible
    // in a browser and shows up only in a search result or a shared link.
    const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1]?.trim();
    expect(attr(html, /property="og:description"\s+content="([^"]*)"/)).toBe(description);
    expect(attr(html, /name="twitter:description"\s+content="([^"]*)"/)).toBe(description);
    expect(attr(html, /property="og:title"\s+content="([^"]*)"/)).toBe(title);
    expect(attr(html, /name="twitter:title"\s+content="([^"]*)"/)).toBe(title);
  });

  test(`${page.file} in the offline bundle gets no absolute-URL tags`, () => {
    test.skip(!existsSync(resolve(OFFLINE_DIR, page.file)), 'offline bundle not built');
    const html = read(OFFLINE_DIR, page.file);
    expect(html).not.toMatch(/rel="canonical"|og:url|og:image|twitter:card/);
    // The description is page source, not injected, so it travels with the
    // bundle and is expected. Only the absolute-URL tags are gated.
    expect(html).toMatch(/name="description"/);
  });
}

test('the site serves its discovery files', async ({ request }) => {
  for (const [path, must] of [
    ['sitemap.xml', `<loc>${SITE}</loc>`],
    ['robots.txt', `Sitemap: ${SITE}sitemap.xml`],
    ['llms.txt', '# StegoShard'],
    ['google07799b2e3b937a1e.html', 'google-site-verification'],
  ] as const) {
    const res = await request.get(`./${path}`);
    expect(res.status(), path).toBe(200);
    expect(await res.text(), path).toContain(must);
  }
});

test('the preview image is served, and is the size the tags promise', async ({ request }) => {
  // The tags declare 1200x630. A scraper that cannot fetch the image, or finds a
  // different size, silently falls back to no preview at all.
  const res = await request.get('./og.png');
  expect(res.status()).toBe(200);
  const png = await res.body();
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(png.readUInt32BE(16)).toBe(1200);
  expect(png.readUInt32BE(20)).toBe(630);
});
