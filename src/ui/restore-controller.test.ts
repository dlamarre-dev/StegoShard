import { describe, expect, it, vi, beforeEach } from 'vitest';

const restoreFileFromDisk = vi.fn(async () => ({ filename: 'secret.txt' }));
const restoreGalleryFromDisk = vi.fn(async () => ({ filename: 'note.txt' }));
vi.mock('./disk', () => ({ restoreFileFromDisk, restoreGalleryFromDisk }));

const { runRestore } = await import('./restore-controller');

const msg = (k: string, subs?: string | string[]): string =>
  subs === undefined ? k : `${k}:${Array.isArray(subs) ? subs.join(',') : subs}`;

const img = new File([new Uint8Array([1])], 'a.png');

beforeEach(() => {
  restoreFileFromDisk.mockClear();
  restoreGalleryFromDisk.mockClear();
});

describe('runRestore routing', () => {
  it('routes standard restores through restoreFileFromDisk with the key file', async () => {
    const keyFile = new File([new Uint8Array([2])], 'k.key');
    const { filename, note } = await runRestore(
      { mode: 'standard', files: [img], password: 'pw', keyFile },
      msg,
    );
    expect(restoreFileFromDisk).toHaveBeenCalledWith([img], 'pw', keyFile, []);
    expect(filename).toBe('secret.txt');
    expect(note).toBe('statusRestored:secret.txt');
  });

  it('routes gallery restores through restoreGalleryFromDisk (embedded: no key)', async () => {
    const { note } = await runRestore({ mode: 'gallery', files: [img], password: 'pw' }, msg);
    expect(restoreGalleryFromDisk).toHaveBeenCalledWith([img], 'pw', undefined);
    expect(restoreFileFromDisk).not.toHaveBeenCalled();
    expect(note).toBe('statusRestored:note.txt');
  });

  it('forwards the key file to a keyfile/stego gallery restore', async () => {
    const keyFile = new File([new Uint8Array([2])], 'vault.key');
    await runRestore({ mode: 'gallery', files: [img], password: 'pw', keyFile }, msg);
    expect(restoreGalleryFromDisk).toHaveBeenCalledWith([img], 'pw', keyFile);
  });
});
