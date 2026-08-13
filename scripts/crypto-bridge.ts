/**
 * Long-lived JSON-line bridge that lets crypto-condor (Python) drive this
 * project's TypeScript crypto.
 *
 * crypto-condor's `AES.test_encrypt` takes a Python callable and feeds it one
 * test vector at a time. The NIST CAVP set for AES-256-GCM alone is 7,875
 * vectors, so spawning Node per vector is not an option: this process is started
 * once per pytest session and answers on stdin/stdout instead.
 *
 * Protocol: one JSON object per line in, one per line out, correlated by `id`.
 * All byte strings are lowercase hex. A request that the implementation refuses
 * comes back as `{ok: false, error}` rather than killing the process, because
 * "this binding rejects that input" is itself a result worth recording (see the
 * 8-bit-IV vectors, which every mainstream GCM binding refuses by policy).
 *
 * Two layers are exposed, and keeping them apart is the point of the exercise:
 *
 *  - `gcm.*` calls WebCrypto directly. Validates the platform primitive.
 *  - `stego.*` calls this project's own helpers (aeadSeal/aeadOpen/decryptBytes).
 *    Validates our framing: nonce handling, `ciphertext || tag` layout, byte
 *    order. A real defect would live here, not in the platform.
 *
 * Run: tsx scripts/crypto-bridge.ts   (speaks on stdin/stdout, no arguments)
 */

import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { createHMAC, createSHA256 } from 'hash-wasm';
import {
  aeadSeal,
  aeadOpen,
  decryptBytes,
  randomBytes,
  installUserEntropy,
  clearUserEntropy,
  hkdf,
} from '../src/core/crypto';

const subtle = globalThis.crypto.subtle;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Import raw AES-GCM key material. Extractable is irrelevant here; usage is not. */
function aesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, usages);
}

interface Request {
  id: number;
  op: string;
  [k: string]: unknown;
}

const hex = (req: Request, k: string): Uint8Array => fromHex((req[k] as string | undefined) ?? '');
const num = (req: Request, k: string, dflt: number): number =>
  (req[k] as number | undefined) ?? dflt;

/**
 * WebCrypto returns `ciphertext || tag` as one buffer. crypto-condor wants the
 * two separately, and `tagBits` is what decides where the split falls.
 */
function splitTag(combined: Uint8Array, tagBits: number): { ct: string; tag: string } {
  const tagLen = tagBits / 8;
  return {
    ct: toHex(combined.subarray(0, combined.length - tagLen)),
    tag: toHex(combined.subarray(combined.length - tagLen)),
  };
}

async function handle(req: Request): Promise<Record<string, unknown>> {
  switch (req.op) {
    // ---- Platform layer: raw WebCrypto -------------------------------------
    case 'gcm.encrypt': {
      const tagBits = num(req, 'tagBits', 128);
      const key = await aesKey(hex(req, 'key'), ['encrypt']);
      const out = new Uint8Array(
        await subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: hex(req, 'iv') as BufferSource,
            additionalData: hex(req, 'aad') as BufferSource,
            tagLength: tagBits,
          },
          key,
          hex(req, 'pt') as BufferSource,
        ),
      );
      return splitTag(out, tagBits);
    }
    case 'gcm.decrypt': {
      const tagBits = num(req, 'tagBits', 128);
      const key = await aesKey(hex(req, 'key'), ['decrypt']);
      const combined = new Uint8Array([...hex(req, 'ct'), ...hex(req, 'tag')]);
      const pt = await subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: hex(req, 'iv') as BufferSource,
          additionalData: hex(req, 'aad') as BufferSource,
          tagLength: tagBits,
        },
        key,
        combined as BufferSource,
      );
      return { pt: toHex(new Uint8Array(pt)) };
    }

    // ---- StegoShard layer: our own helpers ---------------------------------
    case 'stego.seal': {
      // aeadSeal fixes the tag at WebCrypto's 128-bit default and rejects any
      // nonce that is not 12 bytes, so only that slice of CAVP reaches here.
      const key = await aesKey(hex(req, 'key'), ['encrypt']);
      const out = await aeadSeal(key, hex(req, 'nonce'), hex(req, 'pt'), hex(req, 'aad'));
      return splitTag(out, 128);
    }
    case 'stego.open': {
      const key = await aesKey(hex(req, 'key'), ['decrypt']);
      const combined = new Uint8Array([...hex(req, 'ct'), ...hex(req, 'tag')]);
      const pt = await aeadOpen(key, hex(req, 'nonce'), combined, hex(req, 'aad'));
      return { pt: toHex(pt) };
    }
    case 'stego.decryptBytes': {
      const key = await aesKey(hex(req, 'key'), ['decrypt']);
      const combined = new Uint8Array([...hex(req, 'ct'), ...hex(req, 'tag')]);
      const pt = await decryptBytes(key, hex(req, 'iv'), combined);
      return { pt: toHex(pt) };
    }

    // ---- Hashes carried by the entropy pool and the header hint ------------
    case 'hmac.sha256': {
      const h = await createHMAC(createSHA256(), hex(req, 'key'));
      h.init();
      h.update(hex(req, 'msg'));
      return { mac: h.digest('hex') };
    }
    case 'sha256': {
      const h = await createSHA256();
      h.init();
      h.update(hex(req, 'msg'));
      return { digest: h.digest('hex') };
    }
    case 'hkdf': {
      const out = await hkdf(
        hex(req, 'ikm'),
        hex(req, 'info'),
        num(req, 'len', 32),
        hex(req, 'salt'),
      );
      return { okm: toHex(out) };
    }

    // ---- Randomness sampling for the TestU01 battery -----------------------
    case 'random.write': {
      // `entropy` mirrors the expert option: absent means the plain CSPRNG tap,
      // present means the XOR layer is installed for the duration of the draw.
      const entropy = req['entropy'] as string | undefined;
      if (entropy !== undefined) await installUserEntropy(entropy);
      try {
        const total = num(req, 'bytes', 1 << 20);
        const CHUNK = 1 << 16; // randomBytes windows at 65536 internally anyway
        const buf = new Uint8Array(total);
        for (let off = 0; off < total; off += CHUNK) {
          const n = Math.min(CHUNK, total - off);
          buf.set(randomBytes(n), off);
        }
        writeFileSync(req['path'] as string, buf);
        return { written: total };
      } finally {
        clearUserEntropy();
      }
    }

    case 'ping':
      return { pong: true };

    default:
      throw new Error(`unknown op: ${req.op}`);
  }
}

const rl = createInterface({ input: process.stdin });

// Requests are answered in order. crypto-condor drives one vector at a time and
// waits for each reply, so serializing here costs nothing and keeps the stego
// layer's global entropy state (installUserEntropy) from interleaving.
let chain: Promise<void> = Promise.resolve();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  chain = chain.then(async () => {
    let id = -1;
    try {
      const req = JSON.parse(trimmed) as Request;
      id = req.id;
      const res = await handle(req);
      process.stdout.write(`${JSON.stringify({ id, ok: true, ...res })}\n`);
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: message })}\n`);
    }
  });
});
