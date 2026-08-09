/**
 * Deniable SQLite container (SPEC §8, disguised variant).
 *
 * The vault blob is stored *inside* a genuine, minimal SQLite 3 database — split
 * across several rows of a plausible `cache(k TEXT, v BLOB)` table
 * (`page_cache_NNNN`, ~64 KiB each) under an interior b-tree root, one row per
 * leaf page, each spilling into its own overflow-page chain. The file is
 * byte-for-byte valid: `page_count × page_size == file size`, `PRAGMA
 * integrity_check` returns `ok`, and `sqlite3 cache.db "SELECT ..."` works. There
 * are **no trailing bytes past the database's logical end**, which is the tell the
 * old "append the blob after a fixed 1 KiB stub" layout left behind.
 *
 * Honest limit (see docs/CRYPTO-REVIEW.md §6b): the rows are still high-entropy
 * ciphertext, which deep *content* analysis can flag as "not a normal cache".
 * Spreading across ordinary-sized rows softens the single-giant-BLOB tell but
 * does not eliminate it. This defeats structural triage (type, integrity_check,
 * opening the DB), not a forensic examiner who inspects the value bytes.
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
/**
 * The vault is stored as several `cache` rows keyed `page_cache_NNNN` (chunk
 * order), reassembled by concatenation — several ordinary-sized rows read less
 * like "one giant opaque BLOB" than a single row. Decoy rows use other keys.
 */
const VAULT_KEY_PREFIX = 'page_cache_';
const VAULT_KEY_PREFIX_BYTES = new TextEncoder().encode(VAULT_KEY_PREFIX);
/** Target chunk size per vault row (a plausible cache-entry size). */
const VAULT_CHUNK = 64 * 1024;
/** Cap on vault rows so the single interior root page holds every child pointer. */
const MAX_VAULT_ROWS = 256;

// Table-leaf payload thresholds (SQLite fileformat.html, reserved = 0).
const MAX_LOCAL = U - 35;
const MIN_LOCAL = Math.floor(((U - 12) * 32) / 255) - 23;
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

/** Interior table b-tree page: child pointers to leaf pages, keyed by rowid. */
function buildInteriorPage(
  children: { page: number; key: number }[],
  rightMost: number,
): Uint8Array {
  const page = new Uint8Array(PAGE_SIZE);
  const cells = children.map(({ page: child, key }) => {
    const kv = putVarint(key);
    const cell = new Uint8Array(4 + kv.length);
    new DataView(cell.buffer).setUint32(0, child, false); // left-child page number
    cell.set(kv, 4);
    return cell;
  });
  let content = PAGE_SIZE;
  const ptrs: number[] = [];
  for (const cell of cells) {
    content -= cell.length;
    page.set(cell, content);
    ptrs.push(content);
  }
  page[0] = 0x05; // interior table b-tree
  page[3] = (cells.length >> 8) & 0xff;
  page[4] = cells.length & 0xff;
  page[5] = (content >> 8) & 0xff;
  page[6] = content & 0xff;
  new DataView(page.buffer).setUint32(8, rightMost, false); // right-most child pointer
  let po = 12; // interior header is 12 bytes (has the right-most pointer)
  for (const p of ptrs) {
    page[po++] = (p >> 8) & 0xff;
    page[po++] = p & 0xff;
  }
  return page;
}

/** Build a table-leaf cell (varint payloadLen, varint rowid, local payload, [overflow ptr]). */
function tableLeafCell(rowid: number, record: Uint8Array, firstOverflow: number): Uint8Array {
  const local = splitPayload(record.length);
  const parts: Uint8Array[] = [
    Uint8Array.from(putVarint(record.length)),
    Uint8Array.from(putVarint(rowid)),
    record.subarray(0, local),
  ];
  if (record.length > local) {
    const ptr = new Uint8Array(4);
    new DataView(ptr.buffer).setUint32(0, firstOverflow, false);
    parts.push(ptr);
  }
  return concatBytes(...parts);
}

/**
 * Pack a vault blob into a valid, self-contained SQLite database: a `cache` table
 * whose vault is split across several `page_cache_NNNN` rows (chunk order) plus a
 * couple of decoy rows, under an interior b-tree root — one row per leaf page,
 * each spilling into its own overflow chain. Several ordinary-sized rows read less
 * like "one giant opaque BLOB". No trailing bytes: file size == page_count × page_size.
 */
export function packSqlite(blob: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  // Rows in rowid order: decoys first (small, fit locally), then vault chunks.
  const rows: { key: Uint8Array; value: Uint8Array }[] = [
    { key: enc.encode('schema_version'), value: Uint8Array.of(0x32) },
    { key: enc.encode('last_sync'), value: enc.encode('1700000000') },
  ];
  const n = Math.max(1, Math.min(MAX_VAULT_ROWS, Math.ceil(blob.length / VAULT_CHUNK)));
  const chunkSize = Math.max(1, Math.ceil(blob.length / n));
  for (let i = 0; i < n; i++) {
    rows.push({
      key: enc.encode(`${VAULT_KEY_PREFIX}${String(i).padStart(4, '0')}`),
      value: blob.subarray(i * chunkSize, (i + 1) * chunkSize),
    });
  }

  // Lay out one leaf page per row, each followed by its overflow chain: page 1 =
  // header+schema, page 2 = interior root, leaves + overflow from page 3.
  let nextPage = 3;
  const plans = rows.map((row, i) => {
    const record = encodeRecord([{ text: row.key }, { blob: row.value }]);
    const local = splitPayload(record.length);
    const ovPages = record.length > local ? Math.ceil((record.length - local) / OVERFLOW_CHUNK) : 0;
    const leafPage = nextPage++;
    const firstOverflow = ovPages > 0 ? nextPage : 0;
    nextPage += ovPages;
    return { rowid: i + 1, record, local, ovPages, leafPage, firstOverflow };
  });
  const pageCount = nextPage - 1;

  const out = new Uint8Array(pageCount * PAGE_SIZE);
  const dvOut = new DataView(out.buffer);

  // Page 1: file header + sqlite_master (one row: the `cache` table, root page 2).
  const schemaRecord = encodeRecord([
    { text: enc.encode('table') },
    { text: enc.encode('cache') },
    { text: enc.encode('cache') },
    { int: CACHE_ROOT_PAGE },
    { text: enc.encode(CREATE_SQL) },
  ]);
  const schemaCell = concatBytes(
    Uint8Array.from(putVarint(schemaRecord.length)),
    Uint8Array.from(putVarint(1)),
    schemaRecord,
  );
  const page1 = buildLeafPage([schemaCell], 100);
  writeHeader(page1, pageCount);
  out.set(page1, 0);

  // Page 2: interior root — one child per leaf, keyed by that leaf's rowid.
  const children = plans.map((p) => ({ page: p.leafPage, key: p.rowid }));
  const rightMost = children[children.length - 1]!.page;
  out.set(buildInteriorPage(children.slice(0, -1), rightMost), PAGE_SIZE);

  // Each leaf page (one row) + its overflow chain.
  for (const p of plans) {
    const cell = tableLeafCell(p.rowid, p.record, p.firstOverflow);
    out.set(buildLeafPage([cell], 0), (p.leafPage - 1) * PAGE_SIZE);
    let o = p.local;
    for (let j = 0; j < p.ovPages; j++) {
      const base = (p.firstOverflow - 1 + j) * PAGE_SIZE;
      const nextOv = j === p.ovPages - 1 ? 0 : p.firstOverflow + j + 1;
      dvOut.setUint32(base, nextOv, false); // 4-byte next-overflow-page pointer
      out.set(p.record.subarray(o, o + OVERFLOW_CHUNK), base + 4);
      o += OVERFLOW_CHUNK;
    }
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

function startsWith(a: Uint8Array, prefix: Uint8Array): boolean {
  if (a.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (a[i] !== prefix[i]) return false;
  return true;
}

/**
 * Extract the vault blob from a disguised SQLite database produced by
 * `packSqlite`, or null if the bytes are not such a database. Walks the interior
 * `cache` root to each leaf, reassembles every `page_cache_*` row (following its
 * overflow chain), and concatenates them in leaf (chunk) order.
 */
export function unpackSqlite(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < PAGE_SIZE) return null;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) if (bytes[i] !== SQLITE_MAGIC[i]) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(16, false) !== PAGE_SIZE) return null;
  const pageCount = dv.getUint32(28, false);
  if (bytes.length < pageCount * PAGE_SIZE) return null;

  const pageAt = (n: number): Uint8Array =>
    n >= 1 && n <= pageCount
      ? bytes.subarray((n - 1) * PAGE_SIZE, n * PAGE_SIZE)
      : new Uint8Array(0);

  // Reassemble a table-leaf cell's full payload, following overflow if needed.
  const reassemble = (page: Uint8Array, cellOff: number): Uint8Array | null => {
    let p = cellOff;
    const [P, n1] = readVarint(page, p);
    p += n1;
    const [, n2] = readVarint(page, p); // rowid (ignored)
    p += n2;
    const local = splitPayload(P);
    if (p + local > page.length) return null;
    const out = new Uint8Array(P);
    out.set(page.subarray(p, p + local), 0);
    let filled = local;
    if (P > local) {
      let nextPage = new DataView(page.buffer, page.byteOffset + p + local, 4).getUint32(0, false);
      while (nextPage !== 0 && filled < P) {
        if (nextPage < 1 || nextPage > pageCount) return null;
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

  // Child leaf pages of the `cache` table, in b-tree (rowid) order.
  const cache = pageAt(CACHE_ROOT_PAGE);
  const childPages: number[] = [];
  if (cache[0] === 0x05) {
    // Interior table page: [left-child 4B][varint rowid] cells + right-most pointer.
    const nCells = (cache[3]! << 8) | cache[4]!;
    const rootDv = new DataView(cache.buffer, cache.byteOffset, cache.byteLength);
    for (let i = 0; i < nCells; i++) {
      const cellOff = (cache[12 + i * 2]! << 8) | cache[12 + i * 2 + 1]!;
      childPages.push(rootDv.getUint32(cellOff, false));
    }
    childPages.push(rootDv.getUint32(8, false)); // right-most child
  } else if (cache[0] === 0x0d) {
    childPages.push(CACHE_ROOT_PAGE); // tolerate a single-leaf root
  } else {
    return null;
  }

  // Reassemble every page_cache_* row and concatenate in traversal order.
  const parts: Uint8Array[] = [];
  for (const cp of childPages) {
    const leaf = pageAt(cp);
    if (leaf[0] !== 0x0d) continue;
    const nCells = (leaf[3]! << 8) | leaf[4]!;
    for (let i = 0; i < nCells; i++) {
      const cellOff = (leaf[8 + i * 2]! << 8) | leaf[8 + i * 2 + 1]!;
      const payload = reassemble(leaf, cellOff);
      if (!payload) continue;
      const row = decodeRow(payload);
      if (row && startsWith(row.key, VAULT_KEY_PREFIX_BYTES)) parts.push(row.value);
    }
  }
  if (parts.length === 0) return null;
  const blob = concatBytes(...parts);
  return blob.length > 0 ? blob : null;
}
