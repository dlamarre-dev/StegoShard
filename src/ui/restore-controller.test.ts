import { describe, expect, it, vi, beforeEach } from 'vitest';

const restoreFileFromDisk = vi.fn(async () => ({ filename: 'secret.txt' }));
const restoreGalleryFromDisk = vi.fn(async () => ({ filename: 'note.txt' }));
vi.mock('./disk', () => ({ restoreFileFromDisk, restoreGalleryFromDisk }));

const { planForRestore, runRestore } = await import('./restore-controller');

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
    // Args: files, password, keyFile, secret, onProgress (all undefined here but the first two).
    expect(restoreGalleryFromDisk).toHaveBeenCalledWith(
      [img],
      'pw',
      undefined,
      undefined,
      undefined,
    );
    expect(restoreFileFromDisk).not.toHaveBeenCalled();
    expect(note).toBe('statusRestored:note.txt');
  });

  it('forwards the key file to a keyfile/stego gallery restore', async () => {
    const keyFile = new File([new Uint8Array([2])], 'vault.key');
    await runRestore({ mode: 'gallery', files: [img], password: 'pw', keyFile }, msg);
    expect(restoreGalleryFromDisk).toHaveBeenCalledWith([img], 'pw', keyFile, undefined, undefined);
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

describe('planForRestore', () => {
  const file = (name: string, size = 1000): File => new File([new Uint8Array(size)], name);
  const phases = (req: Parameters<typeof planForRestore>[0]): string[] =>
    planForRestore(req, 'web').map((s) => s.phase);

  it('plans a gallery from its mode, with a key photo derived first', () => {
    expect(
      phases({
        mode: 'gallery',
        files: [file('IMG_1.jpg')],
        password: 'pw',
        keyFile: file('k.png'),
      }),
    ).toEqual(['derive', 'derive', 'extract', 'derive', 'deliver']);
  });

  it('plans a container from its extension, searching the other files for a key photo', () => {
    expect(
      phases({ mode: 'standard', files: [file('v.ssbn'), file('IMG_2.jpg')], password: 'pw' }),
    ).toEqual(['derive', 'unlock', 'decrypt', 'deliver']);
    expect(phases({ mode: 'standard', files: [file('cache.db')], password: 'pw' })).toEqual([
      'unlock',
      'decrypt',
      'deliver',
    ]);
  });

  it('plans a PDF or an image set as reading then deriving; a .key costs no derivation', () => {
    expect(phases({ mode: 'standard', files: [file('set.pdf')], password: 'pw' })).toEqual([
      'extract',
      'derive',
      'deliver',
    ]);
    expect(
      phases({
        mode: 'standard',
        files: [file('a.png'), file('b.png')],
        password: 'pw',
        keyFile: file('recovery.key'),
      }),
    ).toEqual(['extract', 'derive', 'deliver']);
  });
});
