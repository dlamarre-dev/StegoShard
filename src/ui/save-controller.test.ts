import { describe, expect, it, vi, beforeEach } from 'vitest';
import { hasUserEntropy, type VaultKey } from '@core';

// Mock the disk layer (it calls browser download APIs we don't have in node);
// we only care that runSave routes to the right function with the right args.
const saveFileToDisk = vi.fn(async (_file: unknown, _key: unknown, _opts: unknown) => ({
  imageCount: 7,
  setId: 'ab',
  keyMode: 'embedded',
}));
const saveFileToBinary = vi.fn(
  async (_file: unknown, _key: unknown, opts: { variant: 'branded' | 'disguised' }) => ({
    keyMode: 'embedded' as const,
    variant: opts.variant,
  }),
);
const saveGalleryToDisk = vi.fn(async () => ({
  imageCount: 5,
  k: 1,
  m: 2,
  decoys: 2,
  setId: 'cd',
}));
vi.mock('./disk', () => ({ saveFileToDisk, saveFileToBinary, saveGalleryToDisk }));

const { runSave } = await import('./save-controller');

// Echoing localizer: makes the chosen message key + args visible in assertions.
const msg = (k: string, subs?: string | string[]): string =>
  subs === undefined ? k : `${k}:${Array.isArray(subs) ? subs.join(',') : subs}`;

const key = { dek: new Uint8Array(), keyBlock: new Uint8Array() } as unknown as VaultKey;
const file = new File([new Uint8Array([1, 2, 3])], 'secret.txt');

beforeEach(() => {
  saveFileToDisk.mockClear();
  saveFileToBinary.mockClear();
  saveGalleryToDisk.mockClear();
});

describe('runSave routing', () => {
  it('routes disk saves and reports the image count with the embedded note', async () => {
    const { note } = await runSave({ dest: 'disk', file, key, keyMode: 'embedded' }, msg);
    expect(saveFileToDisk).toHaveBeenCalledOnce();
    expect(saveFileToDisk.mock.calls[0]![2]).toMatchObject({ keyMode: 'embedded', asZip: true });
    expect(note).toBe('statusSaved:7');
  });

  it('picks the keyfile note for keyfile mode', async () => {
    const { note } = await runSave({ dest: 'disk', file, key, keyMode: 'keyfile' }, msg);
    expect(note).toBe('statusSavedKeyfile:7');
  });

  it('routes binary saves as the branded variant', async () => {
    const { note } = await runSave({ dest: 'binary', file, key, keyMode: 'embedded' }, msg);
    expect(saveFileToBinary).toHaveBeenCalledOnce();
    expect(saveFileToBinary.mock.calls[0]![2]).toMatchObject({ variant: 'branded' });
    expect(note).toBe('statusSavedBinary:binaryVariantBranded');
  });

  it('routes sqlite saves as the disguised variant with the per-save password', async () => {
    const { note } = await runSave(
      { dest: 'sqlite', file, key, keyMode: 'embedded', password: 'pw' },
      msg,
    );
    expect(saveFileToBinary.mock.calls[0]![2]).toMatchObject({
      variant: 'disguised',
      password: 'pw',
    });
    expect(note).toBe('statusSavedBinary:binaryVariantDisguised');
  });

  it('rejects a disguised .db save with no per-save password', async () => {
    await expect(
      runSave({ dest: 'sqlite', file, key, keyMode: 'embedded' }, msg),
    ).rejects.toThrow();
  });

  it('routes gallery saves with the covers + gallery password, no vault key needed', async () => {
    const covers = [new File([new Uint8Array([9])], 'a.jpg')];
    const { note } = await runSave({ dest: 'gallery', file, covers, galleryPassword: 'pw' }, msg);
    expect(saveGalleryToDisk).toHaveBeenCalledWith(file, covers, 'pw', {
      keyMode: 'embedded',
      stego: undefined,
      mode: 'plain',
      threshold: undefined,
    });
    expect(saveFileToDisk).not.toHaveBeenCalled();
    expect(note).toBe('statusGallerySaved:5');
  });

  it('rejects a gallery save with no password', async () => {
    await expect(runSave({ dest: 'gallery', file, covers: [] }, msg)).rejects.toThrow();
  });

  it('requires a vault key for non-gallery destinations', async () => {
    await expect(runSave({ dest: 'disk', file }, msg)).rejects.toThrow();
  });
});

describe('extra user entropy', () => {
  it('is installed for the duration of the save and cleared afterwards', async () => {
    let installedDuringSave = false;
    saveFileToDisk.mockImplementationOnce(async () => {
      installedDuringSave = hasUserEntropy();
      return { imageCount: 7, setId: 'ab', keyMode: 'embedded' };
    });
    await runSave({ dest: 'disk', file, key, userEntropy: 'dice 4 1 6 2' }, msg);
    expect(installedDuringSave).toBe(true);
    expect(hasUserEntropy()).toBe(false);
  });

  it('is cleared even when the save fails', async () => {
    saveFileToDisk.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await expect(runSave({ dest: 'disk', file, key, userEntropy: 'dice' }, msg)).rejects.toThrow();
    expect(hasUserEntropy()).toBe(false);
  });

  it('reaches the worker path, which has its own module state', async () => {
    await runSave({ dest: 'binary', file, key, userEntropy: 'dice' }, msg);
    expect(saveFileToBinary.mock.calls[0]![2]).toMatchObject({ userEntropy: 'dice' });
  });

  it('installs nothing when the field was left empty', async () => {
    let installedDuringSave = true;
    saveFileToDisk.mockImplementationOnce(async () => {
      installedDuringSave = hasUserEntropy();
      return { imageCount: 7, setId: 'ab', keyMode: 'embedded' };
    });
    await runSave({ dest: 'disk', file, key }, msg);
    expect(installedDuringSave).toBe(false);
  });
});
