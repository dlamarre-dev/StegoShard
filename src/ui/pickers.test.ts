/**
 * The destination / codec / key-mode pickers are duplicated across the extension
 * popup and the web app, and their labels live in eight locale files. Nothing
 * else checks that those stay in step, and the failure mode is silent: a missing
 * key renders as an empty button.
 *
 * These are structural assertions over the shipped HTML, not a DOM test — they
 * run without a browser and still catch the drift that matters.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const PAGES = {
  extension: readFileSync(resolve(ROOT, 'src/ui/app.html'), 'utf8'),
  web: readFileSync(resolve(ROOT, 'src/web/index.html'), 'utf8'),
};

const LOCALES = readdirSync(resolve(ROOT, 'public/_locales'));
const CATALOGS = Object.fromEntries(
  LOCALES.map((code) => [
    code,
    JSON.parse(
      readFileSync(resolve(ROOT, `public/_locales/${code}/messages.json`), 'utf8'),
    ) as Record<string, { message: string }>,
  ]),
);

/** Every `data-i18n="…"` / `data-i18n-file="…"` key referenced by a page. */
function referencedKeys(html: string): string[] {
  return [...html.matchAll(/data-i18n(?:-file)?="([^"]+)"/g)].map((m) => m[1]!);
}

/** The `.seg-item` blocks in a page, as raw HTML. */
function segItems(html: string): string[] {
  return [...html.matchAll(/<div class="seg-item"[\s\S]*?<\/div>/g)].map((m) => m[0]);
}

describe('option pickers', () => {
  it('ships every referenced message key in all eight locales', () => {
    expect(LOCALES.sort()).toEqual(['de', 'en', 'es', 'fr', 'it', 'ja', 'pt', 'zh_TW']);
    for (const [page, html] of Object.entries(PAGES)) {
      for (const key of new Set(referencedKeys(html))) {
        for (const [code, catalog] of Object.entries(CATALOGS)) {
          expect(catalog[key]?.message, `${page} uses ${key}, missing from ${code}`).toBeTruthy();
        }
      }
    }
  });

  it('keeps every locale at the same key set', () => {
    const en = Object.keys(CATALOGS.en!).sort();
    for (const [code, catalog] of Object.entries(CATALOGS)) {
      expect(Object.keys(catalog).sort(), `${code} key parity`).toEqual(en);
    }
  });

  it('gives every option an icon, a short label and a hover hint', () => {
    for (const [page, html] of Object.entries(PAGES)) {
      const items = segItems(html);
      expect(items.length, `${page} has options`).toBeGreaterThan(0);
      for (const item of items) {
        // Attribute order and wrapping are prettier's business, so match loosely.
        expect(item, page).toContain('<input type="radio"');
        expect(item, page).toContain('class="seg-icon"');
        expect(item, page).toContain('class="seg-label"');
        expect(item, page).toContain('class="seg-hint"');
        expect(item, page).toContain('role="tooltip"');
        expect(
          item.match(/data-i18n="/g)?.length,
          `${page}: label + hint keys`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('keeps the short labels short — these buttons are one to three words', () => {
    const shortKeys = [
      'destDisk',
      'destPaper',
      'destBinary',
      'destSqlite',
      'destCloud',
      'destGallery',
      'keyModeEmbedded',
      'keyModeKeyfile',
      'keyModeStego',
      'codecColor',
      'codecQr',
    ];
    for (const [code, catalog] of Object.entries(CATALOGS)) {
      for (const key of shortKeys) {
        const words = catalog[key]!.message.split(/\s+/).length;
        expect(words, `${code}.${key} = "${catalog[key]!.message}"`).toBeLessThanOrEqual(3);
      }
    }
  });

  it('carries all three pickers on both surfaces', () => {
    for (const [page, html] of Object.entries(PAGES)) {
      for (const name of ['dest', 'codec', 'keymode', 'gallery-keymode']) {
        expect(html, `${page} is missing the ${name} picker`).toContain(
          `<input type="radio" name="${name}"`,
        );
      }
      // A visually hidden legend names each radio group for screen readers; the
      // visible heading beside it is not associated with the fieldset.
      const groups = html.match(/<fieldset class="segmented">/g)?.length ?? 0;
      const legends = html.match(/<legend class="sr-only"/g)?.length ?? 0;
      expect(legends, `${page} legends`).toBe(groups);
    }
  });

  it('puts the cloud option behind a hidden .seg-item, which destRadios() reads', () => {
    // app.ts filters on `.closest('.seg-item')` — if `hidden` moved back onto the
    // <label>, Google Photos would show up in builds that cannot use it.
    const item = segItems(PAGES.extension).find((s) => s.includes('value="cloud"'));
    expect(item).toBeTruthy();
    expect(item).toMatch(/<div class="seg-item" id="dest-cloud-label" hidden>/);
    // The web build has no Google Photos at all.
    expect(PAGES.web).not.toContain('value="cloud"');
  });

  it('pairs every single-file wording variant with a base key', () => {
    for (const [page, html] of Object.entries(PAGES)) {
      for (const m of html.matchAll(/data-i18n="([^"]+)"\s+data-i18n-file="([^"]+)"/g)) {
        expect(m[2], `${page}: ${m[1]}`).toBe(`${m[1]}File`);
      }
      // The gallery key picker never writes a single file, so it must not swap.
      const start = html.indexOf('id="gallery-fields"');
      const gallery = html.slice(start, html.indexOf('id="save-btn"', start));
      expect(gallery, `${page} gallery wording`).not.toContain('data-i18n-file');
    }
  });
});
