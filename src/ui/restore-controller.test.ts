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
    // Args: files, password, keyFile, extraPayloads, onProgress, secret. onProgress
    // and secret are undefined here (no progress cb, no threshold shares supplied).
    expect(restoreFileFromDisk).toHaveBeenCalledWith(
      [img],
      'pw',
      keyFile,
      [],
      undefined,
      undefined,
    );
    expect(filename).toBe('secret.txt');
    expect(note).toBe('statusRestored:secret.txt');
  });

  it('routes gallery restores through restoreGalleryFromDisk (embedded: no key)', async () => {
    const { note } = await runRestore({ mode: 'gallery', files: [img], password: 'pw' }, msg);
    // Args: files, password, keyFile, secret (both undefined here).
    expect(restoreGalleryFromDisk).toHaveBeenCalledWith([img], 'pw', undefined, undefined);
    expect(restoreFileFromDisk).not.toHaveBeenCalled();
    expect(note).toBe('statusRestored:note.txt');
  });

  it('forwards the key file to a keyfile/stego gallery restore', async () => {
    const keyFile = new File([new Uint8Array([2])], 'vault.key');
    await runRestore({ mode: 'gallery', files: [img], password: 'pw', keyFile }, msg);
    expect(restoreGalleryFromDisk).toHaveBeenCalledWith([img], 'pw', keyFile, undefined);
  });

  it('recovers the Mode B secret from share files and forwards it', async () => {
    // Two share .txt files → the controller recovers S and passes it through. Uses a
    // real 2-of-3 split so the recovery path (decodeShareText + shamirRecover) runs.
    const { shamirSplit, encodeShareText, randomBytes, SECRET_LEN } = await import('@core');
    const shares = await shamirSplit(randomBytes(SECRET_LEN), 2, 3);
    const shareFiles = [shares[0]!, shares[1]!].map(
      (s, i) => new File([encodeShareText(s)], `share-${i + 1}.txt`),
    );
    await runRestore({ mode: 'gallery', files: [img], password: 'pw', shareFiles }, msg);
    const call = restoreGalleryFromDisk.mock.calls[0] as unknown as unknown[];
    const secret = call[3] as Uint8Array | undefined; // 4th arg: the recovered secret
    expect(secret).toBeInstanceOf(Uint8Array);
    expect(secret!.length).toBe(32);
  });
});
