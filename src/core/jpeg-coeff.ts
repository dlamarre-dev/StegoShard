/**
 * Minimal **baseline** JPEG codec at the quantized-DCT-coefficient level, for
 * deniable JPEG steganography (SPEC §5.4). It does NOT produce pixels: it
 * decodes the entropy-coded scan into per-block quantized coefficients, and
 * re-encodes those coefficients back into an entropy scan using the file's own
 * Huffman tables. Every non-scan segment (APPn/EXIF, DQT, DHT, SOF, DRI) is kept
 * byte-for-byte, so an embed touches only the scan — the output is the same JPEG
 * (same metadata, ~same size) with a few coefficient LSBs changed.
 *
 * Scope: baseline sequential, 8-bit, Huffman (SOF0) only. Progressive (SOF2),
 * arithmetic coding, and files missing required tables are rejected — we never
 * guess, so we never mis-embed. Handles byte-stuffing, restart markers (DRI /
 * RSTn), multiple DHT/DQT segments, and chroma subsampling (per SOF sampling
 * factors). Pure integer work → deterministic across JS and the Python reader.
 */

/** Thrown when a JPEG is not plain baseline (progressive, arithmetic, truncated…). */
export class JpegUnsupportedError extends Error {
  constructor(reason: string) {
    super(`unsupported JPEG: ${reason}`);
    this.name = 'JpegUnsupportedError';
  }
}

interface HuffTable {
  /** decode: key (len<<16)|code → symbol */
  dec: Map<number, number>;
  /** encode: symbol → {code, len} */
  enc: Map<number, { code: number; len: number }>;
}

interface Component {
  id: number;
  h: number; // horizontal sampling factor
  v: number; // vertical sampling factor
  dcTableId: number;
  acTableId: number;
  /** One Int16Array(64) per 8×8 block, in interleaved MCU decode order. */
  blocks: Int16Array[];
  /**
   * Parallel to `blocks`: for each block, the **logical bit index** (in the
   * unstuffed entropy stream) of each AC coefficient's mantissa LSB, or -1.
   * Enables byte-faithful in-place editing (toggle just that bit).
   */
  bitpos: Int32Array[];
}

export interface JpegModel {
  bytes: Uint8Array; // original file bytes (segments are sliced from here on encode)
  width: number;
  height: number;
  restartInterval: number;
  components: Component[];
  /** byte range [scanStart, scanEnd) of the entropy-coded scan in `bytes`. */
  scanStart: number;
  scanEnd: number;
  maxH: number;
  maxV: number;
  mcusPerLine: number;
  mcusPerColumn: number;
}

const u16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;

/** True if the bytes start with the JPEG SOI marker. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function buildHuff(bits: number[], values: number[]): HuffTable {
  const dec = new Map<number, number>();
  const enc = new Map<number, { code: number; len: number }>();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]!; i++) {
      const sym = values[k++]!;
      dec.set((len << 16) | code, sym);
      enc.set(sym, { code, len });
      code++;
    }
    code <<= 1;
  }
  return { dec, enc };
}

/** Bit reader over the entropy scan with byte-unstuffing and marker awareness. */
class BitReader {
  private byte = 0;
  private bits = 0;
  /** Count of data bits read from the unstuffed stream so far (for bit offsets). */
  logical = 0;
  /** Set when a marker (non-stuffed FF xx) is hit; the scan segment has ended. */
  marker = 0;
  constructor(
    private data: Uint8Array,
    private pos: number,
    private end: number,
  ) {}

  /** Byte-align and return the pending marker code (after 0xFF), or 0. */
  private fill(): void {
    if (this.pos >= this.end) {
      this.byte = 0;
      this.bits = 8; // feed 1s past the end (JPEG pad convention)
      this.byte = 0xff;
      return;
    }
    let b = this.data[this.pos++]!;
    if (b === 0xff) {
      const next = this.data[this.pos] ?? 0xd9;
      if (next === 0x00) {
        this.pos++; // stuffed FF00 → literal 0xFF
      } else {
        this.marker = next;
        // Don't consume the marker; feed 1-bits so any in-flight read completes.
        b = 0xff;
      }
    }
    this.byte = b;
    this.bits = 8;
  }

  readBit(): number {
    if (this.bits === 0) this.fill();
    this.bits--;
    this.logical++;
    return (this.byte >> this.bits) & 1;
  }

  readBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit();
    return v;
  }

  /** Advance past a restart marker (FF D0..D7) at a byte boundary. */
  consumeRestart(): void {
    // We're byte-aligned by construction after a full MCU when restart hits.
    this.bits = 0;
    this.marker = 0;
    // Skip any fill bytes up to the FF Dn.
    while (this.pos < this.end && this.data[this.pos] !== 0xff) this.pos++;
    if (this.pos + 1 < this.end) this.pos += 2; // skip FF Dn
  }

  bytePos(): number {
    return this.pos;
  }
}

/** Sign-extend an `n`-bit magnitude read as a JPEG coefficient value. */
function extend(v: number, n: number): number {
  return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
}

function decodeHuffSym(br: BitReader, table: HuffTable): number {
  let code = 0;
  for (let len = 1; len <= 16; len++) {
    code = (code << 1) | br.readBit();
    const sym = table.dec.get((len << 16) | code);
    if (sym !== undefined) return sym;
  }
  throw new JpegUnsupportedError('bad Huffman code in scan');
}

/**
 * Decode a baseline JPEG into its quantized DCT coefficients. Throws
 * JpegUnsupportedError for anything not plain baseline.
 */
export function decode(bytes: Uint8Array): JpegModel {
  if (!isJpeg(bytes)) throw new JpegUnsupportedError('not a JPEG (no SOI)');
  const dcTables: (HuffTable | undefined)[] = [];
  const acTables: (HuffTable | undefined)[] = [];
  let frame:
    { width: number; height: number; comps: Component[]; maxH: number; maxV: number } | undefined;
  let restartInterval = 0;
  let o = 2;

  while (o < bytes.length) {
    if (bytes[o] !== 0xff) throw new JpegUnsupportedError('expected marker');
    const marker = bytes[o + 1]!;
    o += 2;
    if (marker === 0xd9) break; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone
    const len = u16(bytes, o);
    const segStart = o + 2;
    const segEnd = o + len;

    if (marker === 0xc0) {
      // SOF0 — baseline
      if (bytes[segStart] !== 8) throw new JpegUnsupportedError('precision != 8');
      const height = u16(bytes, segStart + 1);
      const width = u16(bytes, segStart + 3);
      const nf = bytes[segStart + 5]!;
      const comps: Component[] = [];
      let maxH = 1;
      let maxV = 1;
      for (let i = 0; i < nf; i++) {
        const p = segStart + 6 + i * 3;
        const id = bytes[p]!;
        const h = bytes[p + 1]! >> 4;
        const v = bytes[p + 1]! & 15;
        maxH = Math.max(maxH, h);
        maxV = Math.max(maxV, v);
        comps.push({ id, h, v, dcTableId: 0, acTableId: 0, blocks: [], bitpos: [] });
      }
      frame = { width, height, comps, maxH, maxV };
    } else if (marker === 0xc2) {
      throw new JpegUnsupportedError('progressive (SOF2)');
    } else if (marker === 0xc9 || marker === 0xcb) {
      throw new JpegUnsupportedError('arithmetic coding');
    } else if (marker === 0xc4) {
      // DHT — may hold several tables
      let p = segStart;
      while (p < segEnd) {
        const tc = bytes[p]! >> 4; // 0 DC, 1 AC
        const th = bytes[p]! & 15;
        p++;
        const counts: number[] = [];
        let total = 0;
        for (let i = 0; i < 16; i++) {
          counts.push(bytes[p + i]!);
          total += bytes[p + i]!;
        }
        p += 16;
        const values: number[] = [];
        for (let i = 0; i < total; i++) values.push(bytes[p + i]!);
        p += total;
        const table = buildHuff(counts, values);
        if (tc === 0) dcTables[th] = table;
        else acTables[th] = table;
      }
    } else if (marker === 0xdd) {
      restartInterval = u16(bytes, segStart);
    } else if (marker === 0xda) {
      // SOS — map scan components to frame components, then decode the scan.
      if (!frame) throw new JpegUnsupportedError('SOS before SOF');
      const ns = bytes[segStart]!;
      for (let i = 0; i < ns; i++) {
        const cs = bytes[segStart + 1 + i * 2]!;
        const td = bytes[segStart + 2 + i * 2]! >> 4;
        const ta = bytes[segStart + 2 + i * 2]! & 15;
        const comp = frame.comps.find((c) => c.id === cs);
        if (!comp) throw new JpegUnsupportedError('SOS component not in SOF');
        comp.dcTableId = td;
        comp.acTableId = ta;
      }
      const scanStart = segEnd; // entropy bytes begin right after the SOS header
      const model = decodeScan(bytes, scanStart, frame, dcTables, acTables, restartInterval);
      return model;
    }
    o = segEnd;
  }
  throw new JpegUnsupportedError('no scan found');
}

function decodeScan(
  bytes: Uint8Array,
  scanStart: number,
  frame: { width: number; height: number; comps: Component[]; maxH: number; maxV: number },
  dcTables: (HuffTable | undefined)[],
  acTables: (HuffTable | undefined)[],
  restartInterval: number,
): JpegModel {
  const { width, height, comps, maxH, maxV } = frame;
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  const br = new BitReader(bytes, scanStart, bytes.length);
  const pred = new Array(comps.length).fill(0);

  let mcu = 0;
  const totalMcus = mcusPerLine * mcusPerColumn;
  for (let my = 0; my < mcusPerColumn; my++) {
    for (let mx = 0; mx < mcusPerLine; mx++) {
      if (restartInterval > 0 && mcu > 0 && mcu % restartInterval === 0) {
        br.consumeRestart();
        pred.fill(0);
      }
      for (let ci = 0; ci < comps.length; ci++) {
        const comp = comps[ci]!;
        const dc = dcTables[comp.dcTableId];
        const ac = acTables[comp.acTableId];
        if (!dc || !ac) throw new JpegUnsupportedError('missing Huffman table for scan');
        for (let by = 0; by < comp.v; by++) {
          for (let bx = 0; bx < comp.h; bx++) {
            const block = new Int16Array(64);
            const bitpos = new Int32Array(64).fill(-1);
            // DC
            const t = decodeHuffSym(br, dc);
            const diff = t === 0 ? 0 : extend(br.readBits(t), t);
            pred[ci] += diff;
            block[0] = pred[ci];
            // AC
            let k = 1;
            while (k < 64) {
              const rs = decodeHuffSym(br, ac);
              const r = rs >> 4;
              const s = rs & 15;
              if (s === 0) {
                if (r === 15) {
                  k += 16;
                  continue;
                }
                break; // EOB
              }
              k += r;
              if (k >= 64) break;
              block[k] = extend(br.readBits(s), s);
              bitpos[k] = br.logical - 1; // logical index of this coefficient's LSB
              k++;
            }
            comp.blocks.push(block);
            comp.bitpos.push(bitpos);
          }
        }
      }
      mcu++;
    }
  }
  void totalMcus;
  void br;

  // The entropy scan ends at the next real marker (skipping FF00 stuffing and
  // RSTn restart markers), located by a forward scan from the scan start.
  const scanEnd = findScanEnd(bytes, scanStart);

  return {
    bytes,
    width,
    height,
    restartInterval,
    components: comps,
    scanStart,
    scanEnd,
    maxH,
    maxV,
    mcusPerLine,
    mcusPerColumn,
  };
}

/** Scan forward for the marker that ends the entropy segment (skips FF00/RSTn). */
function findScanEnd(bytes: Uint8Array, from: number): number {
  let p = from;
  while (p < bytes.length - 1) {
    if (bytes[p] === 0xff) {
      const m = bytes[p + 1]!;
      if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
        p += 2; // stuffed byte or restart marker — still inside the scan
        continue;
      }
      return p; // real marker (EOI or next segment)
    }
    p++;
  }
  return bytes.length;
}

// --- Encoder -----------------------------------------------------------------

/** Number of bits needed to represent |v| (0 for v==0). */
function magBits(v: number): number {
  let n = 0;
  let a = Math.abs(v);
  while (a > 0) {
    n++;
    a >>= 1;
  }
  return n;
}

/** JPEG mantissa for a value at a given size category. */
function mantissa(v: number, size: number): number {
  return v >= 0 ? v : v + (1 << size) - 1;
}

class BitWriter {
  private out: number[] = [];
  private acc = 0;
  private nbits = 0;

  writeBits(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      this.nbits++;
      if (this.nbits === 8) this.flushByte();
    }
  }

  private flushByte(): void {
    const b = this.acc & 0xff;
    this.out.push(b);
    if (b === 0xff) this.out.push(0x00); // byte-stuffing
    this.acc = 0;
    this.nbits = 0;
  }

  /** Pad the final partial byte with 1-bits (JPEG convention) and stuff if 0xFF. */
  align(): void {
    if (this.nbits > 0) {
      this.acc = (this.acc << (8 - this.nbits)) | ((1 << (8 - this.nbits)) - 1);
      this.nbits = 8;
      this.flushByte();
    }
  }

  bytes(): number[] {
    return this.out;
  }
}

/** Re-encode the coefficients into a baseline entropy scan and splice it back. */
export function encode(model: JpegModel): Uint8Array {
  // Rebuild the Huffman *encode* tables from the file's own DHT segments.
  const { dcTables, acTables } = readHuffTables(model.bytes);
  const bw = new BitWriter();
  const pred = new Array(model.components.length).fill(0);
  const cursor = new Array(model.components.length).fill(0);
  const rst = model.restartInterval;
  let mcu = 0;
  let rstn = 0;

  for (let my = 0; my < model.mcusPerColumn; my++) {
    for (let mx = 0; mx < model.mcusPerLine; mx++) {
      if (rst > 0 && mcu > 0 && mcu % rst === 0) {
        bw.align();
        bw.writeBits(0xff, 8);
        bw.writeBits(0xd0 + rstn, 8);
        rstn = (rstn + 1) & 7;
        pred.fill(0);
      }
      for (let ci = 0; ci < model.components.length; ci++) {
        const comp = model.components[ci]!;
        const dc = dcTables[comp.dcTableId]!;
        const ac = acTables[comp.acTableId]!;
        for (let n = 0; n < comp.h * comp.v; n++) {
          const block = comp.blocks[cursor[ci]++]!;
          encodeBlock(bw, block, dc, ac, pred, ci);
        }
      }
      mcu++;
    }
  }
  bw.align();

  const scan = bw.bytes();
  const head = model.bytes.subarray(0, model.scanStart);
  const tail = model.bytes.subarray(model.scanEnd);
  const out = new Uint8Array(head.length + scan.length + tail.length);
  out.set(head, 0);
  out.set(scan, head.length);
  out.set(tail, head.length + scan.length);
  return out;
}

function encodeBlock(
  bw: BitWriter,
  block: Int16Array,
  dc: HuffTable,
  ac: HuffTable,
  pred: number[],
  ci: number,
): void {
  const diff = block[0]! - pred[ci]!;
  pred[ci] = block[0]!;
  const ds = magBits(diff);
  const dcode = dc.enc.get(ds)!;
  bw.writeBits(dcode.code, dcode.len);
  if (ds > 0) bw.writeBits(mantissa(diff, ds), ds);

  let run = 0;
  let last = 0;
  for (let k = 63; k >= 1; k--) {
    if (block[k] !== 0) {
      last = k;
      break;
    }
  }
  for (let k = 1; k <= last; k++) {
    if (block[k] === 0) {
      run++;
      continue;
    }
    while (run > 15) {
      const zrl = ac.enc.get(0xf0)!;
      bw.writeBits(zrl.code, zrl.len);
      run -= 16;
    }
    const s = magBits(block[k]!);
    const rs = (run << 4) | s;
    const code = ac.enc.get(rs)!;
    bw.writeBits(code.code, code.len);
    bw.writeBits(mantissa(block[k]!, s), s);
    run = 0;
  }
  if (last < 63) {
    const eob = ac.enc.get(0x00)!;
    bw.writeBits(eob.code, eob.len);
  }
}

/** Re-read the DHT tables from a JPEG for the encoder (matches decode()). */
function readHuffTables(bytes: Uint8Array): {
  dcTables: (HuffTable | undefined)[];
  acTables: (HuffTable | undefined)[];
} {
  const dcTables: (HuffTable | undefined)[] = [];
  const acTables: (HuffTable | undefined)[] = [];
  let o = 2;
  while (o < bytes.length) {
    if (bytes[o] !== 0xff) break;
    const marker = bytes[o + 1]!;
    o += 2;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const len = u16(bytes, o);
    const segStart = o + 2;
    const segEnd = o + len;
    if (marker === 0xc4) {
      let p = segStart;
      while (p < segEnd) {
        const tc = bytes[p]! >> 4;
        const th = bytes[p]! & 15;
        p++;
        const counts: number[] = [];
        let total = 0;
        for (let i = 0; i < 16; i++) {
          counts.push(bytes[p + i]!);
          total += bytes[p + i]!;
        }
        p += 16;
        const values: number[] = [];
        for (let i = 0; i < total; i++) values.push(bytes[p + i]!);
        p += total;
        const table = buildHuff(counts, values);
        if (tc === 0) dcTables[th] = table;
        else acTables[th] = table;
      }
    } else if (marker === 0xda) {
      break;
    }
    o = segEnd;
  }
  return { dcTables, acTables };
}

/**
 * Enumerate the eligible AC coefficients (|coef| ≥ 2), in a fixed deterministic
 * order (component, block, zig-zag index 1..63). Returns accessors so stego can
 * read/modify the LSB of the magnitude without knowing the model layout.
 */
export function eligibleCoefficients(model: JpegModel): {
  count: number;
  get(i: number): number;
  setLsb(i: number, bit: number): void;
} {
  const refs: { block: Int16Array; k: number }[] = [];
  for (const comp of model.components) {
    for (const block of comp.blocks) {
      for (let k = 1; k < 64; k++) {
        if (Math.abs(block[k]!) >= 2) refs.push({ block, k });
      }
    }
  }
  return {
    count: refs.length,
    get(i: number): number {
      const { block, k } = refs[i]!;
      return Math.abs(block[k]!) & 1;
    },
    setLsb(i: number, bit: number): void {
      const { block, k } = refs[i]!;
      const v = block[k]!;
      const mag = Math.abs(v);
      const newMag = (mag & ~1) | bit; // |coef|≥2 ⇒ stays ≥2, same size category
      block[k] = v < 0 ? -newMag : newMag;
    },
  };
}

/**
 * In-place accessors for the same eligible carriers, exposing each coefficient's
 * current magnitude LSB and the logical bit index of that LSB in the entropy
 * stream. Used by the byte-faithful embed path (`applyScanToggles`).
 */
export function eligibleInPlace(model: JpegModel): {
  count: number;
  get(i: number): number;
  bitPos(i: number): number;
} {
  const refs: { mag: number; pos: number }[] = [];
  for (const comp of model.components) {
    for (let bi = 0; bi < comp.blocks.length; bi++) {
      const block = comp.blocks[bi]!;
      const bp = comp.bitpos[bi]!;
      for (let k = 1; k < 64; k++) {
        if (Math.abs(block[k]!) >= 2) refs.push({ mag: Math.abs(block[k]!) & 1, pos: bp[k]! });
      }
    }
  }
  return {
    count: refs.length,
    get: (i) => refs[i]!.mag,
    bitPos: (i) => refs[i]!.pos,
  };
}

/**
 * Byte-faithful embed: return the original JPEG with **only** the given entropy
 * bits toggled — every other byte is identical, so there is no re-serialization
 * fingerprint and a diff against the original shows the theoretical minimum. Bit
 * indices are logical (unstuffed) positions from `eligibleInPlace`. Toggling a
 * mantissa LSB flips the coefficient's magnitude LSB regardless of sign, and
 * (because |coef| ≥ 2 keeps the same Huffman size category) never changes any
 * code length, so all other bit positions stay valid.
 *
 * Only valid for `restartInterval === 0` (a single entropy segment); the caller
 * falls back to a full re-encode for the rare restart-marker files.
 */
export function applyScanToggles(model: JpegModel, positions: number[]): Uint8Array {
  const scan = model.bytes.subarray(model.scanStart, model.scanEnd);

  // Unstuff: drop the 0x00 that follows every 0xFF (valid in a no-restart scan).
  const logical = new Uint8Array(scan.length);
  let n = 0;
  for (let i = 0; i < scan.length; i++) {
    const b = scan[i]!;
    logical[n++] = b;
    if (b === 0xff && scan[i + 1] === 0x00) i++;
  }

  for (const pos of positions) logical[pos >> 3]! ^= 0x80 >> (pos & 7);

  // Re-stuff: a 0x00 after every 0xFF. Size the output by counting 0xFF bytes.
  let ffCount = 0;
  for (let i = 0; i < n; i++) if (logical[i] === 0xff) ffCount++;
  const restuffed = new Uint8Array(n + ffCount);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const b = logical[i]!;
    restuffed[m++] = b;
    if (b === 0xff) restuffed[m++] = 0x00;
  }

  const head = model.bytes.subarray(0, model.scanStart);
  const tail = model.bytes.subarray(model.scanEnd);
  const out = new Uint8Array(head.length + restuffed.length + tail.length);
  out.set(head, 0);
  out.set(restuffed, head.length);
  out.set(tail, head.length + restuffed.length);
  return out;
}
