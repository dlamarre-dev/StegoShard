/**
 * Packing several files into one vault payload, and back.
 *
 * The envelope carries a single name + blob (SPEC §4), so a multi-file save zips
 * its inputs and sets FLAGS bit1. This lives outside `@core` because core reaches
 * only for the platform streams API — that restraint is what lets the Python
 * reference decoder inflate a payload with its standard library.
 *
 * Shared by the browser surfaces and the CLI so the two cannot disagree about
 * what a bundle looks like.
 */

import { unzipSync, zipSync } from 'fflate';

/** Name carried in the envelope for a multi-file save. */
export const BUNDLE_NAME = 'bundle.zip';

export interface BundleFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Zip several files into one blob.
 *
 * Stored, not deflated: `buildPayload` gzips the result immediately afterwards,
 * and compressing twice costs time to gain nothing.
 */
export function packBundle(files: readonly BundleFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const f of files) {
    // Files picked from different folders can share a basename; keep both rather
    // than letting the later one silently replace the earlier.
    let name = f.name;
    for (let n = 2; used.has(name); n++) name = f.name.replace(/(\.[^.]+)?$/, `-${n}$1`);
    used.add(name);
    entries[name] = f.bytes;
  }
  return zipSync(entries, { level: 0 });
}

/**
 * Unzip a bundle back into its files.
 *
 * Entry names are reduced to a basename. The archive comes out of a vault the
 * user just decrypted, but its *contents* were chosen by whoever built that
 * vault, so a `../../` entry must not be able to write outside the output
 * directory. Bundles we write are flat, so anything else is either a traversal
 * attempt or an archive we did not produce.
 */
export function unpackBundle(zip: Uint8Array): BundleFile[] {
  const out: BundleFile[] = [];
  for (const [rawName, bytes] of Object.entries(unzipSync(zip))) {
    if (rawName.endsWith('/')) continue; // directory entry
    const name = rawName.split(/[\\/]/).pop() ?? '';
    if (!name || name === '.' || name === '..') continue;
    out.push({ name, bytes });
  }
  if (out.length === 0) throw new Error('bundle: no readable entries');
  return out;
}

/**
 * Resolve the files a user picked into the single (name, blob) the envelope
 * carries, plus whether it is a bundle.
 *
 * One file passes through untouched — same name, same bytes, no flag — so the
 * commonest save produces exactly the envelope it always did. Several are zipped
 * and marked. Returning a `File` lets every downstream path (estimates,
 * verification, the worker) stay as it was.
 */
export async function resolveSaveInput(files: readonly File[]): Promise<{
  file: File;
  bundle: boolean;
}> {
  if (files.length === 0) throw new Error('save: no file selected');
  const only = files[0]!;
  if (files.length === 1) return { file: only, bundle: false };
  const packed = packBundle(
    await Promise.all(
      files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
    ),
  );
  return {
    file: new File([packed as BufferSource], BUNDLE_NAME, { type: 'application/zip' }),
    bundle: true,
  };
}
