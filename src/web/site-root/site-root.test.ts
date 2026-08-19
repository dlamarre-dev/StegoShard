/**
 * The files in this directory are served verbatim at the top of the deployed
 * site, and each fails in its own quiet way.
 *
 * A verification token stops verifying: Google re-fetches it and silently drops
 * the property, so a mangled token surfaces weeks later as an unverified site
 * with nothing in any build log to point at. A formatter is the likely culprit,
 * since the file is named `.html` and holds one unterminated line;
 * `.prettierignore` covers that and this pins the bytes regardless.
 *
 * A sitemap goes stale: adding a page to the build does not add it here, and
 * nothing would say so. The URL list is therefore checked against the build's
 * own entry points rather than against a copy of them.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const HERE = resolve(__dirname);
const ROOT = resolve(__dirname, '../../..');
const SITE = 'https://dlamarre-dev.github.io/StegoShard/';

/** Verification tokens, with the exact bytes their issuer gave us. */
const TOKENS: Record<string, string> = {
  'google07799b2e3b937a1e.html': 'google-site-verification: google07799b2e3b937a1e.html',
};

/** Everything else the directory is meant to carry. */
const SITE_FILES = ['llms.txt', 'og.png', 'robots.txt', 'sitemap.xml'];

const read = (name: string): string => readFileSync(resolve(HERE, name), 'utf8');

describe('site-root', () => {
  it('carries exactly the files it is meant to', () => {
    const present = readdirSync(HERE).filter((n) => !n.endsWith('.test.ts'));
    expect(present.sort()).toEqual([...Object.keys(TOKENS), ...SITE_FILES].sort());
  });

  for (const [name, content] of Object.entries(TOKENS)) {
    it(`${name} is byte-exact, with no trailing newline`, () => {
      const raw = read(name);
      expect(raw).toBe(content);
      // Stated separately: a trailing newline is the edit a text editor makes on
      // its own, and it is enough to fail verification.
      expect(raw.endsWith('\n')).toBe(false);
    });
  }
});

describe('sitemap.xml', () => {
  const xml = read('sitemap.xml');
  // Comments stripped first: this file explains in prose which optional elements
  // it leaves out, and naming them there must not read as using them.
  const markup = xml.replace(/<!--[\s\S]*?-->/g, '');
  const locs = [...markup.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);

  it('lists every page the site build emits, and nothing else', () => {
    // Read from the build config rather than restated here: a fourth page added
    // to `rollupOptions.input` must fail this test rather than quietly go
    // unlisted. Matched loosely on the entry names, since the config is TS.
    const config = readFileSync(resolve(ROOT, 'vite.web.config.ts'), 'utf8');
    const inputs = [...config.matchAll(/resolve\(import\.meta\.dirname, 'src\/web\/(\w+)\.html'\)/g)]
      .map((m) => m[1]!)
      .sort();
    expect(inputs.length).toBeGreaterThan(0);

    const expected = inputs.map((name) => (name === 'index' ? SITE : `${SITE}${name}.html`)).sort();
    expect([...locs].sort()).toEqual(expected);
  });

  it('gives absolute URLs under the deployed base', () => {
    for (const loc of locs) expect(loc.startsWith(SITE)).toBe(true);
  });

  it('omits lastmod, changefreq and priority', () => {
    // Deliberate, not forgotten: the Pages checkout is shallow, so a lastmod
    // would stamp every page with the deploy date whether or not it changed,
    // and a lastmod that always moves is one a crawler learns to ignore.
    expect(markup).not.toMatch(/<lastmod>|<changefreq>|<priority>/);
  });
});

describe('robots.txt', () => {
  const txt = read('robots.txt');

  it('points at the sitemap and blocks nothing', () => {
    expect(txt).toContain(`Sitemap: ${SITE}sitemap.xml`);
    expect(txt).toMatch(/^User-agent: \*$/m);
    expect(txt).toMatch(/^Allow: \/$/m);
    expect(txt).not.toMatch(/^Disallow: \S/m);
  });

  it('records that this copy is inert at a project path', () => {
    // The file that crawlers actually read lives at the domain root, in the
    // dlamarre-dev.github.io repository. Anyone editing this one should learn
    // that from the file rather than from an unanswered support question.
    expect(txt).toMatch(/root of a host/i);
  });
});

describe('llms.txt', () => {
  const txt = read('llms.txt');

  it('leads with the name and a summary', () => {
    expect(txt.startsWith('# StegoShard')).toBe(true);
    expect(txt).toMatch(/^> /m);
  });

  it('carries the limits, not just the pitch', () => {
    // The whole point of the file is that a model summarising the project
    // repeats the boundary rather than inferring a stronger claim.
    expect(txt).toContain('not targeted steganalysis');
    expect(txt).toMatch(/pre-1\.0|unaudited/i);
    expect(txt).toMatch(/no password recovery/i);
  });
});

describe('og.png', () => {
  it('is a PNG at the 1200x630 scrapers expect', () => {
    const png = readFileSync(resolve(HERE, 'og.png'));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR width and height, big-endian, at the fixed offsets a PNG header uses.
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });
});
