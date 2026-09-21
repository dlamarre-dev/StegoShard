/**
 * Cover normalization: removing the provenance manifest a camera embeds, and
 * reporting on everything else that would tell one photo apart from another.
 *
 * WHY THIS EXISTS
 * Recent phones and cameras embed a signed C2PA manifest, which contains a hash
 * of the image content. Embedding a payload changes that content, so a carrier
 * fails validation, and the manifest additionally discloses the exact size of the
 * difference from the original. The manifest is therefore a fingerprint of the
 * cover carried *inside* the stego object: it makes the comparison attack
 * self-contained, automatable, and free. The hash cannot be recomputed (the
 * manufacturer holds the private key), so removal is the only countermeasure.
 *
 * UNIFORMITY IS THE SECURITY PROPERTY, NOT PURITY
 * The target is not "no metadata": a bare image is as odd as a signed one. The
 * target is the *same metadata profile across the whole cover set*. A gallery
 * where only the carriers lack provenance is exactly as discriminating as one
 * where only the carriers fail validation, so normalization is applied to every
 * cover, carriers and decoys alike. SPEC §9.7 states this normatively;
 * {@link inspectCoverSet} is what makes a deviation visible rather than silent.
 *
 * WHAT IS REMOVED, AND WHAT IS ONLY REPORTED
 * Removal is confined to one class: APP11 JUMBF segments, which is where a
 * provenance manifest lives. Everything else in this file inspects and reports. Two
 * reasons. First, a whole-segment drop of APP1/XMP would take the
 * `Container:Directory` with it, orphaning an Ultra HDR gain map that is still
 * physically present in the trailer: the photo would render SDR while carrying
 * the bytes for HDR, which is a visible anomaly rather than a removed one.
 * Second, the policy for XMP/EXIF identifiers cannot be written before an
 * inventory of what real devices actually emit, which is what the report is for.
 *
 * ORDERING
 * Normalization runs BEFORE embedding, never after: any container surgery on a
 * finished carrier risks touching the entropy stream. `stego.ts` calls it on the
 * two JPEG embed paths, so the invariant is structural rather than a step a
 * caller can forget.
 */

import { JpegUnsupportedError } from './jpeg-coeff';
import { mpfTrailerLink, retargetMpfIndex } from './mpf';
import {
  JpegStructureError,
  type JpegLayout,
  type JpegSegment,
  type TrailerKind,
  asciiBytes,
  classifyTrailer,
  hasSoi,
  parseJpegSegments,
  payloadStartsWith,
  segmentPayload,
} from './jpeg-segments';

/**
 * The two bytes that open JUMBF box carriage in an APP11 segment: `"JP"`.
 *
 * WHY TWO BYTES AND NOT FOUR
 * The full APP11 header is `"JP"` ‖ box instance number (u16) ‖ packet sequence
 * number (u32) ‖ the box itself, and the C2PA manifests this was built against
 * all carry instance 1, so `4A 50 00 01` matched every one of them. Matching the
 * instance number as though it were part of a magic was still wrong: it is a
 * counter, a producer is free to use another value, and a manifest carried at
 * instance 2 would have passed straight through a check that looked correct.
 *
 * So the match is the prefix that is actually fixed. The cost is that a JUMBF
 * box in APP11 that is not a C2PA manifest is removed too, and that is the
 * intended direction: APP11 is reserved for JPEG Systems box carriage, none of
 * it affects how the image renders, and the failure modes are not symmetric.
 * Removing a box nobody needed costs some bytes. Leaving one behind can carry a
 * hash of the cover into the stego object, which is the whole attack this exists
 * to remove. Over-removal is also safe for the property that matters here:
 * uniformity is preserved as long as the same rule runs over every photo in the
 * set, which SPEC §9.7 requires.
 *
 * A manifest too large for one segment is split across several, each repeating
 * this prefix, so every matching segment is removed rather than the first found.
 * SPEC §9.7 pins these bytes.
 */
export const JUMBF_APP11_PREFIX: readonly number[] = [0x4a, 0x50];

/** Thrown when a JPEG cannot be normalized without breaking something else. */
export class ProvenanceNormalizeError extends Error {
  constructor(reason: string) {
    super(`cannot normalize: ${reason}`);
    this.name = 'ProvenanceNormalizeError';
  }
}

// --- Segment classification --------------------------------------------------

/** What a marker segment is, for inventory and uniformity purposes. */
export type SegmentClass =
  | 'jfif'
  | 'exif'
  | 'xmp'
  | 'xmp-extension'
  | 'icc'
  | 'mpf'
  /** An APP11 JUMBF box: a provenance manifest, and the one class that is removed. */
  | 'jumbf'
  | 'iptc'
  | 'adobe'
  | 'comment'
  | 'other-app';

const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP11 = 0xeb;
const APP13 = 0xed;
const APP14 = 0xee;
const COM = 0xfe;

const P_JFIF = asciiBytes('JFIF\0');
const P_EXIF = asciiBytes('Exif\0\0');
const P_XMP = asciiBytes('http://ns.adobe.com/xap/1.0/\0');
const P_XMP_EXT = asciiBytes('http://ns.adobe.com/xmp/extension/\0');
const P_ICC = asciiBytes('ICC_PROFILE\0');
const P_MPF = asciiBytes('MPF\0');
const P_IPTC = asciiBytes('Photoshop 3.0\0');
const P_ADOBE = asciiBytes('Adobe');

/**
 * True when this segment carries a JUMBF box, which in practice means a
 * provenance manifest. See {@link JUMBF_APP11_PREFIX} for why the test is the
 * two-byte prefix and not the four bytes a C2PA manifest happens to start with.
 */
function isJumbf(bytes: Uint8Array, seg: JpegSegment): boolean {
  return seg.marker === APP11 && payloadStartsWith(bytes, seg, JUMBF_APP11_PREFIX);
}

/** Classify one segment, or null for the structural ones (SOF/DQT/DHT/SOS/DRI). */
function classify(bytes: Uint8Array, seg: JpegSegment): SegmentClass | null {
  switch (seg.marker) {
    case APP0:
      return payloadStartsWith(bytes, seg, P_JFIF) ? 'jfif' : 'other-app';
    case APP1:
      if (payloadStartsWith(bytes, seg, P_EXIF)) return 'exif';
      if (payloadStartsWith(bytes, seg, P_XMP)) return 'xmp';
      if (payloadStartsWith(bytes, seg, P_XMP_EXT)) return 'xmp-extension';
      return 'other-app';
    case APP2:
      if (payloadStartsWith(bytes, seg, P_ICC)) return 'icc';
      if (payloadStartsWith(bytes, seg, P_MPF)) return 'mpf';
      return 'other-app';
    case APP11:
      return isJumbf(bytes, seg) ? 'jumbf' : 'other-app';
    case APP13:
      return payloadStartsWith(bytes, seg, P_IPTC) ? 'iptc' : 'other-app';
    case APP14:
      return payloadStartsWith(bytes, seg, P_ADOBE) ? 'adobe' : 'other-app';
    case COM:
      return 'comment';
    default:
      // APPn we do not recognize still counts as an app segment: its presence or
      // absence is a difference between two photos even if we cannot name it.
      return seg.marker >= 0xe0 && seg.marker <= 0xef ? 'other-app' : null;
  }
}

// --- XMP findings ------------------------------------------------------------

/**
 * Identifying properties inside an XMP packet.
 *
 * Presence flags, not values: `xmpMM:DocumentID` is a per-capture UUID, so
 * printing it into a report would copy the identifier out of the file the report
 * exists to warn about. `itemLengths` is the exception and carries numbers,
 * because a length is not an identifier: it states how much of the trailer the
 * `Container:Directory` claims, which is what lets a reader of the report spot
 * an Ultra HDR photo whose declared gain map does not account for the bytes
 * after EOI.
 *
 * Nothing here is *enforced* against the trailer, and this used to claim
 * otherwise. Removal never touches a byte after EOI (SPEC §9.7), so surgery
 * cannot put a declared `Item:Length` out of agreement with the trailer, and a
 * check against it would only restate what the producer already wrote. These
 * are inventory, not an invariant.
 */
export interface XmpFindings {
  documentId: boolean;
  instanceId: boolean;
  originalDocumentId: boolean;
  history: boolean;
  digitalSourceType: boolean;
  /** The Ultra HDR / motion-photo container directory. Load-bearing: do not drop. */
  containerDirectory: boolean;
  /** `Item:Length` values declared by that directory, in document order. */
  itemLengths: number[];
  /** Google camera namespaces: HDR+, portrait, depth, motion photo. */
  gcamera: boolean;
  /** `hdrgm:` gain-map metadata. */
  hdrGainMap: boolean;
  /** Apple depth / portrait namespaces. */
  appleDepth: boolean;
}

const decodeLatin1 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

/**
 * Read the XMP packet as text and note which properties it declares.
 *
 * Substring matching rather than an XML parse, on purpose: the questions asked
 * here are all "is this property named anywhere in the packet", none of them
 * depend on document structure, and adding an XML parser to a codebase with six
 * runtime dependencies to answer them would be a poor trade. The one structural
 * read, `Item:Length`, is a fixed attribute spelling in the Container schema.
 * A whole-packet scrub would need a real parser; that is deliberately out of
 * scope here (see the module header).
 */
function readXmp(text: string): XmpFindings {
  const itemLengths: number[] = [];
  const re = /Item:Length\s*=\s*"(\d+)"/g;
  for (let m = re.exec(text); m; m = re.exec(text)) itemLengths.push(Number(m[1]));
  return {
    documentId: text.includes('xmpMM:DocumentID'),
    instanceId: text.includes('xmpMM:InstanceID'),
    originalDocumentId: text.includes('xmpMM:OriginalDocumentID'),
    history: text.includes('xmpMM:History'),
    digitalSourceType: text.includes('DigitalSourceType'),
    containerDirectory: text.includes('Container:Directory'),
    itemLengths,
    gcamera: text.includes('GCamera:') || text.includes('ns.google.com/photos'),
    hdrGainMap: text.includes('hdrgm:'),
    appleDepth: text.includes('apple_desktop') || text.includes('apdi:'),
  };
}

// --- EXIF findings -----------------------------------------------------------

/**
 * Tags worth naming from the EXIF IFDs.
 *
 * Values are carried for make, model, software and the capture timestamp: those
 * are device-class facts the user already knows about their own photos, and the
 * point of the report is to let them see what differs across a set. The serial
 * numbers, the maker note and the GPS block are presence flags only. Copying a
 * body serial number or a coordinate into a JSON report, or into a terminal
 * scrollback, would leak exactly what this feature is meant to contain.
 */
export interface ExifFindings {
  /** False when the APP1 payload was present but did not parse; the rest is then empty. */
  parsed: boolean;
  make?: string;
  model?: string;
  software?: string;
  dateTimeOriginal?: string;
  bodySerial: boolean;
  lensSerial: boolean;
  makerNote: boolean;
  gps: boolean;
}

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_SOFTWARE = 0x0131;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_MAKER_NOTE = 0x927c;
const TAG_BODY_SERIAL = 0xa431;
const TAG_LENS_SERIAL = 0xa435;

/** ASCII value of a tag, trimmed of its NUL terminator. */
function asciiValue(tiff: Uint8Array, offset: number, count: number): string | undefined {
  if (offset < 0 || offset + count > tiff.length) return undefined;
  let s = '';
  for (let i = 0; i < count; i++) {
    const c = tiff[offset + i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim() || undefined;
}

/**
 * Walk the TIFF IFDs of an EXIF payload, noting which tags are present.
 *
 * Bounds-checked everywhere and fail-soft: an EXIF block that does not parse
 * yields `parsed: false` rather than throwing. Inspection runs on the save path,
 * and a photo with an odd EXIF block must not be the thing that fails a save;
 * the removal path has its own hard failures, and they are about correctness,
 * not about curiosity.
 */
function readExif(payload: Uint8Array): ExifFindings {
  const empty: ExifFindings = {
    parsed: false,
    bodySerial: false,
    lensSerial: false,
    makerNote: false,
    gps: false,
  };
  // payload = "Exif\0\0" then the TIFF header.
  const tiff = payload.subarray(P_EXIF.length);
  if (tiff.length < 8) return empty;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return empty;
  const u16 = (o: number): number =>
    le ? tiff[o]! | (tiff[o + 1]! << 8) : (tiff[o]! << 8) | tiff[o + 1]!;
  const u32 = (o: number): number =>
    (le
      ? tiff[o]! | (tiff[o + 1]! << 8) | (tiff[o + 2]! << 16) | (tiff[o + 3]! << 24)
      : (tiff[o]! << 24) | (tiff[o + 1]! << 16) | (tiff[o + 2]! << 8) | tiff[o + 3]!) >>> 0;
  if (u16(2) !== 42) return empty;

  const found: ExifFindings = { ...empty, parsed: true };
  const seen = new Set<number>();
  const queue: number[] = [u32(4)];

  while (queue.length > 0) {
    const ifd = queue.shift()!;
    // A malformed file can point an IFD at itself; visiting each offset once
    // bounds the walk without needing to trust the file's structure.
    if (ifd <= 0 || ifd + 2 > tiff.length || seen.has(ifd)) continue;
    seen.add(ifd);
    const count = u16(ifd);
    if (ifd + 2 + count * 12 > tiff.length) continue;
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      // An ASCII value of 4 bytes or fewer is inlined in the entry itself.
      const inline = type === 2 && n <= 4;
      const valueAt = inline ? e + 8 : u32(e + 8);
      // An unreadable or empty ASCII value leaves its key absent rather than
      // present-and-undefined, which is the distinction the callers report on.
      switch (tag) {
        case TAG_MAKE: {
          const v = asciiValue(tiff, valueAt, n);
          if (v !== undefined) found.make = v;
          break;
        }
        case TAG_MODEL: {
          const v = asciiValue(tiff, valueAt, n);
          if (v !== undefined) found.model = v;
          break;
        }
        case TAG_SOFTWARE: {
          const v = asciiValue(tiff, valueAt, n);
          if (v !== undefined) found.software = v;
          break;
        }
        case TAG_DATETIME_ORIGINAL: {
          const v = asciiValue(tiff, valueAt, n);
          if (v !== undefined) found.dateTimeOriginal = v;
          break;
        }
        case TAG_BODY_SERIAL:
          found.bodySerial = true;
          break;
        case TAG_LENS_SERIAL:
          found.lensSerial = true;
          break;
        case TAG_MAKER_NOTE:
          found.makerNote = true;
          break;
        case TAG_GPS_IFD:
          found.gps = true;
          break;
        case TAG_EXIF_IFD:
          queue.push(u32(e + 8));
          break;
        default:
          break;
      }
    }
  }
  return found;
}

// --- One cover's profile -----------------------------------------------------

/** Everything the inventory knows about one JPEG. */
export interface CoverProfile {
  /** Segment classes present, deduplicated, in first-seen order. */
  classes: SegmentClass[];
  /** APP11 JUMBF fragments, and the bytes they occupy: the provenance manifest. */
  jumbf: { segments: number; bytes: number };
  /** XMP properties, or null when the file carries no XMP packet. */
  xmp: XmpFindings | null;
  /** EXIF tags, or null when the file carries no EXIF segment. */
  exif: ExifFindings | null;
  /** True when an APP2 `MPF\0` index is present (Ultra HDR / MPO). */
  mpf: boolean;
  trailer: { kind: TrailerKind; bytes: number };
  totalBytes: number;
}

/** Find the first segment of a class, or undefined. */
function firstOfClass(
  bytes: Uint8Array,
  layout: JpegLayout,
  want: SegmentClass,
): JpegSegment | undefined {
  return layout.segments.find((s) => classify(bytes, s) === want);
}

/**
 * Inventory one JPEG without modifying it. Throws
 * {@link import('./jpeg-segments').JpegStructureError} when the file does not
 * parse, which is the same refusal the removal path makes.
 */
export function inspectJpegCover(bytes: Uint8Array): CoverProfile {
  const layout = parseJpegSegments(bytes);
  const classes: SegmentClass[] = [];
  let jumbfSegments = 0;
  let jumbfBytes = 0;

  for (const seg of layout.segments) {
    const cls = classify(bytes, seg);
    if (cls === null) continue;
    if (!classes.includes(cls)) classes.push(cls);
    if (cls === 'jumbf') {
      jumbfSegments++;
      jumbfBytes += seg.end - seg.start;
    }
  }

  // The extension packets repeat the same properties as the main one, so the
  // main packet is the one read; its absence with an extension present is itself
  // recorded through `classes`.
  const xmpSeg = firstOfClass(bytes, layout, 'xmp');
  const exifSeg = firstOfClass(bytes, layout, 'exif');

  return {
    classes,
    jumbf: { segments: jumbfSegments, bytes: jumbfBytes },
    xmp: xmpSeg ? readXmp(decodeLatin1(segmentPayload(bytes, xmpSeg))) : null,
    exif: exifSeg ? readExif(segmentPayload(bytes, exifSeg)) : null,
    mpf: firstOfClass(bytes, layout, 'mpf') !== undefined,
    trailer: {
      kind: classifyTrailer(bytes, layout.trailerStart),
      bytes: bytes.length - layout.trailerStart,
    },
    totalBytes: bytes.length,
  };
}

// --- Removal -----------------------------------------------------------------

/** The prefix `JpegStructureError` puts on its reason, so `relabel` can lift it back off. */
const STRUCTURE_PREFIX = 'malformed JPEG: ';

/**
 * Name the file in a structural failure, when the caller supplied a name.
 *
 * A gallery save walks a dozen photos in a loop, and "malformed JPEG: no EOI"
 * without a filename tells the user only that one of the twelve is bad. `label`
 * therefore means the same thing everywhere in this module: name this file in
 * whatever goes wrong with it.
 */
function relabel(err: unknown, label: string | undefined): unknown {
  if (!label || !(err instanceof JpegStructureError)) return err;
  const reason = err.message.startsWith(STRUCTURE_PREFIX)
    ? err.message.slice(STRUCTURE_PREFIX.length)
    : err.message;
  return new JpegStructureError(`${label}: ${reason}`);
}

/** What a normalization pass did. */
export interface NormalizeResult {
  /**
   * The normalized file. **The input array itself** when nothing was removed, so
   * "a file with no manifest is unchanged byte for byte" holds by construction
   * rather than by comparison.
   */
  bytes: Uint8Array;
  /** Manifest segments removed, and the bytes they occupied. */
  removed: { segments: number; bytes: number };
}

/**
 * Remove every APP11 JUMBF segment from a baseline JPEG, changing nothing else.
 * That is where a C2PA provenance manifest lives; see
 * {@link JUMBF_APP11_PREFIX} for why the test is deliberately wider than C2PA.
 *
 * Segment-level surgery only: the entropy-coded scan is copied verbatim, so the
 * quantized DCT coefficients are bit-identical and an embed that runs afterwards
 * hides exactly what it would have hidden in the original. The trailer after EOI
 * (an Ultra HDR gain map, an Android motion-photo video) is likewise copied
 * verbatim, in full, always.
 *
 * MPF: THE INDEX IS REWRITTEN, NOT ASSERTED AGAINST
 * An APP2 `MPF\0` index locates the trailer images by offsets relative to its
 * own endian header, not to the start of the file. Removing a segment that sits
 * *before* that header shifts the header and the trailer by the same amount, so
 * the offsets stay correct; removing one that sits *after* it shifts only the
 * trailer, which leaves the gain map unreachable.
 *
 * That second case used to be refused. It is rewritten instead: `mpf.ts` reads
 * the index before the surgery and puts the new positions back afterwards
 * (SPEC §9.7.1), which keeps the photos the feature exists for usable instead of
 * turning away every Ultra HDR file whose manifest happens to sit late. The
 * refusal remains for an index this code cannot read, because moving a trailer
 * under offsets nobody understands is the outcome §9.7 is about.
 *
 * None of this applies when nothing follows EOI: an index with no trailer
 * locates no second image, so there is no offset a shift can invalidate.
 */
export function normalizeJpegCover(bytes: Uint8Array, label?: string): NormalizeResult {
  let layout: JpegLayout;
  try {
    layout = parseJpegSegments(bytes);
  } catch (err) {
    throw relabel(err, label);
  }
  const doomed = layout.segments.filter((s) => isJumbf(bytes, s));
  if (doomed.length === 0) return { bytes, removed: { segments: 0, bytes: 0 } };

  // What the index says about the trailer, read before the removal moves either
  // of them. `none` for a file with no index or nothing after EOI, which is
  // most of them; `unreadable` is the one case still refused.
  //
  // `label` names the file in whatever goes wrong with it. A gallery save
  // normalizes many photos in a loop, and "one of your photos cannot be
  // normalized" is not an actionable thing to be told.
  const named = label ? `${label}: ` : '';
  const link = mpfTrailerLink(bytes, layout);
  if (link.kind === 'unreadable') throw new ProvenanceNormalizeError(`${named}${link.reason}`);

  let removedBytes = 0;
  for (const s of doomed) removedBytes += s.end - s.start;
  const out = new Uint8Array(bytes.length - removedBytes);
  let read = 0;
  let write = 0;
  for (const s of doomed) {
    out.set(bytes.subarray(read, s.start), write);
    write += s.start - read;
    read = s.end;
  }
  // Everything from the last removal to the end of the buffer: the remaining
  // segments, the entropy scan, EOI, and the whole trailer, verbatim.
  out.set(bytes.subarray(read), write);

  // The trailer is now `removedBytes` earlier in the file. Say so in the index,
  // or refuse if that cannot be done, rather than return a file whose gain map
  // points into the middle of the scan.
  if (link.kind === 'index') {
    const retarget = retargetMpfIndex(out, link);
    if (!retarget.ok) throw new ProvenanceNormalizeError(`${named}${retarget.reason}`);
  }

  return { bytes: out, removed: { segments: doomed.length, bytes: removedBytes } };
}

/**
 * Normalize when the bytes are a JPEG, and pass anything else through untouched.
 *
 * This is the wrapper the embed paths call, and it differs from
 * {@link normalizeJpegCover} in two deliberate ways.
 *
 * It ignores non-JPEG bytes, because a PNG cover reaches the embed paths as
 * pixels and has already lost its metadata to the decode/re-encode round trip,
 * while something that is not an image at all should be refused by the codec
 * rather than by a structural complaint from here.
 *
 * And it re-throws a structural failure, or a removal it had to refuse, as
 * {@link JpegUnsupportedError}. A JPEG whose marker structure cannot be walked is
 * a JPEG this layer cannot promise carries no manifest, and one whose MPF index
 * cannot be kept correct is one it cannot promise still resolves its gain map;
 * either way it must not be embedded into. From the embed layer's point of view
 * both are the same fact as "not a usable cover", which is a refusal every
 * adapter already translates to `StegoCoverFormatError`. Letting the precise
 * class out here instead would leak an unhandled type through four adapters to
 * say something they already say. The explicit API keeps that class, because a
 * normalization *report* should distinguish "malformed" from "not baseline" from
 * "could not be kept consistent".
 */
export function normalizeCoverBytes(bytes: Uint8Array, label?: string): NormalizeResult {
  if (!hasSoi(bytes)) return { bytes, removed: { segments: 0, bytes: 0 } };
  try {
    return normalizeJpegCover(bytes, label);
  } catch (err) {
    if (err instanceof JpegStructureError || err instanceof ProvenanceNormalizeError) {
      throw new JpegUnsupportedError(err.message);
    }
    throw err;
  }
}

// --- Set-level uniformity ----------------------------------------------------

/** One file handed to {@link inspectCoverSet}. */
export interface CoverSetEntry {
  name: string;
  bytes: Uint8Array;
}

/** What a member of the set turned out to be. */
export type CoverKind = 'jpeg' | 'png' | 'heif' | 'other';

/** ISOBMFF brands that mean "this is a HEIF/HEIC/AVIF still image". */
const HEIF_BRANDS = [
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
  'avif',
  'avis',
];

/** How far into the `ftyp` box to read compatible brands. */
const FTYP_BRAND_SCAN = 64;

/**
 * True for a HEIF/HEIC/AVIF still image.
 *
 * StegoShard never ingests one. There are no JPEG DCT coefficients in an
 * HEVC-coded image to carry a payload, and SPEC §5.4 refuses to transcode,
 * because re-encoding would change the file's size and appearance and defeat the
 * deniability the carrier exists for. So this is not a format whose manifest
 * needs removing here: it is a format that has to leave the set before the set
 * is a set.
 *
 * Detected so the refusal can say that, instead of surfacing as a decoder stack
 * trace, and so {@link inspectCoverSet} can name the case that actually matters:
 * a library that is HEIC everywhere except the handful of photos converted to
 * JPEG to carry something. Converting only the carriers is the same mistake as
 * normalizing only the carriers. Convert the whole set, with one tool, at one
 * setting, or use a set that was JPEG to begin with.
 */
export function isHeif(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // Box layout: size(4) ‖ "ftyp" ‖ major_brand(4) ‖ minor_version(4) ‖ compatible…
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) {
    return false;
  }
  // The brand list ends where the box does. Scanning a fixed 64 bytes read on
  // past a short `ftyp`, so an ISOBMFF file that is not HEIF but carries the
  // ASCII of a HEIF brand in a later box was refused as a HEIC it is not. A size
  // of 0 means "to the end of the file", which is the fixed scan again; a size of
  // 1 means the real size is a 64-bit field this does not read, and a `ftyp` is
  // never written that way, so that lands on the same clamp as a malformed box.
  const boxSize = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  const box = boxSize === 0 ? bytes.length : boxSize;
  if (box < 12) return false;
  const limit = Math.min(bytes.length, FTYP_BRAND_SCAN, box);
  for (let p = 8; p + 4 <= limit; p += 4) {
    // The minor version sits between the major brand and the compatible list and
    // is a number, not a brand; reading it as one cannot collide with the table.
    let brand = '';
    for (let i = 0; i < 4; i++) brand += String.fromCharCode(bytes[p + i]!);
    if (HEIF_BRANDS.includes(brand)) return true;
  }
  return false;
}

/** One row of the set report. */
export interface CoverSetRow {
  name: string;
  kind: CoverKind;
  /** Null when the file is not a JPEG, or is a JPEG that did not parse. */
  profile: CoverProfile | null;
  /** Why the profile is null, when the file is a JPEG that did not parse. */
  problem?: string;
}

/** A class that some covers carry and others do not. */
export interface CoverSetDivergence {
  segmentClass: SegmentClass;
  presentIn: string[];
  absentFrom: string[];
}

/** The uniformity report for a whole cover set. */
export interface CoverSetReport {
  files: CoverSetRow[];
  /** Classes carried by every parsed cover: the profile the set already shares. */
  common: SegmentClass[];
  /** Classes carried by some but not all: what makes the set discriminating. */
  divergent: CoverSetDivergence[];
  /** Covers still carrying a provenance manifest. */
  withManifest: string[];
  /** Trailer kinds seen across the set, deduplicated. */
  trailerKinds: TrailerKind[];
  /**
   * JPEGs whose structure did not parse, so uniformity cannot be asserted over
   * them.
   *
   * **JPEGs only.** A PNG or a HEIC has no profile here either, but that is a
   * format this module does not inspect rather than a file it could not read,
   * and a set is sorted by format through `files[].kind` instead. Counting every
   * non-JPEG as unparsed made `uniform` false for a set of nothing but PNGs,
   * with an empty list of divergences to explain it: the report said the photos
   * could be told apart and then named nothing that told them apart, on the one
   * verdict this feature exists to deliver.
   */
  unparsed: string[];
  /**
   * True only when every JPEG parsed, every member is the same kind of file, no
   * class diverges, and no manifest is left. Anything less is a set an adversary
   * can sort, which is the property SPEC §9.7 is about.
   *
   * A set that is all one non-JPEG format is uniform on the evidence this module
   * has, which is the answer `gallery.ts` already gives for an all-raster cover
   * set: no PNG chunk was inspected here, `files` says so per member, and a
   * caller that needs "inspected *and* uniform" reads both.
   */
  uniform: boolean;
}

const isPng = (b: Uint8Array): boolean => b[0] === 0x89 && b[1] === 0x50;

/**
 * Inspect a whole cover set and report what makes it sortable.
 *
 * Set-level rather than per-file because uniformity *is* a property of the set:
 * a photo is never non-uniform on its own. That is also why the CLI subcommand
 * takes a whole directory rather than a file at a time, and why the gallery
 * builder runs this over the carriers and the decoys together.
 *
 * Reports on the bytes it is given. Callers wanting a before/after picture run
 * it twice, which keeps this function free of any opinion about when
 * normalization happened.
 */
export function inspectCoverSet(entries: readonly CoverSetEntry[]): CoverSetReport {
  const files: CoverSetRow[] = entries.map((e) => {
    const kind: CoverKind = hasSoi(e.bytes)
      ? 'jpeg'
      : isPng(e.bytes)
        ? 'png'
        : isHeif(e.bytes)
          ? 'heif'
          : 'other';
    if (kind !== 'jpeg') return { name: e.name, kind, profile: null };
    try {
      return { name: e.name, kind, profile: inspectJpegCover(e.bytes) };
    } catch (err) {
      return {
        name: e.name,
        kind,
        profile: null,
        problem: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const parsed = files.filter((f) => f.profile !== null);
  // A JPEG that failed to parse, only. Everything else with no profile is a
  // format this module does not inspect; `kinds` below is what catches those.
  const unparsed = files.filter((f) => f.kind === 'jpeg' && f.profile === null).map((f) => f.name);

  const everyClass: SegmentClass[] = [];
  for (const f of parsed) {
    for (const c of f.profile!.classes) if (!everyClass.includes(c)) everyClass.push(c);
  }
  const common: SegmentClass[] = [];
  const divergent: CoverSetDivergence[] = [];
  for (const c of everyClass) {
    const presentIn = parsed.filter((f) => f.profile!.classes.includes(c)).map((f) => f.name);
    if (presentIn.length === parsed.length) {
      common.push(c);
    } else {
      divergent.push({
        segmentClass: c,
        presentIn,
        absentFrom: parsed.filter((f) => !f.profile!.classes.includes(c)).map((f) => f.name),
      });
    }
  }

  const withManifest = parsed.filter((f) => f.profile!.jumbf.segments > 0).map((f) => f.name);
  const trailerKinds: TrailerKind[] = [];
  for (const f of parsed) {
    const k = f.profile!.trailer.kind;
    if (!trailerKinds.includes(k)) trailerKinds.push(k);
  }
  const kinds = new Set(files.map((f) => f.kind));

  return {
    files,
    common,
    divergent,
    withManifest,
    trailerKinds,
    unparsed,
    uniform:
      unparsed.length === 0 &&
      kinds.size <= 1 &&
      divergent.length === 0 &&
      withManifest.length === 0 &&
      trailerKinds.length <= 1,
  };
}
