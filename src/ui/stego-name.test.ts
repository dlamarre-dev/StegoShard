import { describe, it, expect } from 'vitest';
import { stegoKeyName } from './image-io';

/**
 * The stego key rides inside a photo the user already had, so reusing that
 * photo's own filename is what makes it blend in. The fallback only runs when
 * the picked file has no usable name (a browser File can carry an empty one)
 * and it must not announce the project either.
 */
describe('stegoKeyName', () => {
  it("keeps the cover's own filename, which is the deniable choice", () => {
    expect(stegoKeyName('IMG_2043.png', 'png', 'a1b2c3d4')).toBe('IMG_2043.png');
  });

  it('trims a padded name rather than falling through', () => {
    expect(stegoKeyName('  holiday.jpg  ', 'jpg', 'a1b2c3d4')).toBe('holiday.jpg');
  });

  it('falls back to a generic image name, never the project name', () => {
    for (const blank of [undefined, '', '   ']) {
      const name = stegoKeyName(blank, 'png', 'a1b2c3d4');
      expect(name).toBe('image-a1b2c3d4.png');
      expect(name).not.toMatch(/stegoshard/i);
    }
  });
});
