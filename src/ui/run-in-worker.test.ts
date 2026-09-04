import { describe, expect, it, vi } from 'vitest';
import {
  BucketTooLargeError,
  CredentialsNotIndependentError,
  FileTooLargeError,
  GalleryCoverCapacityError,
  GalleryFileTooLargeError,
  GalleryRestoreError,
  GalleryTooFewImagesError,
  GalleryTooManyImagesError,
  JpegUnsupportedError,
  MissingKeyError,
  SegmentedFormatError,
  ShareChecksumError,
  ShareSetError,
  StegoCapacityError,
  StegoCoverFormatError,
  TooManyFilesError,
  TooManyImagesError,
  VerificationError,
  WrongPasswordError,
  stegoErrorToWire,
} from '@core';

/**
 * A fake dedicated Worker: records posted messages and lets the test drive
 * replies back through the handler run-in-worker installs. This exercises the
 * request serialization, progress fan-out, and typed-error reconstruction without
 * a real module worker (unavailable under jsdom/node).
 */
class FakeWorker {
  static last: FakeWorker | undefined;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  posted: Array<Record<string, unknown>> = [];
  constructor(_url: unknown, _opts?: unknown) {
    FakeWorker.last = this;
  }
  /** Set to make the next postMessage throw synchronously, as a failed transfer would. */
  failNextPost: Error | undefined;
  postMessage(msg: Record<string, unknown>, _transfer?: unknown): void {
    if (this.failNextPost) {
      const err = this.failNextPost;
      this.failNextPost = undefined;
      throw err;
    }
    this.posted.push(msg);
  }
  terminate(): void {}
  reply(data: unknown): void {
    this.onmessage?.({ data });
  }
  lastId(): number {
    return this.posted[this.posted.length - 1]!.id as number;
  }
}

vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);

// Import after the global is stubbed so the lazily-created worker is the fake.
// run-in-worker keeps a single lazy worker, so FakeWorker.last is that one
// instance for the whole suite; each request is matched by its numeric id.
const { decryptBinaryInWorker, encryptBinaryInWorker, encryptBinaryDisguisedInWorker } =
  await import('./run-in-worker');

describe('run-in-worker transport', () => {
  it('sends a decryptBinary request and resolves with the transferred result', async () => {
    const seen: string[] = [];
    const promise = decryptBinaryInWorker(
      new Uint8Array([1, 2, 3]),
      'pw',
      undefined,
      undefined,
      (p) => seen.push(`${p.phase}:${p.done}/${p.total}`),
    );
    const w = FakeWorker.last!;
    const sent = w.posted[w.posted.length - 1]!;
    expect(sent.op).toBe('decryptBinary');
    expect(sent.password).toBe('pw');
    const id = w.lastId();

    // Progress events fan out to the callback; the final result resolves.
    w.reply({ id, type: 'progress', p: { phase: 'unlock', done: 0, total: 0 } });
    w.reply({ id, type: 'progress', p: { phase: 'decrypt', done: 4, total: 4 } });
    w.reply({ id, type: 'result', filename: 'secret.txt', content: new Uint8Array([9, 9]) });

    const res = await promise;
    expect(res.filename).toBe('secret.txt');
    expect([...res.content]).toEqual([9, 9]);
    expect(seen).toEqual(['unlock:0/0', 'decrypt:4/4']);
  });

  /**
   * Every core error class, not the three this used to check.
   *
   * The wrapper rebuilt five of the nineteen and handed back a plain `Error` for
   * the rest, so `friendlyError`, which matches by `instanceof`, silently fell
   * through to a generic message for the other fourteen. The payloads here are
   * built by `stegoErrorToWire`, which is what the worker now sends, so this
   * exercises the real pair rather than a hand-written approximation of it.
   */
  it('reconstructs every typed core error so friendlyError matches by instance', async () => {
    const instances: Error[] = [
      new WrongPasswordError(),
      new MissingKeyError(),
      new SegmentedFormatError('truncated chunk'),
      new VerificationError(),
      new FileTooLargeError(2_000_000, 1_048_576),
      new TooManyImagesError(400, 150),
      new TooManyFilesError(900, 256),
      new GalleryRestoreError(),
      new GalleryTooFewImagesError(3, 5),
      new GalleryTooManyImagesError(300, 256),
      new GalleryFileTooLargeError(70_000, 65_536),
      new GalleryCoverCapacityError('IMG_2043.jpg', 120, 800),
      new StegoCapacityError(1024),
      new StegoCoverFormatError(),
      new JpegUnsupportedError('progressive scan'),
      new CredentialsNotIndependentError('equal'),
      new ShareChecksumError(),
      new ShareSetError('duplicate share index'),
      new BucketTooLargeError(5000, 4096),
    ];

    for (const original of instances) {
      const promise = decryptBinaryInWorker(new Uint8Array([1]), 'pw', undefined);
      const w = FakeWorker.last!;
      // structuredClone, because that is what postMessage actually does to it.
      w.reply({
        id: w.lastId(),
        type: 'error',
        ...structuredClone(stegoErrorToWire(original)),
      });
      await expect(promise, original.name).rejects.toBeInstanceOf(
        original.constructor as new () => Error,
      );
    }
  });

  // The numbers matter as much as the class: `friendlyError` puts them in the
  // sentence a user reads.
  it('carries the readonly fields back across the boundary', async () => {
    const promise = decryptBinaryInWorker(new Uint8Array([1]), 'pw', undefined);
    const w = FakeWorker.last!;
    w.reply({
      id: w.lastId(),
      type: 'error',
      ...structuredClone(stegoErrorToWire(new FileTooLargeError(2_000_000, 1_048_576))),
    });
    await expect(promise).rejects.toMatchObject({ size: 2_000_000, limit: 1_048_576 });
  });

  it('rejects an unknown error name as a generic Error carrying the name', async () => {
    const promise = decryptBinaryInWorker(new Uint8Array([1]), 'pw', undefined);
    const w = FakeWorker.last!;
    w.reply({ id: w.lastId(), type: 'error', name: 'WeirdError', message: 'nope' });
    await expect(promise).rejects.toThrow('nope');
  });

  /**
   * A worker-level failure must reject everything, not leave callers hanging.
   *
   * `onerror` fires for a load failure or an uncaught throw inside the worker, at
   * which point no reply will ever arrive for the requests in flight. Without
   * this path they wait forever, which in the app is a progress bar that never
   * finishes and a user with no idea why.
   */
  it('rejects every in-flight and queued request when the worker crashes', async () => {
    const inFlight = decryptBinaryInWorker(new Uint8Array([1]), 'first', undefined);
    const queued = decryptBinaryInWorker(new Uint8Array([2]), 'second', undefined);
    const w = FakeWorker.last!;

    w.onerror?.({});

    await expect(inFlight).rejects.toThrow(/worker crashed/);
    await expect(queued).rejects.toThrow(/worker crashed/);

    // And the module recovers: the next call builds a fresh worker rather than
    // reusing the dead one.
    const after = decryptBinaryInWorker(new Uint8Array([3]), 'third', undefined);
    const fresh = FakeWorker.last!;
    expect(fresh).not.toBe(w);
    fresh.reply({ id: fresh.lastId(), type: 'result', filename: 'ok', content: new Uint8Array() });
    expect((await after).filename).toBe('ok');
  });

  describe('the encrypt requests', () => {
    /** A real extractable AES-GCM key, since the wrapper exports its raw bytes. */
    const aesKey = () =>
      globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
        'encrypt',
        'decrypt',
      ]);

    /**
     * The last message actually posted, once it has been.
     *
     * `encryptBinaryInWorker` awaits `exportDekRaw` before it reaches the queue,
     * so reading `posted` synchronously after the call returns the *previous*
     * request. Replying to that one leaves the real request pending forever, and
     * because the module keeps a single queue for the whole file, that then hangs
     * every later test. Ask for the message rather than assume it has arrived.
     */
    const posted = async (w: FakeWorker, before: number) => {
      await vi.waitFor(() => expect(w.posted.length).toBe(before + 1));
      return w.posted[w.posted.length - 1]!;
    };

    it('sends the DEK as raw bytes, never as a CryptoKey', async () => {
      const dek = await aesKey();
      const w = FakeWorker.last!;
      const before = w.posted.length;
      const promise = encryptBinaryInWorker(
        'secret.txt',
        new Uint8Array([1, 2, 3]),
        { dek, keyBlock: new Uint8Array(92) },
        'embedded',
        'branded',
      );
      const sent = await posted(w, before);
      expect(sent.op).toBe('encryptBinary');
      expect(sent.variant).toBe('branded');
      // The whole point of exportDekRaw: a CryptoKey cannot cross, and must not
      // be attempted.
      expect(sent.rawDek).toBeInstanceOf(Uint8Array);
      expect((sent.rawDek as Uint8Array).length).toBe(32);
      expect(sent.dek).toBeUndefined();

      w.reply({ id: w.lastId(), type: 'result', container: new Uint8Array([7, 7]) });
      expect([...(await promise)]).toEqual([7, 7]);
    });

    it('sends a disguised save keyed by the password, with no managed key', async () => {
      const w = FakeWorker.last!;
      const before = w.posted.length;
      const promise = encryptBinaryDisguisedInWorker(
        'secret.txt',
        new Uint8Array([4, 5]),
        'a long unrelated passphrase',
        'keyfile',
      );
      const sent = await posted(w, before);
      expect(sent.op).toBe('encryptBinaryDisguised');
      expect(sent.password).toBe('a long unrelated passphrase');
      expect(sent.keyMode).toBe('keyfile');
      expect(sent.rawDek).toBeUndefined();

      w.reply({
        id: w.lastId(),
        type: 'result',
        container: new Uint8Array([8]),
        keyBlock: new Uint8Array([9]),
      });
      const res = await promise;
      expect([...res.container]).toEqual([8]);
      expect([...res.keyBlock]).toEqual([9]);
    });

    it('forwards the entropy layer, which the worker cannot inherit', async () => {
      const dek = await aesKey();
      const w = FakeWorker.last!;
      const before = w.posted.length;
      const promise = encryptBinaryInWorker(
        'secret.txt',
        new Uint8Array([1]),
        { dek, keyBlock: new Uint8Array(92) },
        'embedded',
        'branded',
        'dice rolls',
      );
      expect((await posted(w, before)).userEntropy).toBe('dice rolls');
      w.reply({ id: w.lastId(), type: 'result', container: new Uint8Array() });
      await promise;
    });
  });

  it('posts only one cryptographic request at a time', async () => {
    const first = decryptBinaryInWorker(new Uint8Array([1]), 'one', undefined);
    const w = FakeWorker.last!;
    const before = w.posted.length;
    const second = decryptBinaryInWorker(new Uint8Array([2]), 'two', undefined);
    expect(w.posted).toHaveLength(before);

    const firstId = w.lastId();
    w.reply({ id: firstId, type: 'result', filename: 'one', content: new Uint8Array() });
    await first;
    expect(w.posted).toHaveLength(before + 1);
    const secondId = w.lastId();
    expect(secondId).not.toBe(firstId);
    w.reply({ id: secondId, type: 'result', filename: 'two', content: new Uint8Array() });
    await second;
  });

  it('keeps serving requests after a dispatch fails synchronously', async () => {
    const w = FakeWorker.last!;
    w.failNextPost = new DOMException('could not be cloned', 'DataCloneError');

    // The failing request rejects rather than hanging...
    await expect(decryptBinaryInWorker(new Uint8Array([1]), 'bad', undefined)).rejects.toThrow(
      /could not be cloned/,
    );

    // ...and, crucially, the queue is not left pinned to the dead id: the next
    // request is dispatched and completes normally.
    const before = w.posted.length;
    const next = decryptBinaryInWorker(new Uint8Array([2]), 'good', undefined);
    expect(w.posted).toHaveLength(before + 1);
    w.reply({ id: w.lastId(), type: 'result', filename: 'after', content: new Uint8Array() });
    expect((await next).filename).toBe('after');
  });

  it('rejects every queued request when dispatch keeps failing', async () => {
    const w = FakeWorker.last!;
    // Queue a request that occupies the single in-flight slot.
    const held = decryptBinaryInWorker(new Uint8Array([1]), 'held', undefined);
    const heldId = w.lastId();
    const queued = decryptBinaryInWorker(new Uint8Array([2]), 'queued', undefined);

    // Releasing the slot pumps the queued request, whose dispatch fails.
    w.failNextPost = new DOMException('could not be cloned', 'DataCloneError');
    w.reply({ id: heldId, type: 'result', filename: 'held', content: new Uint8Array() });
    await held;
    await expect(queued).rejects.toThrow(/could not be cloned/);

    const before = w.posted.length;
    const after = decryptBinaryInWorker(new Uint8Array([3]), 'after', undefined);
    expect(w.posted).toHaveLength(before + 1);
    w.reply({ id: w.lastId(), type: 'result', filename: 'ok', content: new Uint8Array() });
    expect((await after).filename).toBe('ok');
  });
});
