/**
 * Synthetic JPEGs carrying the segments real cameras emit: C2PA manifests, XMP
 * packets, MPF indices, Ultra HDR gain maps and motion-photo trailers.
 *
 * **Test fixtures only.** Nothing in `src/` imports this, it is absent from the
 * `index.ts` barrel and from the public facade, so it is not part of any shipped
 * bundle. It lives beside the code rather than under `tests/` because three test
 * files need the same builders and importing one `.test.ts` from another makes a
 * runner execute its suites twice.
 *
 * Built rather than committed, for the reason `tests/steganalysis/conftest.py`
 * gives about its sample set: a generator is reviewable, a binary blob is not,
 * and a real camera original carries the maintainer's GPS coordinates, capture
 * times and body serial number into a public git history. The tradeoff is real
 * and is stated in the module header of `normalize.test.ts`: these exercise every
 * branch, and they cannot tell us what a Pixel 10 actually puts in its APP11.
 * The opt-in suite over real photos is what answers that.
 *
 * The splice helpers mirror `insertDri` in `stego.errors.test.ts`, which solved
 * the same problem first: walk the marker chain, insert framed bytes at a chosen
 * point, leave the entropy-coded scan alone.
 */

import jpeg from 'jpeg-js';
import { asciiBytes } from './jpeg-segments';
import { JUMBF_APP11_PREFIX } from './normalize';

/**
 * A textured baseline JPEG with plenty of `|coef| ≥ 2` carriers, so a fixture is
 * also usable as a stego cover. Same LCG as the other suites use, so the output
 * is deterministic across runs and platforms.
 */
export function baseJpeg(width = 128, height = 128, quality = 85, seed = 1): Uint8Array {
  const data = Buffer.alloc(width * height * 4);
  let s = seed >>> 0;
  for (let i = 0; i < width * height; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i * 4] = (s >>> 24) & 0xff;
    data[i * 4 + 1] = (s >>> 16) & 0xff;
    data[i * 4 + 2] = (s >>> 8) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width, height }, quality).data);
}

/** Frame a payload as a marker segment: `FF <marker> <u16 length> <payload>`. */
export function appSegment(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.length + 2; // the length field counts itself
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (len >> 8) & 0xff;
  out[3] = len & 0xff;
  out.set(payload, 4);
  return out;
}

const bytesOf = asciiBytes;

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Insert framed bytes immediately after SOI, i.e. before every other segment. */
export function spliceAfterSoi(bytes: Uint8Array, segment: Uint8Array): Uint8Array {
  return concat(bytes.subarray(0, 2), segment, bytes.subarray(2));
}

/** Insert framed bytes immediately before SOS, i.e. after every other segment. */
export function spliceBeforeSos(bytes: Uint8Array, segment: Uint8Array): Uint8Array {
  let o = 2;
  while (o < bytes.length - 1) {
    if (bytes[o] !== 0xff) throw new Error('fixture: lost marker alignment');
    if (bytes[o + 1] === 0xda) break; // SOS
    o += 2 + ((bytes[o + 2]! << 8) | bytes[o + 3]!);
  }
  return concat(bytes.subarray(0, o), segment, bytes.subarray(o));
}

/**
 * One APP11 JUMBF fragment.
 *
 * Payload layout: `"JP"` ‖ box instance number (u16) ‖ packet sequence number
 * (u32) ‖ the box bytes. `instance` is a parameter rather than a constant
 * precisely because the matcher no longer looks at it: a manifest carried at
 * instance 2 must be removed exactly like one at instance 1, and before the
 * prefix was narrowed to `"JP"` it would not have been. A manifest larger than
 * one segment repeats the whole header with an incrementing sequence number,
 * which is what `fragments` reproduces below.
 */
export function jumbfSegment(sequence: number, instance = 1, bodyLength = 64): Uint8Array {
  const body = new Uint8Array(bodyLength);
  for (let i = 0; i < bodyLength; i++) body[i] = (i * 31 + sequence * 7) & 0xff;
  const head = new Uint8Array(8);
  head.set(JUMBF_APP11_PREFIX, 0); // "JP"
  head[2] = (instance >> 8) & 0xff;
  head[3] = instance & 0xff;
  head[4] = (sequence >>> 24) & 0xff;
  head[5] = (sequence >>> 16) & 0xff;
  head[6] = (sequence >>> 8) & 0xff;
  head[7] = sequence & 0xff;
  return appSegment(0xeb, concat(head, body));
}

/** A C2PA-shaped fragment: JUMBF at box instance 1, as the phones write it. */
export function c2paSegment(sequence: number, bodyLength = 64): Uint8Array {
  return jumbfSegment(sequence, 1, bodyLength);
}

/** Add `fragments` C2PA APP11 segments, in sequence, before SOS. */
export function withC2pa(bytes: Uint8Array, fragments = 1): Uint8Array {
  let out = bytes;
  for (let i = 1; i <= fragments; i++) out = spliceBeforeSos(out, c2paSegment(i));
  return out;
}

/**
 * An APP11 segment that is not JUMBF at all, so it must survive.
 *
 * The line the widened matcher draws: anything opening with `"JP"` in APP11 goes,
 * whatever its box instance; anything else is left where it is.
 */
export function foreignApp11(): Uint8Array {
  return appSegment(0xeb, concat(bytesOf('XX'), new Uint8Array([0x00, 0x01]), bytesOf('other')));
}

/** An APP1 XMP packet wrapping `body` in the usual rdf scaffolding. */
export function xmpSegment(body: string): Uint8Array {
  const xml =
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ` +
    `xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `${body}</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return appSegment(0xe1, concat(bytesOf('http://ns.adobe.com/xap/1.0/\0'), bytesOf(xml)));
}

/** XMP as a Pixel writes it: identifiers, GCamera, and an Ultra HDR container. */
export function pixelXmp(gainMapLength: number): Uint8Array {
  return xmpSegment(
    `<rdf:Description xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" ` +
      `xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" ` +
      `xmlns:Container="http://ns.google.com/photos/1.0/container/" ` +
      `xmlns:Item="http://ns.google.com/photos/1.0/container/item/" ` +
      `xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" ` +
      `xmpMM:DocumentID="xmp.did:0000" xmpMM:InstanceID="xmp.iid:0000" ` +
      `hdrgm:Version="1.0">` +
      `<xmpMM:History><rdf:Seq><rdf:li rdf:parseType="Resource"/></rdf:Seq></xmpMM:History>` +
      `<Container:Directory><rdf:Seq>` +
      `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" ` +
      `Item:Mime="image/jpeg"/></rdf:li>` +
      `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" ` +
      `Item:Mime="image/jpeg" Item:Length="${gainMapLength}"/></rdf:li>` +
      `</rdf:Seq></Container:Directory>` +
      `</rdf:Description>`,
  );
}

/**
 * A **header-only** APP2 `MPF\0` index: a TIFF marker and nothing behind it.
 *
 * Deliberately unreadable as an index, and kept for exactly that: it is the
 * cover shape `mpf.ts` answers `unreadable` for, and the embed paths refuse. A
 * file like this is malformed rather than unusual, which is why refusing it turns
 * away nothing a camera produces. Use {@link mpfIndexSegment} for an index with
 * entries in it.
 */
export function mpfSegment(): Uint8Array {
  const tiff = new Uint8Array(24);
  tiff.set(bytesOf('MM'), 0); // big-endian
  tiff[2] = 0x00;
  tiff[3] = 0x2a; // 42
  tiff[7] = 0x08; // offset to first IFD
  return appSegment(0xe2, concat(bytesOf('MPF\0'), tiff));
}

/** Where the MP Entry array sits: past the 8-byte header, the IFD, and its terminator. */
const MP_ENTRIES_AT = 8 + 2 + 3 * 12 + 4;

/**
 * A complete APP2 `MPF\0` index for `images` pictures (CIPA DC-007), with the
 * per-image sizes and offsets left at zero for {@link patchMpfIndex} to fill in
 * once the file is assembled and the positions are known.
 *
 * Three IFD tags, which is what a phone writes: MPFVersion, NumberOfImages, and
 * the MPEntry array the offsets live in. Both byte orders are legal and the
 * reader branches on it, so `littleEndian` exists to reach the other arm.
 */
export function mpfIndexSegment(images = 2, littleEndian = false): Uint8Array {
  const tiff = new Uint8Array(MP_ENTRIES_AT + images * 16);
  const put16 = (o: number, v: number) => {
    tiff[o] = littleEndian ? v & 0xff : (v >> 8) & 0xff;
    tiff[o + 1] = littleEndian ? (v >> 8) & 0xff : v & 0xff;
  };
  const put32 = (o: number, v: number) => {
    const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    tiff.set(littleEndian ? b.reverse() : b, o);
  };

  tiff.set(bytesOf(littleEndian ? 'II' : 'MM'), 0);
  put16(2, 42);
  put32(4, 8); // the MP Index IFD follows the header

  put16(8, 3); // three tags
  const tag = (i: number) => 8 + 2 + i * 12;
  put16(tag(0), 0xb000); // MPFVersion
  put16(tag(0) + 2, 7); // UNDEFINED
  put32(tag(0) + 4, 4);
  tiff.set(bytesOf('0100'), tag(0) + 8); // version 1.00, inline
  put16(tag(1), 0xb001); // NumberOfImages
  put16(tag(1) + 2, 4); // LONG
  put32(tag(1) + 4, 1);
  put32(tag(1) + 8, images);
  put16(tag(2), 0xb002); // MPEntry
  put16(tag(2) + 2, 7); // UNDEFINED
  put32(tag(2) + 4, images * 16);
  put32(tag(2) + 8, MP_ENTRIES_AT); // an offset, being longer than four bytes
  put32(8 + 2 + 3 * 12, 0); // no MP Attribute IFD

  return appSegment(0xe2, concat(bytesOf('MPF\0'), tiff));
}

/**
 * Fill in the MP Entry array of an assembled file, given the length of each
 * image that sits after EOI in order.
 *
 * Entry 1 is the primary image: its size spans SOI to EOI, which is where the
 * trailer begins, and its offset is 0 by definition. Each later entry gets its
 * own length and an offset **from the MP endian header**, which is the one place
 * this format measures from and the whole reason the index has to be rewritten
 * when anything ahead of the trailer changes length.
 *
 * The endian header is found by searching for `MPF\0` rather than by walking the
 * markers: in a synthetic file the string appears once, and a fixture that used
 * the parser under test to place its own bytes would be proving nothing.
 */
export function patchMpfIndex(file: Uint8Array, trailerLengths: number[]): Uint8Array {
  const out = Uint8Array.from(file);
  const marker = bytesOf('MPF\0');
  let at = -1;
  for (let i = 0; i + marker.length <= out.length && at < 0; i++) {
    if (marker.every((b, k) => out[i + k] === b)) at = i;
  }
  if (at < 0) throw new Error('fixture: no MPF segment to patch');

  const endianAt = at + marker.length;
  const little = out[endianAt] === 0x49;
  const put32 = (o: number, v: number) => {
    const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.set(little ? b.reverse() : b, o);
  };

  const trailerStart = out.length - trailerLengths.reduce((n, len) => n + len, 0);
  const entries = endianAt + MP_ENTRIES_AT;
  put32(entries + 4, trailerStart); // primary image size
  put32(entries + 8, 0); // primary image offset, always zero
  let position = trailerStart;
  trailerLengths.forEach((len, i) => {
    const entry = entries + (i + 1) * 16;
    put32(entry + 4, len);
    put32(entry + 8, position - endianAt);
    position += len;
  });
  return out;
}

/** Offset from the MP endian header of entry `i`'s Individual Image Size field. */
export function mpfEntrySizeField(i: number): number {
  return MP_ENTRIES_AT + i * 16 + 4;
}

/** Offset from the MP endian header of entry `i`'s Individual Image Data Offset. */
export function mpfEntryOffsetField(i: number): number {
  return MP_ENTRIES_AT + i * 16 + 8;
}

/**
 * A copy of `file` with `values` written `fromHeader` bytes past the MP endian
 * header: one field of an index broken, everything else intact.
 *
 * The header is found by searching for `MPF\0` rather than by walking the
 * markers. In a synthetic file the string appears once, and a fixture that used
 * the parser under test to place its own bytes would be proving nothing.
 */
export function pokeMpfIndex(
  file: Uint8Array,
  fromHeader: number,
  ...values: number[]
): Uint8Array {
  const out = Uint8Array.from(file);
  const marker = bytesOf('MPF\0');
  for (let i = 0; i + marker.length <= out.length; i++) {
    if (marker.every((b, k) => out[i + k] === b)) {
      out.set(values, i + marker.length + fromHeader);
      return out;
    }
  }
  throw new Error('fixture: no MPF segment to poke');
}

/**
 * An Ultra HDR photo: `base` with an MPF index that correctly locates a gain map
 * after its EOI. The shape a recent Pixel writes on every HDR shot, and the one
 * the embed paths used to refuse.
 */
export function withMpfGainMap(base: Uint8Array, littleEndian = false): Uint8Array {
  const gainMap = gainMapTrailer();
  const indexed = spliceBeforeSos(base, mpfIndexSegment(2, littleEndian));
  return patchMpfIndex(withTrailer(indexed, gainMap), [gainMap.length]);
}

/** An EXIF APP1 whose IFD0 carries Make, Model, Software and a body serial. */
export function exifSegment(
  make = 'Google',
  model = 'Pixel 10',
  software = 'HDR+ 1.0.0',
): Uint8Array {
  const strings = [make, model, software].map((s) => bytesOf(`${s}\0`));
  const entries = 4; // Make, Model, Software, BodySerialNumber
  const ifdLen = 2 + entries * 12 + 4;
  const header = 8;
  const body = concat(...strings);
  const tiff = new Uint8Array(header + ifdLen + body.length);
  tiff.set(bytesOf('MM'), 0);
  tiff[3] = 0x2a;
  tiff[7] = 0x08; // IFD0 at offset 8
  const put16 = (o: number, v: number) => {
    tiff[o] = (v >> 8) & 0xff;
    tiff[o + 1] = v & 0xff;
  };
  const put32 = (o: number, v: number) => {
    tiff[o] = (v >>> 24) & 0xff;
    tiff[o + 1] = (v >>> 16) & 0xff;
    tiff[o + 2] = (v >>> 8) & 0xff;
    tiff[o + 3] = v & 0xff;
  };
  put16(header, entries);
  const tags = [0x010f, 0x0110, 0x0131];
  let valueAt = header + ifdLen;
  tags.forEach((tag, i) => {
    const e = header + 2 + i * 12;
    put16(e, tag);
    put16(e + 2, 2); // ASCII
    put32(e + 4, strings[i]!.length);
    put32(e + 8, valueAt);
    valueAt += strings[i]!.length;
  });
  // BodySerialNumber, inlined: 4 bytes fits in the entry, which is also the
  // branch of `readExif` that reads a value out of the entry rather than at an
  // offset, so a fixture exercising it is worth having.
  const serial = header + 2 + 3 * 12;
  put16(serial, 0xa431);
  put16(serial + 2, 2);
  put32(serial + 4, 4);
  tiff.set(bytesOf('AB0\0'), serial + 8);
  put32(header + 2 + entries * 12, 0); // no IFD1
  tiff.set(body, header + ifdLen);
  return appSegment(0xe1, concat(bytesOf('Exif\0\0'), tiff));
}

/**
 * The GPS rationals this fixture writes: 45° 30′ 15″, degrees over 1.
 *
 * Exported so a test can search the produced bytes for them. That is the
 * assertion that matters about a scrub: not that a reader no longer finds the
 * block, but that the numbers are not in the file any more.
 */
export const GPS_FIXTURE_RATIONALS = [45, 1, 30, 1, 15, 1];

/**
 * An EXIF APP1 carrying Make, Model and a **GPS IFD** with a real coordinate.
 *
 * Shaped the way a phone writes one: IFD0 holds a GPS pointer tag, the GPS IFD
 * sits elsewhere in the block, its two refs are inlined in their entries (two
 * ASCII bytes each) and its two coordinates are three RATIONALs apiece, which at
 * 24 bytes are far too big to inline and therefore live out in the value area.
 * Both halves matter: the entry, and the out-of-line value it addresses.
 */
export function exifSegmentWithGps(
  littleEndian = false,
  make = 'Google',
  model = 'Pixel 10',
): Uint8Array {
  const le = littleEndian;
  const strings = [make, model].map((s) => bytesOf(`${s}\0`));
  const HEADER = 8;
  const IFD0_AT = HEADER;
  const IFD0_LEN = 2 + 3 * 12 + 4; // Make, Model, GPSInfo, then the next-IFD offset
  const GPS_AT = IFD0_AT + IFD0_LEN;
  const GPS_LEN = 2 + 4 * 12 + 4; // LatRef, Lat, LonRef, Lon
  const VALUES_AT = GPS_AT + GPS_LEN;
  const coord = 3 * 8; // three RATIONALs

  const size = VALUES_AT + strings[0]!.length + strings[1]!.length + 2 * coord;
  const tiff = new Uint8Array(size);
  const put16 = (o: number, v: number) => {
    tiff[o] = le ? v & 0xff : (v >> 8) & 0xff;
    tiff[o + 1] = le ? (v >> 8) & 0xff : v & 0xff;
  };
  const put32 = (o: number, v: number) => {
    const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    tiff.set(le ? b.reverse() : b, o);
  };

  tiff.set(bytesOf(le ? 'II' : 'MM'), 0);
  put16(2, 42);
  put32(4, IFD0_AT);

  put16(IFD0_AT, 3);
  const entry0 = (i: number): number => IFD0_AT + 2 + i * 12;
  let valueAt = VALUES_AT;
  [0x010f, 0x0110].forEach((tag, i) => {
    put16(entry0(i), tag);
    put16(entry0(i) + 2, 2); // ASCII
    put32(entry0(i) + 4, strings[i]!.length);
    put32(entry0(i) + 8, valueAt);
    tiff.set(strings[i]!, valueAt);
    valueAt += strings[i]!.length;
  });
  put16(entry0(2), 0x8825); // GPSInfo IFD pointer
  put16(entry0(2) + 2, 4); // LONG
  put32(entry0(2) + 4, 1);
  put32(entry0(2) + 8, GPS_AT);
  put32(IFD0_AT + 2 + 3 * 12, 0); // no IFD1

  put16(GPS_AT, 4);
  const entryG = (i: number): number => GPS_AT + 2 + i * 12;
  const ref = (i: number, tag: number, text: string): void => {
    put16(entryG(i), tag);
    put16(entryG(i) + 2, 2); // ASCII
    put32(entryG(i) + 4, 2);
    tiff.set(bytesOf(`${text}\0`), entryG(i) + 8); // two bytes: inlined
  };
  const rationals = (i: number, tag: number): void => {
    put16(entryG(i), tag);
    put16(entryG(i) + 2, 5); // RATIONAL
    put32(entryG(i) + 4, 3);
    put32(entryG(i) + 8, valueAt);
    for (let k = 0; k < 6; k++) put32(valueAt + k * 4, GPS_FIXTURE_RATIONALS[k]!);
    valueAt += coord;
  };
  ref(0, 0x0001, 'N');
  rationals(1, 0x0002);
  ref(2, 0x0003, 'W');
  rationals(3, 0x0004);
  put32(GPS_AT + 2 + 4 * 12, 0); // no IFD after the GPS one

  return appSegment(0xe1, concat(bytesOf('Exif\0\0'), tiff));
}

/** Append bytes after EOI, as a gain map or a motion-photo video would sit. */
export function withTrailer(bytes: Uint8Array, trailer: Uint8Array): Uint8Array {
  return concat(bytes, trailer);
}

/** An MPO gain map: a second, smaller JPEG stream. */
export function gainMapTrailer(): Uint8Array {
  return baseJpeg(32, 32, 70, 9);
}

/** An Android motion-photo trailer: an ISOBMFF stream opening with `ftyp`. */
export function mp4Trailer(totalLength = 96): Uint8Array {
  const out = new Uint8Array(totalLength);
  out[3] = 0x18; // box size 24
  out.set(bytesOf('ftypmp42'), 4);
  return out;
}

/**
 * A minimal **little-endian** EXIF carrying only Software.
 *
 * The full `exifSegment` is big-endian, which is what the phones this was built
 * for write. Both byte orders are legal and the reader branches on it, so the
 * other arm needs a fixture or it is code nothing has ever executed.
 */
export function exifSegmentLE(software = 'Adobe Lightroom'): Uint8Array {
  const value = bytesOf(`${software}\0`);
  const header = 8;
  const ifdLen = 2 + 12 + 4;
  const tiff = new Uint8Array(header + ifdLen + value.length);
  tiff.set(bytesOf('II'), 0); // little-endian
  tiff[2] = 0x2a;
  tiff[4] = 0x08; // IFD0 at offset 8
  const put16 = (o: number, v: number) => {
    tiff[o] = v & 0xff;
    tiff[o + 1] = (v >> 8) & 0xff;
  };
  const put32 = (o: number, v: number) => {
    tiff[o] = v & 0xff;
    tiff[o + 1] = (v >>> 8) & 0xff;
    tiff[o + 2] = (v >>> 16) & 0xff;
    tiff[o + 3] = (v >>> 24) & 0xff;
  };
  put16(header, 1); // one entry
  put16(header + 2, 0x0131); // Software
  put16(header + 4, 2); // ASCII
  put32(header + 6, value.length);
  put32(header + 10, header + ifdLen);
  put32(header + 14, 0); // no IFD1
  tiff.set(value, header + ifdLen);
  return appSegment(0xe1, concat(bytesOf('Exif\0\0'), tiff));
}

/** An ICC colour profile segment: present on most camera JPEGs, always kept. */
export function iccSegment(): Uint8Array {
  return appSegment(0xe2, concat(bytesOf('ICC_PROFILE\0'), new Uint8Array([1, 1, 0, 0, 0, 0])));
}

/** An APP13 Photoshop IRB, which is where IPTC data lives. */
export function iptcSegment(): Uint8Array {
  return appSegment(
    0xed,
    concat(bytesOf('Photoshop 3.0\0'), new Uint8Array([0x38, 0x42, 0x49, 0x4d])),
  );
}

/** An APP14 Adobe segment, which records the colour transform. */
export function adobeSegment(): Uint8Array {
  return appSegment(0xee, concat(bytesOf('Adobe'), new Uint8Array([0, 100, 0, 0, 0, 0, 1])));
}

/** A COM comment segment. */
export function commentSegment(text = 'created with a camera'): Uint8Array {
  return appSegment(0xfe, bytesOf(text));
}

/** An APP1 extended-XMP packet, the continuation of an oversized XMP block. */
export function xmpExtensionSegment(): Uint8Array {
  return appSegment(
    0xe1,
    concat(bytesOf('http://ns.adobe.com/xmp/extension/\0'), new Uint8Array(40)),
  );
}

/** An APP4 segment: an APPn this code does not recognize but must still count. */
export function unknownAppSegment(): Uint8Array {
  return appSegment(0xe4, bytesOf('VENDORBLOCK'));
}

/** A HEIC file header, for the cover-format refusal. */
export function heicHeader(): Uint8Array {
  const out = new Uint8Array(32);
  out[3] = 0x18;
  out.set(bytesOf('ftypheic'), 4);
  out.set(bytesOf('mif1heic'), 16);
  return out;
}
