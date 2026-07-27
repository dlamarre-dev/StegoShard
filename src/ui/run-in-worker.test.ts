import { describe, expect, it, vi } from 'vitest';
import { MissingKeyError, SegmentedFormatError, WrongPasswordError } from '@core';

/**
 * A fake dedicated Worker: records posted messages and lets the test drive
 * replies back through the handler run-in-worker installs. This exercises the
 * request multiplexing, progress fan-out, and typed-error reconstruction without
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
  postMessage(msg: Record<string, unknown>, _transfer?: unknown): void {
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
    const promise = decryptBinaryInWorker(new Uint8Array([1, 2, 3]), 'pw', undefined, (p) =>
      seen.push(`${p.phase}:${p.done}/${p.total}`),
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
});
