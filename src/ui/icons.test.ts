/**
 * The option icons exist twice over: inline in the two expert pages, and as
 * geometry in `icons.ts` for the wizard, which builds its cards at runtime. The
 * duplication is deliberate (the pages are static markup) but it can drift, and
 * the failure is quiet: the guided flow would show one glyph for a destination
 * and the dense form another.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, iconShapeAttrs } from './icons';

const ROOT = resolve(__dirname, '../..');
const PAGES = {
  extension: readFileSync(resolve(ROOT, 'src/ui/app.html'), 'utf8'),
  web: readFileSync(resolve(ROOT, 'src/web/index.html'), 'utf8'),
};

describe('option icons', () => {
  it('covers every destination, key mode and codec', () => {
    expect(ICON_NAMES.sort()).toEqual(
      [
        'binary',
        'color',
        'disk',
        'embedded',
        'gallery',
        'keyfile',
        'paper',
        'qr',
        'sqlite',
        'stego',
      ].sort(),
    );
  });

  it('draws the same shapes as the inline copies in both expert pages', () => {
    for (const name of ICON_NAMES) {
      for (const [page, html] of Object.entries(PAGES)) {
        for (const attr of iconShapeAttrs(name)) {
          // Path data and coordinates are distinctive enough to identify the
          // shape; attribute order and wrapping are prettier's business.
          expect(html, `${page} is missing ${name}: ${attr}`).toContain(attr);
        }
      }
    }
  });
});
