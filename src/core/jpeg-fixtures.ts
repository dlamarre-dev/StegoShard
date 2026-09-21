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
 * A minimal APP2 `MPF\0` index.
 *
 * Only the header is modelled: a big-endian TIFF marker and an entry count. The
 * assertion under test is positional (is a removal before or after this header),
 * so the entry bodies are never read, and filling them with plausible-looking
 * offsets would suggest this validates more than it does.
 */
export function mpfSegment(): Uint8Array {
  const tiff = new Uint8Array(24);
  tiff.set(bytesOf('MM'), 0); // big-endian
  tiff[2] = 0x00;
  tiff[3] = 0x2a; // 42
  tiff[7] = 0x08; // offset to first IFD
  return appSegment(0xe2, concat(bytesOf('MPF\0'), tiff));
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
