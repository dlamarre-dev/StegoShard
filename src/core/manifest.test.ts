import { describe, it, expect } from 'vitest';
import { collapseManifest, type ManifestEntry } from './manifest';

const entry = (name: string, purpose: ManifestEntry['purpose'] = 'vault'): ManifestEntry => ({
  name,
  purpose,
});

describe('collapseManifest', () => {
  it('collapses a numbered run to first … last', () => {
    const images = Array.from({ length: 12 }, (_, i) =>
      entry(`stegoshard-a1b2c3d4-${String(i + 1).padStart(2, '0')}.png`),
    );
    const groups = collapseManifest(images);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      purpose: 'vault',
      first: 'stegoshard-a1b2c3d4-01.png',
      last: 'stegoshard-a1b2c3d4-12.png',
      count: 12,
    });
  });

  it('leaves a pair in full — "first … last" of two is longer than both', () => {
    const groups = collapseManifest([
      entry('recovery-1.txt', 'share'),
      entry('recovery-2.txt', 'share'),
    ]);
    expect(groups.map((g) => g.first)).toEqual(['recovery-1.txt', 'recovery-2.txt']);
    expect(groups.every((g) => g.count === 1)).toBe(true);
  });

  it('never merges different purposes, even when adjacent and similar', () => {
    const groups = collapseManifest([entry('cache.db', 'vault'), entry('settings.db', 'keyfile')]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.purpose)).toEqual(['vault', 'keyfile']);
  });

  it('never merges unrelated names that merely share a purpose', () => {
    const groups = collapseManifest([entry('cache.db'), entry('vault.ssbn')]);
    expect(groups).toHaveLength(2);
  });

  it('splits runs that are interrupted', () => {
    const groups = collapseManifest([
      entry('img-1.png'),
      entry('img-2.png'),
      entry('img-3.png'),
      entry('cover.png', 'stegoCover'),
      entry('img-4.png'),
    ]);
    expect(groups.map((g) => [g.first, g.last, g.count])).toEqual([
      ['img-1.png', 'img-3.png', 3],
      ['cover.png', 'cover.png', 1],
      ['img-4.png', 'img-4.png', 1],
    ]);
  });

  it('returns nothing for an empty save', () => {
    expect(collapseManifest([])).toEqual([]);
  });
});
