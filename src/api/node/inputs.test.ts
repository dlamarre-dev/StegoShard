/**
 * Directory expansion for the command-line inputs.
 *
 * Found in review: `walk` followed a symlink back to an ancestor forever, so a
 * folder holding one crashed every command given it. `junction` is what Windows
 * allows without elevation; elsewhere the type is ignored.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { walk } from './inputs';

describe('walk', () => {
  it('ends on a symlink cycle, listing each file once', () => {
    const root = mkdtempSync(join(tmpdir(), 'ss-walk-'));
    const sub = join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(join(root, 'a.txt'), 'a');
    writeFileSync(join(sub, 'b.txt'), 'b');
    symlinkSync(root, join(sub, 'up'), 'junction');

    const names = walk(root)
      .map((p) => basename(p))
      .sort();
    expect(names).toEqual(['a.txt', 'b.txt']);
  });

  it('still follows a link to a directory it has not seen', () => {
    const root = mkdtempSync(join(tmpdir(), 'ss-walk-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'ss-walk-'));
    writeFileSync(join(elsewhere, 'c.txt'), 'c');
    symlinkSync(elsewhere, join(root, 'linked'), 'junction');

    expect(walk(root).map((p) => basename(p))).toEqual(['c.txt']);
  });
});
