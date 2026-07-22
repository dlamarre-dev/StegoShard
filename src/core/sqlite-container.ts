/**
 * Deniable SQLite container (SPEC §8, disguised variant).
 *
 * The vault blob is stored *inside* a genuine, minimal SQLite 3 database — as the
 * BLOB value of one row of a plausible `cache(k TEXT, v BLOB)` table, spilling into
 * a proper overflow-page chain — so the file is byte-for-byte valid: `page_count ×
 * page_size == file size`, `PRAGMA integrity_check` returns `ok`, and
 * `sqlite3 cache.db "SELECT ..."` works. There are **no trailing bytes past the
 * database's logical end**, which is the tell the old "append the blob after a
 * fixed 1 KiB stub" layout left behind.
 *
 * Honest limit (see docs/CRYPTO-REVIEW.md §6b): the vault row is one large
 * high-entropy BLOB, which deep content analysis can still flag as "not a normal
 * cache". This defeats structural triage (type, integrity_check, opening the DB),
 * not a forensic examiner who inspects the value bytes.
 *
 * This is an independent, minimal implementation of just the slice of the SQLite
 * file format we emit and read back; it is not a general SQLite engine. Mirrored
 * by the Python reference decoder (python/stegoshard/sqlite_container.py).
 */

import { concatBytes } from './bytes';

const PAGE_SIZE = 4096;
const U = PAGE_SIZE; // usable size (reserved-bytes-per-page = 0)
const MAGIC = 'SQLite format 3\0';
/** First 16 bytes — used to recognise the disguised variant on restore. */
export const SQLITE_MAGIC = new TextEncoder().encode(MAGIC);

const SQLITE_VERSION_NUMBER = 3045000; // cosmetic; any recent value is fine
const CACHE_ROOT_PAGE = 2;
const CREATE_SQL = 'CREATE TABLE cache(k TEXT, v BLOB)';
/** The `cache.k` value of the row whose BLOB holds the vault (vs. decoy rows). */
const VAULT_KEY = 'page_cache';
const VAULT_KEY_BYTES = new TextEncoder().encode(VAULT_KEY);

// Table-leaf payload thresholds (SQLite fileformat.html, reserved = 0).
const MAX_LOCAL = U - 35;
const MIN_LOCAL = Math.floor((U - 12) * 32 / 255) - 23;
const OVERFLOW_CHUNK = U - 4;

// --- varint (SQLite big-endian, 7 bits/byte, high bit = continue) -------------

function putVarint(n: number): number[] {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('sqlite: bad varint');
  const groups: number[] = [];
  let v = n;
  do {
    groups.unshift(v % 128);
    v = Math.floor(v / 128);
  } while (v > 0);
  for (let i = 0; i < groups.length - 1; i++) groups[i]! |= 0x80;
  return groups;
}

function readVarint(buf: Uint8Array, off: number): [number, number] {
  let result = 0;
  for (let i = 0; i < 9; i++) {
    const byte = buf[off + i]!;
    if (i === 8) {
      result = result * 256 + byte;
      return [result, 9];
    }
    result = result * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [result, i + 1];
  }
  return [result, 9];
}

// --- record (row) encoding ----------------------------------------------------

type Col = { text: Uint8Array } | { blob: Uint8Array } | { int: number };

function encodeRecord(cols: Col[]): Uint8Array {
  const serials: number[] = [];
  const bodies: Uint8Array[] = [];
  for (const c of cols) {
    if ('text' in c) {
      serials.push(...putVarint(2 * c.text.length + 13));
      bodies.push(c.text);
    } else if ('blob' in c) {
      serials.push(...putVarint(2 * c.blob.length + 12));
      bodies.push(c.blob);
    } else {
      // Small non-negative integer → serial type 1 (1-byte, twos-complement).
      serials.push(...putVarint(1));
      bodies.push(Uint8Array.of(c.int & 0xff));
    }
  }
  // headerLen counts itself; it is tiny here, so its varint is 1 byte, but loop
  // to be exact in case the serial array ever grows past 126 bytes.
  let headerLenSize = 1;
  for (;;) {
    const headerLen = headerLenSize + serials.length;
    const enc = putVarint(headerLen);
    if (enc.length === headerLenSize) {
      return concatBytes(Uint8Array.from(enc), Uint8Array.from(serials), ...bodies);
    }
    headerLenSize = enc.length;
  }
}

/** Split a table-leaf payload into (localBytes, overflowBytes) per the spec. */
function splitPayload(payloadLen: number): number {
  if (payloadLen <= MAX_LOCAL) return payloadLen;
  const k = MIN_LOCAL + ((payloadLen - MIN_LOCAL) % OVERFLOW_CHUNK);
  return k <= MAX_LOCAL ? k : MIN_LOCAL;
}

// --- page builders ------------------------------------------------------------

function buildLeafPage(cells: Uint8Array[], headerOffset: number): Uint8Array {
  const page = new Uint8Array(PAGE_SIZE);
  let content = PAGE_SIZE;
  const ptrs: number[] = [];
  for (const cell of cells) {
    content -= cell.length;
    page.set(cell, content);
    ptrs.push(content);
  }
  const h = headerOffset;
  page[h] = 0x0d; // leaf table b-tree
  // bytes 1-2 first freeblock = 0
  page[h + 3] = (cells.length >> 8) & 0xff;
  page[h + 4] = cells.length & 0xff;
  page[h + 5] = (content >> 8) & 0xff;
  page[h + 6] = content & 0xff;
  // byte 7 fragmented free bytes = 0
  let po = h + 8;
  for (const p of ptrs) {
    page[po++] = (p >> 8) & 0xff;
    page[po++] = p & 0xff;
  }
  return page;
}

function writeHeader(page: Uint8Array, pageCount: number): void {
  page.set(SQLITE_MAGIC, 0);
  const dv = new DataView(page.buffer);
  dv.setUint16(16, PAGE_SIZE, false);
  page[18] = 1; // file format write version (legacy)
  page[19] = 1; // read version
  page[20] = 0; // reserved bytes per page
  page[21] = 64; // max embedded payload fraction
  page[22] = 32; // min embedded payload fraction
  page[23] = 32; // leaf payload fraction
  dv.setUint32(24, 1, false); // file change counter
  dv.setUint32(28, pageCount, false); // database size in pages
  dv.setUint32(40, 1, false); // schema cookie
  dv.setUint32(44, 4, false); // schema format number
  dv.setUint32(56, 1, false); // text encoding = UTF-8
  dv.setUint32(92, 1, false); // version-valid-for == change counter
  dv.setUint32(96, SQLITE_VERSION_NUMBER, false);
}

/** A tiny table-leaf cell for a decoy row (fits locally; never overflows). */
function decoyCell(rowid: number, key: string, value: Uint8Array): Uint8Array {
  const record = encodeRecord([{ text: new TextEncoder().encode(key) }, { blob: value }]);
  return concatBytes(
    Uint8Array.from(putVarint(record.length)),
    Uint8Array.from(putVarint(rowid)),
    record,
  );
}

/**
 * Pack a vault blob into a valid, self-contained SQLite database. Decoy rows make
 * it look like a real cache; the blob is the largest row's BLOB value.
 */
export function packSqlite(blob: Uint8Array): Uint8Array {
  // Deterministic, innocuous-looking decoys (no RNG → reproducible artifact).
  const decoys: { key: string; value: Uint8Array }[] = [
    { key: 'schema_version', value: Uint8Array.of(0x32) },
    { key: 'last_sync', value: new TextEncoder().encode('1700000000') },
  ];

  // The vault row, identified by its key (not its size). rowid keeps it last.
  const vaultRecord = encodeRecord([{ text: VAULT_KEY_BYTES }, { blob: blob }]);
  const P = vaultRecord.length;
  const local = splitPayload(P);
  const overflowBytes = P - local;
  const overflowPageCount = overflowBytes > 0 ? Math.ceil(overflowBytes / OVERFLOW_CHUNK) : 0;

  const pageCount = 2 + overflowPageCount;
  const firstOverflowPage = overflowPageCount > 0 ? 3 : 0;

  // Build the vault leaf cell: varint(P) varint(rowid) local-payload [overflow ptr].
  const vaultCellParts: Uint8Array[] = [
    Uint8Array.from(putVarint(P)),
    Uint8Array.from(putVarint(3)),
    vaultRecord.subarray(0, local),
  ];
  if (overflowPageCount > 0) {
    const ptr = new Uint8Array(4);
    new DataView(ptr.buffer).setUint32(0, firstOverflowPage, false);
    vaultCellParts.push(ptr);
  }
  const vaultCell = concatBytes(...vaultCellParts);

  // Page 1: file header + schema (sqlite_master) leaf b-tree with one table row.
  const schemaRecord = encodeRecord([
    { text: new TextEncoder().encode('table') },
    { text: new TextEncoder().encode('cache') },
    { text: new TextEncoder().encode('cache') },
    { int: CACHE_ROOT_PAGE },
    { text: new TextEncoder().encode(CREATE_SQL) },
  ]);
  const schemaCell = concatBytes(
    Uint8Array.from(putVarint(schemaRecord.length)),
    Uint8Array.from(putVarint(1)),
    schemaRecord,
  );
  const page1 = buildLeafPage([schemaCell], 100);
  writeHeader(page1, pageCount);

  // Page 2: the `cache` table leaf. The vault row (rowid 3) must fit; decoy rows
  // (rowid 1,2) are added only while they still fit alongside it, so a large
  // inline vault cell never overflows the page. Pointer order is ascending rowid.
  const decoyCells = [
    decoyCell(1, decoys[0]!.key, decoys[0]!.value),
    decoyCell(2, decoys[1]!.key, decoys[1]!.value),
  ];
  let used = 8 + (vaultCell.length + 2); // page header + the vault cell + its pointer
  const included: Uint8Array[] = [];
  for (const d of decoyCells) {
    if (used + d.length + 2 <= PAGE_SIZE) {
      included.push(d);
      used += d.length + 2;
    }
  }
  const page2 = buildLeafPage([...included, vaultCell], 0);

  // Assemble directly into one preallocated buffer: page 1, page 2, then the
  // overflow chain (pages 3..N) written in place. Avoids spreading thousands of
  // page arrays into concatBytes and the extra full-size copy that would entail.
  const out = new Uint8Array(pageCount * PAGE_SIZE);
  out.set(page1, 0);
  out.set(page2, PAGE_SIZE);
  const dvOut = new DataView(out.buffer);
  let o = local;
  for (let i = 0; i < overflowPageCount; i++) {
    const base = (2 + i) * PAGE_SIZE;
    const next = i === overflowPageCount - 1 ? 0 : 3 + i + 1;
    dvOut.setUint32(base, next, false); // 4-byte next-overflow-page pointer
    out.set(vaultRecord.subarray(o, o + OVERFLOW_CHUNK), base + 4);
    o += OVERFLOW_CHUNK;
  }
  return out;
}

// --- reader -------------------------------------------------------------------

/** Row (k, v) decoded from a table-leaf record. */
function decodeRow(payload: Uint8Array): { key: Uint8Array; value: Uint8Array } | null {
  const [headerLen, hlSize] = readVarint(payload, 0);
  let p = hlSize;
  const serials: number[] = [];
  while (p < headerLen) {
    const [st, n] = readVarint(payload, p);
    serials.push(st);
    p += n;
  }
  if (serials.length < 2) return null;
  const readCol = (st: number): { bytes: Uint8Array; isBlob: boolean } => {
    if (st >= 13 && st % 2 === 1) {
      const len = (st - 13) / 2;
      const bytes = payload.subarray(p, p + len);
      p += len;
      return { bytes, isBlob: false };
    }
    if (st >= 12 && st % 2 === 0) {
      const len = (st - 12) / 2;
      const bytes = payload.subarray(p, p + len);
      p += len;
      return { bytes, isBlob: true };
    }
    // Non-string/blob column (e.g. the small int we never read here): skip a
    // best-effort fixed width. We only decode our own rows, so this is unused.
    const width = st === 0 || st === 8 || st === 9 ? 0 : st <= 4 ? st : st === 5 ? 6 : 8;
    p += width;
    return { bytes: new Uint8Array(0), isBlob: false };
  };
  const key = readCol(serials[0]!).bytes;
  const value = readCol(serials[1]!).bytes;
  return { key, value };
}

/**
 * Extract the vault blob from a disguised SQLite database produced by
 * `packSqlite`, or null if the bytes are not such a database. Follows the
 * overflow chain to reassemble the largest BLOB (the vault row).
 */
export function unpackSqlite(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < PAGE_SIZE) return null;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) if (bytes[i] !== SQLITE_MAGIC[i]) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pageSize = dv.getUint16(16, false);
  if (pageSize !== PAGE_SIZE) return null;
  const pageCount = dv.getUint32(28, false);
  if (bytes.length < pageCount * PAGE_SIZE) return null;

  const pageAt = (n: number): Uint8Array => bytes.subarray((n - 1) * PAGE_SIZE, n * PAGE_SIZE);

  // Reassemble a table-leaf cell's full payload, following overflow if needed.
  const reassemble = (page: Uint8Array, cellOff: number): Uint8Array | null => {
    let p = cellOff;
    const [P, n1] = readVarint(page, p);
    p += n1;
    const [, n2] = readVarint(page, p); // rowid (ignored)
    p += n2;
    const local = splitPayload(P);
    const out = new Uint8Array(P);
    const localBytes = page.subarray(p, p + local);
    out.set(localBytes, 0);
    let filled = local;
    if (P > local) {
      let nextPage = new DataView(page.buffer, page.byteOffset + p + local, 4).getUint32(0, false);
      while (nextPage !== 0 && filled < P) {
        if (nextPage > pageCount) return null;
        const op = pageAt(nextPage);
        const next = new DataView(op.buffer, op.byteOffset, 4).getUint32(0, false);
        const take = Math.min(OVERFLOW_CHUNK, P - filled);
        out.set(op.subarray(4, 4 + take), filled);
        filled += take;
        nextPage = next;
      }
    }
    return filled === P ? out : null;
  };

  const keyEquals = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((x, i) => x === b[i]);

  // Read the `cache` table leaf (root page 2 for our writer) and return the BLOB
  // of the row keyed VAULT_KEY (never a decoy, whatever the sizes).
  const readVaultRow = (page: Uint8Array, headerOffset: number): Uint8Array | null => {
    if (page[headerOffset] !== 0x0d) return null; // must be a table-leaf page
    const nCells = (page[headerOffset + 3]! << 8) | page[headerOffset + 4]!;
    const ptrBase = headerOffset + 8;
    for (let i = 0; i < nCells; i++) {
      const cellOff = (page[ptrBase + i * 2]! << 8) | page[ptrBase + i * 2 + 1]!;
      const payload = reassemble(page, cellOff);
      if (!payload) continue;
      const row = decodeRow(payload);
      if (row && keyEquals(row.key, VAULT_KEY_BYTES)) return row.value;
    }
    return null;
  };

  const cache = pageAt(CACHE_ROOT_PAGE);
  const blob = readVaultRow(cache, 0);
  return blob && blob.length > 0 ? blob : null;
}
