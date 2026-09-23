/**
 * What the browser is actually told to call a file.
 *
 * `downloadBlob` used to accept a subdirectory and write `folder/name` into the
 * `download` attribute, on the belief that Chromium would file the download
 * there. It does not — only `chrome.downloads.download({filename})` honours a
 * relative path, and this extension does not request that permission. Every
 * browser sanitises the separator instead, so the folder became a *prefix*:
 * `18265a84d89ddadf_IMG_2043.jpg` for a gallery photo, `app-data-3f9c1e20_cache.db`
 * for a disguised database. Both are artifacts whose entire purpose is to look
 * like nothing in particular, wearing the set id at the front of the name.
 *
 * Nothing in the suite asserted a delivered filename, which is why it shipped.
 * This is the cheap half of the fix: the attribute is a basename, always. The
 * expensive half — that a real save delivers neutral names end to end — is
 * `deniable-names.test.ts` on the Node side and the disguised-database case in
 * `tests/e2e/`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from './image-io';

interface FakeAnchor {
  href: string;
  download: string;
  click: () => void;
  remove: () => void;
}

/** The anchor the last `downloadBlob` call built, with a DOM thin enough to lie in. */
function stubDom(): { anchors: FakeAnchor[]; restore: () => void } {
  const anchors: FakeAnchor[] = [];
  const doc = {
    createElement: () => {
      const a: FakeAnchor = { href: '', download: '', click: () => {}, remove: () => {} };
      anchors.push(a);
      return a;
    },
    body: { appendChild: () => {} },
  };
  const url = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('URL', url);
  return { anchors, restore: () => vi.unstubAllGlobals() };
}

afterEach(() => vi.unstubAllGlobals());

describe('downloadBlob', () => {
  it('asks for the name it was given, verbatim', () => {
    const { anchors } = stubDom();
    downloadBlob(new Blob(['x']), 'IMG_2043.jpg');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.download).toBe('IMG_2043.jpg');
  });

  it('never puts a path separator in the download attribute', () => {
    // The separator is the whole mechanism of the bug: a browser that refuses to
    // create the folder keeps the string and replaces the slash with `_`.
    const { anchors } = stubDom();
    for (const name of ['cache.db', 'recovery.key', 'IMG_2043.jpg', 'recovery-1.txt']) {
      downloadBlob(new Blob(['x']), name);
    }
    for (const a of anchors) {
      expect(a.download).not.toContain('/');
      expect(a.download).not.toContain('\\');
      expect(a.download).not.toMatch(/[0-9a-f]{8}/i);
    }
  });
});
