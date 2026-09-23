import { describe, expect, it } from 'vitest';
import { stegoKeyName } from './image-io';

describe('stegoKeyName', () => {
  it('draws an IMG_nnnn name with the extension its bytes call for', () => {
    expect(stegoKeyName('png')).toMatch(/^IMG_\d{4}\.png$/);
    expect(stegoKeyName('jpg')).toMatch(/^IMG_\d{4}\.jpg$/);
  });

  // The cover's own name is the device's (which phone, which second), so it is
  // no longer an input at all; and a set id would tie the key to its files.
  it('is drawn fresh rather than derived from anything', () => {
    const names = new Set(Array.from({ length: 50 }, () => stegoKeyName('jpg')));
    expect(names.size).toBeGreaterThan(40);
  });
});
