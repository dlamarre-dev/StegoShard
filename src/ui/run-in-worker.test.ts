import { describe, expect, it, vi } from 'vitest';
import { MissingKeyError, SegmentedFormatError, WrongPasswordError } from '@core';

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
const { decryptBinaryInWorker } = await import('./run-in-worker');

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

  it('reconstructs typed core errors so friendlyError still matches by instance', async () => {
    const cases: Array<[string, unknown]> = [
      ['WrongPasswordError', WrongPasswordError],
      ['MissingKeyError', MissingKeyError],
      ['SegmentedFormatError', SegmentedFormatError],
    ];
    for (const [name, ctor] of cases) {
      const promise = decryptBinaryInWorker(new Uint8Array([1]), 'pw', undefined);
      const w = FakeWorker.last!;
      w.reply({ id: w.lastId(), type: 'error', name, message: `${name}: boom` });
      await expect(promise).rejects.toBeInstanceOf(ctor as new () => Error);
    }
  });

  it('rejects an unknown error name as a generic Error carrying the name', async () => {
    const promise = decryptBinaryInWorker(new Uint8Array([1]), 'pw', undefined);
    const w = FakeWorker.last!;
    w.reply({ id: w.lastId(), type: 'error', name: 'WeirdError', message: 'nope' });
    await expect(promise).rejects.toThrow('nope');
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
