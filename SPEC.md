# StegoShard format specification, v1

This document is the **pre-1.0 versioned candidate** for the StegoShard on-image
format. It describes everything needed to decode a vault **without the extension**,
so the data survives even if the extension disappears. Any conforming
implementation (including the Python reference decoder, Phase 3) must interoperate
with images produced by format version 1.

> **Status:** beta candidate for format version 1 (`FORMAT_VERSION = 1`). Audit-driven
> breaking changes may still be folded into this candidate. The compatibility freeze
> begins with the public 1.0 release.

All multi-byte integers are **big-endian**. All lengths are in bytes.

---

## 1. Pipeline overview

**Export** (file → images):

```
file bytes
  → payload envelope         (§4)   [FLAGS][NAME_LEN][FILENAME][CONTENT], content gzip-optional,
                                     optionally a .zip bundle of several files
  → AES-GCM encrypt (DEK)    (§5)   → ciphertext
  → vault blob               (§6)   [KB_LEN][key block][IV][ciphertext]
  → Reed-Solomon erasure     (§7)   k data + m parity shards, equal length
  → per-image payload        (§3)   header ‖ shard
  → codec render             (§2)   one symbol per image (qr-grid or color-grid)
```

**Import** reverses each step. Reconstruction succeeds if **any k of the k+m**
shards survive (§7).

---

## 2. Image codecs

Two codecs turn the per-image payload of §3 into pixels. `CODEC_ID` in the header
records which one produced an image, but it is **descriptive, not dispatch**:
the header lives inside the payload, so a decoder cannot read it until it has
already decoded the image. Decoders therefore sniff: mean chroma over a sparse
sample of the pixels separates a greyscale QR from a saturated color grid, the
likelier codec is tried first, and the other is the fallback. A wrong guess costs
one extra attempt, never a failure.

### 2.1 `qr-grid` (`CODEC_ID = 0`)

Each image carries one **standard QR code** (a 1×1 grid in v1). The QR payload is
the per-image payload of §3, placed in **byte mode**. QR's built-in Reed-Solomon
provides intra-image error correction; the cross-image erasure coding of §7 is
separate and additional.

- **Error-correction level and per-image capacity by profile.** The Disk profile
  is lossless, so it uses the lowest QR ECC level for maximum density; Cloud and
  Paper trade capacity for resilience. `capacity` is the usable total payload
  (header + shard) per image, kept under the version-40 byte-mode maximum:

  | Profile | ECC level | Usable payload (bytes) |
  | ------- | --------- | ---------------------- |
  | Disk    | `L`       | 2800                   |
  | Cloud   | `Q`       | 1600                   |
  | Paper   | `H`       | 800                    |

- **Quiet zone:** 4 modules.
- **Rendering:** dark modules are painted black (luminance 0), light modules white
  (luminance 255), scaled by an integer module size. The Disk profile is lossless
  (PNG), so rendering is a faithful byte round-trip.
- **Decoding:** locate and decode the QR symbol; the recovered bytes are the §3
  payload. (The Python reference decoder uses `zxing-cpp`, which returns the raw
  byte content, which matters for binary payloads.)

**Paper output always uses this codec.** Print, ink and camera white balance make
colour a liability, so §2.2 is refused for `PROFILE_PAPER`.

### 2.2 `color-grid` (`CODEC_ID = 2`)

The digital-output codec. Each module is one of **eight colours**, the corners of
the RGB cube, and so carries **3 bits**, against QR byte mode's ~0.75 bits per
module. In practice that is ~3x the payload per image at Disk and ~2.3x at Cloud.

The eight colours are maximally separated in RGB, which is what lets this survive
JPEG. But chroma is the first thing a lossy codec discards (4:2:0 halves chroma
resolution spatially, then quantizes it more coarsely than luma), so the Cloud
profile uses large modules, samples only the middle of each one, and carries a
much higher parity ratio.

#### Palette

Value `v` maps to `(bit2 = R, bit1 = G, bit0 = B)`, each channel fully off or on:

| `v` | 0     | 1    | 2     | 3    | 4   | 5       | 6      | 7     |
| --- | ----- | ---- | ----- | ---- | --- | ------- | ------ | ----- |
|     | black | blue | green | cyan | red | magenta | yellow | white |

#### Symbol layout

A square grid of `n` modules, with a 4-module white quiet zone.

- **Finders.** Four 7x7 concentric bullseyes at the corners, in black and white
  only, so they survive chroma damage and are locatable by plain greyscale
  thresholding. The centre line of each reads `1:1:3:1:1`
  dark-light-dark-light-dark, as in QR. Each finder reserves an **8x8 box**: one
  extra module of white separator on its two inner sides, without which an
  adjacent dark data module merges with the outer ring and destroys the run
  signature.
- **Palette calibration.** Row `y = 8`, columns `x = 0…7`, holding values `0…7` in
  canonical order. The decoder classifies data modules against these **observed**
  colours rather than the nominal ones, which is what absorbs JPEG chroma shift,
  gamma and white-balance drift.
- **Data modules.** Everything else, read **column-major** (`x` outer, `y` inner),
  skipping reserved modules. Each contributes 3 bits, packed MSB-first. The byte
  stream is rarely a whole number of modules, so the final module carries one or
  two real bits and zero padding.
- **No format-information region.** Everything the decoder needs comes from the
  geometry: the finder run lengths give the module pitch, the pitch and the
  finder-centre span give `n`, and `n` selects the whole layout.

#### Error correction

Intra-image protection reuses the same Cauchy Reed-Solomon code as §7. That code
corrects **erasures**, not errors, and it must be told which blocks are bad, so each
block carries its own checksum:

1. The image payload is prefixed with a `u32` length and padded to `k·64`.
2. It is split into `k` data blocks of **64 bytes**.
3. `m` parity blocks are computed with the §7 encoding matrix.
4. Every block, data and parity alike, is stored as `block ‖ CRC-32(block)`, i.e.
   68 bytes. The CRC is IEEE 802.3 (reflected, polynomial `0xEDB88320`), the same
   function as zlib's `crc32`.

The decoder verifies each CRC, passes the failures as erasures, and reconstructs.
Because module order is column-major, **each block occupies a contiguous vertical
stripe**: localized damage destroys a few blocks outright, which an erasure code
absorbs, rather than lightly corrupting every block, which it cannot.

#### Filler

The bytes between the payload and `k·64`, and the handful of modules past the end
of the byte stream, carry no information. Their **content is unspecified**: a
decoder reads exactly `payload.length` bytes after the prefix and MUST ignore the
rest. They are still covered by the block CRCs and the RS parity, like any other
byte.

Encoders should not leave them zeroed. The filler sits _outside_ the encryption,
so a zeroed run paints a flat black band whose width states how much of the
capacity the secret actually used. The reference encoder fills it from a small
PRNG seeded with `CRC-32(payload)`, per-image rather than constant, so the same
pattern does not appear in every part-full symbol and give the boundary away when
two are compared.

#### Profiles

`n` is a pure function of the profile, and every other parameter is a pure
function of `n`:

| Profile | `n` | Module px | Parity | Blocks (`k` + `m`) | Usable payload | Rendered size |
| ------- | --- | --------- | ------ | ------------------ | -------------- | ------------- |
| Disk    | 168 | 4         | 12 %   | 135 + 19           | **8636** bytes | 704 px        |
| Cloud   | 128 | 12        | 35 %   | 57 + 31            | **3644** bytes | 1632 px       |
| Paper   | —   | —         | —      | —                  | unsupported    | —             |

Derivation, for a grid of `n` modules: `dataModules = n² − 4·8² − 8`;
`storable = ⌊dataModules·3 / 8⌋`; `blocks = ⌊storable / 68⌋`;
`m = ⌈blocks·parity⌉`; `k = blocks − m`; `capacity = k·64 − 4`.

Note the Disk symbol is _smaller_ than the QR it replaces (704 px against
1086 px) while carrying 3.08x the payload.

#### Decoding

1. Threshold the luma at the midpoint of its range and scan rows for the
   `1:1:3:1:1` signature. Confirm each candidate vertically through its centre,
   requiring the horizontal and vertical module pitches to agree within 25 %.
   This is what stops caption and brand text from posing as a finder.
2. Cluster the surviving candidates and take the four extremes of `x ± y` as the
   corners.
3. Map grid coordinates to pixels by **bilinear interpolation** between the four
   finder centres, which sit at module 3 from each edge. Digital images are
   axis-aligned and at most uniformly rescaled, so this absorbs everything they
   do without a homography solve, and it stays trivial to mirror in the Python
   reference decoder.
4. Sample the central 50 % of each module's area and classify to the nearest
   observed calibration colour.
5. Neither `n` nor the orientation is recorded, so try the grid size nearest the
   measured pitch first, at each of the four quarter-turns, and keep whichever
   recovers the most intact blocks. Only the sampling repeats; Reed-Solomon runs
   once, at the end.

---

## 3. Per-image payload = header ‖ shard

Every image contains a **self-describing header** followed by that image's shard
bytes. Because the header is replicated in every image, any single surviving image
describes the whole set; there is no separate manifest image.

### Header (33 bytes, fixed)

| Offset | Size | Field         | Notes                                   |
| -----: | ---: | ------------- | --------------------------------------- |
|      0 |    4 | `MAGIC`       | ASCII `"SSHD"` = `53 53 48 44`          |
|      4 |    1 | `VERSION`     | format version, `1`                     |
|      5 |    8 | `SET_ID`      | random per-vault identifier             |
|     13 |    2 | `SHARD_INDEX` | u16, global shard index `0 … k+m-1`     |
|     15 |    2 | `K`           | u16, number of data shards              |
|     17 |    2 | `M`           | u16, number of parity shards            |
|     19 |    1 | `CODEC_ID`    | `0` qr-grid, `2` color-grid (§2)        |
|     20 |    1 | `PROFILE`     | `0`=disk, `1`=cloud, `2`=paper          |
|     21 |    4 | `SHARD_LEN`   | u32, bytes per shard (all shards equal) |
|     25 |    4 | `BLOB_LEN`    | u32, true length of the vault blob (§6) |
|     29 |    4 | `HASH_GLOBAL` | first 4 bytes of SHA-256(vault blob)    |

The `shard` immediately follows the header and is exactly `SHARD_LEN` bytes.

`HASH_GLOBAL` is an integrity check on the reconstructed blob and helps confirm
set membership; it is **not** a security primitive (authenticity comes from
AES-GCM, §5).

---

## 4. Payload envelope (plaintext, pre-encryption)

```
[ FLAGS 1 ][ NAME_LEN u16 ][ FILENAME (UTF-8, NAME_LEN bytes) ][ CONTENT ]
```

- `FLAGS` bit 0 (`0x01`): `CONTENT` is **gzip-compressed** (RFC 1952).
- `FLAGS` bit 1 (`0x02`): `CONTENT` is a **.zip holding several files** (a
  _bundle_). Composable with bit 0. Other bits reserved, zero.
- `FILENAME`: original file name, UTF-8. Carried **inside** the encrypted envelope,
  so neither the name nor the file type leaks. For a bundle it is `bundle.zip`.
- `CONTENT`: the original file bytes, gzip-compressed only when that is smaller
  (otherwise stored raw and bit 0 is clear).

**Bundles.** A save of one file never sets bit 1: its envelope is byte-identical
to what a pre-bundle writer produced. Several files (or a directory) are zipped
**stored, not deflated**: the envelope gzips the result immediately after, and
compressing twice buys nothing, and bit 1 is set. A reader that unpacks the zip
must reduce each entry to a basename before writing: the archive comes out of a
decrypted vault, but its entry names were chosen by whoever wrote that vault, so
`../` must not escape the output directory.

A decoder written before bit 1 existed masks only bit 0, so it hands back the
`.zip` under the name `bundle.zip` instead of unpacking it. That is degraded, not
wrong, and is why the bit could be added without a version bump.

---

## 5. Content encryption

- **Cipher:** AES-256-GCM (WebCrypto `AES-GCM`).
- **DEK:** a random 256-bit key. Encrypts the §4 envelope. Never stored in the clear.
- **IV:** 12 random bytes, unique per encryption (stored in the vault blob, §6).
- **Tag:** the standard 16-byte GCM tag is appended to the ciphertext (WebCrypto
  includes it in the ciphertext output).

The DEK is protected by the password via the key block (§5.1).

> **Non-normative: optional user entropy.** Every random value in this spec is
> drawn from the platform CSPRNG (`crypto.getRandomValues`). A writer MAY let the
> user supply extra entropy, which is XORed into each draw as
> `getRandomValues() XOR HMAC-SHA256(HKDF(user string, session salt), counter)`.
> The CSPRNG is still consulted for every byte, so the result is uniform whether
> or not the user's string carries any entropy. This is a **generation-side**
> choice only: nothing about it is encoded, no field or length changes, and a
> reader, including the Python reference decoder, cannot tell whether it was
> used and never needs it.

### 5.1 Key block (wrapped DEK)

The DEK is wrapped (encrypted) by a **KEK** derived from the password with
Argon2id. The key block is self-contained and password-protected.

```
[ MAGIC 4 = "SSKY" = 53 53 4B 59 ][ VER 1 = 1 ]
[ iterations u32 ][ memoryKiB u32 ][ parallelism u8 ]      (Argon2id parameters)
[ salt 16 ]
[ wrapIv 12 ][ wrappedLen u16 ][ wrappedDEK (wrappedLen bytes) ]
```

The encoding is **canonical**: a decoder MUST reject a key block with trailing
bytes after `wrappedDEK` (exactly `44 + wrappedLen` bytes total).

- **KDF:** Argon2id, `hashLength = 32` (the KEK is a 256-bit AES-GCM key).
  Parameters are stored in the block so any decoder can reproduce the derivation.
  The extension's production defaults are `iterations = 4`, `memoryKiB = 262144`
  (256 MiB), `parallelism = 1`.
- **Password normalization:** the password MUST be normalized to **Unicode NFC**
  and encoded as **UTF-8** before it is fed to Argon2id. This makes the KEK
  depend on the text, not on how a particular platform or keyboard happened to
  encode it (e.g. precomposed `é` vs. `e` + combining accent), so a vault created
  on one device unlocks on another. Every conforming decoder MUST normalize
  identically.
- **Wrapping:** `wrappedDEK = AES-256-GCM(KEK, rawDEK)` using `wrapIv`. The GCM tag
  is included in `wrappedDEK`, so a wrong password fails to unwrap (authenticated).
- **salt:** 16 random bytes for the KDF.

Recovery requires **the password _and_ this key block**.

### 5.2 Key modes

Where the key block travels is chosen per save:

- **embedded**: the key block is stored in the vault blob (§6), i.e. inside the
  images. The images plus the password are self-sufficient. `KB_LEN > 0`.
- **keyfile**: the key block is _not_ in the images (`KB_LEN = 0`); it is saved
  separately as a **`.key` file** whose contents are exactly the serialized key
  block bytes of §5.1 (magic `"SSKY"`). Restore needs the images, the password,
  and this `.key` file. A leaked image then reveals nothing without the `.key`.
- **stego**: like keyfile, but the key block is hidden in an ordinary-looking
  cover image (§5.3 for a PNG cover, §5.4 for a JPEG cover). At the blob level it
  is identical to keyfile (`KB_LEN = 0`); only the delivery of the key block differs.

A decoder distinguishes the cases by `KB_LEN`: non-zero means the key block is
embedded; zero means it must be supplied externally.

### 5.3 Stego key block (deniable LSB embedding)

The stego mode hides the §5.1 key block in the RGB least-significant bits of a
cover image, keyed by the password so that, without the password, the carrier
is indistinguishable from a photo's natural LSB noise. There is **no header,
magic, or length field in the image**: the payload length is fixed at the
92-byte key block (`KEY_BLOCK_LEN`), and extraction with a wrong password yields
random bytes that fail the §5.1 magic check, reported identically to "no key
here" (the deniability property).

This §5.3 defines the **PNG (spatial-LSB)** carrier. A **JPEG** cover uses the
DCT-coefficient carrier of §5.4 instead; a decoder picks the carrier from the
cover's magic bytes (PNG `89 50` → §5.3, JPEG `FF D8` → §5.4). The keyed
selection and whitening (steps 1–4 below) are shared by both.

Carrier: the cover is treated as **RGBA**, 4 bytes/pixel. Only the R, G, B LSBs
carry data (alpha is never touched); capacity `N = width × height × 3`. A cover
MUST provide `N ≥ 736 × 16` LSBs or it is rejected. The PNG carrier MUST be
stored losslessly; re-encoding it to JPEG, resizing, or re-saving destroys the
key (for a JPEG cover, use §5.4).

Derivation (all decoders MUST reproduce it bit-for-bit):

1. `seed = Argon2id(NFC(password), STEGO_SALT, params)` → 32 bytes, where
   `STEGO_SALT` is the fixed 16 bytes `53 74 65 67 6F 53 68 61 72 64 2D 73 74 65 67 6F`
   (ASCII `"StegoShard-stego"`) and `params` are the caller's Argon2id
   cost parameters (the extension uses the §5.1 production defaults).
   1a. **Cover fingerprint:** `fp = SHA-256(coverInvariant)`, where `coverInvariant`
   is the concatenation, in pixel order, of each RGB channel byte with its LSB
   masked off (`byte & 0xFE`; alpha excluded), i.e. exactly the bits embedding
   never changes. `key = HKDF-SHA256(ikm = seed, salt = fp,
info = "stegoshard/stego/cover", L = 32)`. Because `fp` depends only on
   embedding-invariant bits it is identical at embed and extract, so **nothing is
   stored in the image**: the "no header/magic/length" property is preserved.
   This binds the keystream to the specific cover: the same password over two
   **different** covers never repeats the whitening pad or the carrier layout.

   **Reusing one cover does repeat both, and that is a limit of the design rather
   than an oversight.** The two sentences above are in tension: `fp` is computed
   from embedding-invariant bits precisely so that extraction can recompute it
   with nothing stored, which means embedding cannot change it, which means a
   second embedding into the same cover under the same password derives the same
   key, the same pad and the same positions. Making reuse safe would require a
   per-embedding nonce, and storing one would give the image the header this
   format exists to avoid.

   The consequence is concrete: two different key blocks written into copies of
   one cover under one password XOR to the same value as the two stego images
   themselves, which is a two-time pad. Measured, not inferred, in
   `src/core/stego.binding.test.ts`.

   So the rule is a usage constraint, and it belongs to whatever drives this
   layer: **a cover image's content is used at most once per password.**
   Different passwords over one cover are unaffected, because the seed and
   therefore the key differ.

   That constraint is about the cover's _content_, not about a particular file,
   and the distinction is what makes it awkward to enforce. Two pristine copies
   of one photograph are two different files and one cover, so the danger is not
   visible from either of them. A pre-embedding extraction attempt catches only
   the narrower case of writing over an artifact that already carries a payload
   under that password; both copies return null and both then leak. An earlier
   revision of this section claimed such a check detected reuse exactly, and that
   was wrong.

   Detecting the general case needs state the format does not carry: either the
   caller remembers which cover contents it has already used with a password, for
   example by keeping fingerprints of them, or the layer gains genuine
   per-embedding uniqueness, which means storing a nonce and giving up the
   headerless property. Neither is specified here, so the constraint is stated
   and left to the caller. Nothing in this repository enforces it today.

2. `stream = AES-256-CTR(key, counter = 0¹²⁸)` applied to zero bytes,
   generating as many bytes as needed. The first `KEY_BLOCK_LEN` bytes are the
   **whitening pad**; the remainder feeds position selection.
3. **Whiten:** `whitened = keyBlock XOR pad`.
4. **Positions:** treating the post-pad stream as big-endian `u32` values, pick
   `KEY_BLOCK_LEN × 8 = 736` **distinct** positions in `[0, N)` in stream order,
   rejecting any draw `≥ floor(2³² / N) × N` (removes modulo bias) and any
   duplicate. Bit _i_ of `whitened` (MSB-first within each byte) is written to
   the LSB of RGB channel byte `⌊pos/3⌋ × 4 + (pos mod 3)`.

Extraction reverses steps 4→3 and validates the result against §5.1 (magic
`"SSKY"`, supported version, exact 92-byte length); failure ⇒ treat as absent.

### 5.4 JPEG stego key block (deniable DCT embedding)

When the cover is a **baseline JPEG**, the key block is hidden in its quantized
DCT coefficients so the carrier stays a JPEG of the same size and metadata, a
`.png` in a phone's photo library would itself be an anomaly. Only baseline
sequential Huffman (SOF0), 8-bit, is supported; progressive (SOF2), arithmetic
coding, and other formats (HEIC, WebP) MUST be rejected, never transcoded, which
would change the file's size/appearance and defeat deniability.

The keyed selection, whitening pad, MSB-first bit order, per-cover keystream
binding (step 1a), and §5.1 validation are **identical to §5.3**; only the
carrier and the cover fingerprint differ. For a JPEG the fingerprint is
`fp = SHA-256(concat over eligible carriers, in carrier order, of the signed
coefficient magnitude with bit 0 masked off, encoded big-endian int32)`, again
exactly the content embedding leaves unchanged (`|coef| ≥ 2` is preserved and
only the magnitude LSB is touched), so it is identical at embed and extract and
nothing is stored. Only the carrier differs:

- **Carrier set:** every quantized **AC** coefficient (zig-zag indices 1..63; the
  DC coefficient is never used) whose value satisfies **|coef| ≥ 2**, enumerated
  in a fixed order: component order as in SOF, then interleaved MCU/block order,
  then zig-zag index. Capacity `N` = the number of such coefficients; a cover with
  `N < 736 × 2` is rejected.
- **Embedding:** bit _i_ of `whitened` is written to the **LSB of the magnitude**
  of the selected coefficient, preserving its sign. Because `|coef| ≥ 2` and the
  LSB pair `{2m, 2m+1}` never straddles a Huffman size-category boundary, the flip
  never changes the coefficient's size category or the zero-run structure: the
  re-emitted entropy scan is the same length (± a few byte-stuffing bytes), the
  size-category histogram is unchanged, and the eligible set is invariant (so the
  extractor recomputes exactly the same carriers). Every non-scan segment
  (APPn/EXIF, DQT, DHT, SOF, DRI) is copied verbatim.

Extraction decodes the JPEG to coefficients, rebuilds the same carrier set and
key-derived positions, reads each carrier's magnitude LSB, de-whitens, and
validates against §5.1; any failure (wrong password, no key, non-baseline JPEG)
⇒ treat as absent.

---

## 6. Vault blob

The blob is what gets erasure-coded and split across images. It bundles everything
needed (besides the password) to decrypt:

```
[ KB_LEN u16 ][ key block (KB_LEN bytes, §5.1) ][ contentSalt 16 ][ IV 12 ][ ciphertext (§5) ]
```

`KB_LEN` is `0` for the keyfile/stego modes (§5.2); the key block is then
supplied externally at restore time.

The `ciphertext` is not encrypted under the DEK directly but under a **per-export
content key** `CEK = HKDF-SHA256(DEK, salt = contentSalt, info =
"stegoshard/vault/content")`, where `contentSalt` is 16 fresh random bytes stored
above. The DEK is reused across vaults (one lives in the keystore); deriving a
fresh CEK per export keeps the AES-GCM random-IV collision bound (§5) per-export
instead of accumulating across every export under the shared DEK. Every conforming
decoder MUST derive the CEK identically.

`BLOB_LEN` in each header (§3) records the blob's true length so padding added
during sharding (§7) can be stripped after reconstruction. `HASH_GLOBAL` is
SHA-256 of these exact bytes, truncated to 4 bytes.

---

## 7. Erasure coding (Reed-Solomon over GF(2^8))

Cross-image redundancy so the vault survives lost or corrupt images.

### 7.1 Field

- GF(2^8) with reducing polynomial **`0x11D`** (`x^8 + x^4 + x^3 + x^2 + 1`).
- Primitive element (generator) **`0x02`**.
- Addition/subtraction = XOR. Multiplication/division via exp/log tables.

### 7.2 Parameters

- `dataPerShard` = `capacity(profile) − HEADER_LEN` (see §2), i.e. the shard bytes
  that fit one image once the 33-byte header is accounted for.
- `k` = number of data shards = `max(1, ceil(blobLen / dataPerShard))`.
- `m` = number of parity shards = `max(ceil(k * 0.3), 2)`, a +30% parity ratio
  with an absolute floor of **2** (`MIN_PARITY`), so even a one-shard vault keeps
  two spares. Tolerates the loss/corruption of up to `m` images.
- Absolute ceiling: `k + m ≤ 256` (field size) and, as a product guard,
  `k + m ≤ 150` images (`MAX_IMAGES`).

### 7.3 Sharding

- `shardLen = max(1, ceil(blobLen / k))`. The blob is zero-padded to `k · shardLen`
  and split into `k` contiguous data shards.

### 7.4 Encoding matrix

The systematic generator matrix is `G = [ I_k ; C ]` (size `(k+m) × k`):

- Rows `0 … k-1`: the `k × k` identity, so output shards `0 … k-1` are the data
  shards unchanged.
- Rows `k … k+m-1`: an `m × k` **Cauchy matrix** `C` with
  `C[i][j] = 1 / (x_i ⊕ y_j)` in GF(2^8), where `x_i = i` (`0 … m-1`) and
  `y_j = m + j` (`m … m+k-1`). The two sets are disjoint, so every entry is
  defined and every square submatrix of `G` is invertible (MDS property).

Parity shard `i` = `Σ_j C[i][j] · dataShard[j]` (GF operations, per byte position).

Output shard order (global index) is: data shards `0 … k-1`, then parity shards
`k … k+m-1`. This matches `SHARD_INDEX` in the header.

### 7.5 Reconstruction

Given any `k` surviving shards with their global indices:

1. Form the `k × k` submatrix of `G` for those indices.
2. Invert it over GF(2^8) (Gauss-Jordan).
3. Multiply by the received shard vector to recover the `k` data shards.
4. Concatenate the data shards and truncate to `BLOB_LEN` → the vault blob.

If fewer than `k` shards survive, reconstruction is impossible.

---

## 8. Binary (non-image) output

Instead of erasure-coding the vault blob (§6) into QR images, an implementation
MAY write a **segmented vault blob** (§8.1) to a single **container file**. This
trades the images' loss tolerance and camera-restore for a compact artifact and a
much larger size budget (no per-image ceiling). Unlike the image path, which
encrypts the envelope in one AES-GCM call (§6), the binary path splits it into
chunks so encryption/decryption report byte-level progress and run off the UI
thread; the container is pure packaging around the already-authenticated bytes,
so it adds no secrecy.

> The **disguised** (`.db`) variant is a supported access-structure path: it carries
> the mandatory multi-region segmented blob of §10.7, not the single-region blob of
> §8.1. The **branded** (`.ssbn`) variant is excluded and keeps §8.1 unchanged.

### 8.1 Segmented vault blob

The binary path replaces the §6 single-shot vault blob with a **self-describing,
chunked** blob. The compressed envelope (§4) is split into fixed-size chunks, each
sealed with AES-256-GCM under a STREAM nonce discipline (Hoang–Reyhanitabar–
Rogaway–Vizár, the construction `age` uses).

```
[ MAGIC "SSCS" = 53 53 43 53 ][ VERSION u8 = 1 ][ FLAGS u8 (bit0 = key block embedded) ]
[ KB_LEN u16 ][ key block (KB_LEN bytes, §5.1; empty for external keys) ]
[ contentSalt 16 ][ noncePrefix 7 ][ chunkSize u32 ][ plaintextLen u64 ]
[ chunk_0 ] … [ chunk_{n-1} ]        chunk_i = ciphertext_i || tag_i(16)
```

- **CEK** = `HKDF-SHA256(DEK, salt = contentSalt, info = "stegoshard/vault/content")`,
  identical to §6.
- **Chunks**: `n = ceil(plaintextLen / chunkSize)` (at least one, so an empty
  payload yields one empty final chunk). `chunkSize` is implementation-chosen
  within `[4096, 16·2²⁰]`; the reference encoder uses 1 MiB.
- **Nonce_i** (12 bytes) = `noncePrefix (7, random per export) || u32_be(i) ||
finalByte`, where `finalByte = 1` only for the last chunk, else `0`.
- **AAD** for every chunk = the entire header prefix above (magic … plaintextLen,
  key block included), binding all chunks to the version, salt, nonce prefix,
  chunk size, length, and key.
- **Decrypt**: verify `containerLen − headerLen == (n−1)·(chunkSize+16) +
(lastSegLen+16)` (rejects truncation / trailing bytes), then open each chunk in
  order; a bad tag, a dropped final chunk (finalByte mismatch), or reordering all
  fail authentication. Each chunk is authenticated before its plaintext is kept.

Two container variants wrap this blob:

```
branded    [ MAGIC "SSBN" = 53 53 42 4E ][ VERSION u8 = 1 ][ segmented vault blob (§8.1) ]
disguised  a complete SQLite 3 database whose `cache` table holds the segmented vault blob
```

- **Branded** (`.ssbn`) is self-labelling: easy for the owner to recognize; it
  makes no attempt to hide.
- **Disguised** (`.db`) is a **complete, structurally valid SQLite 3 database**
  (4096-byte pages) with a `cache(k TEXT, v BLOB)` table. The vault blob is split
  into ~64 KiB chunks stored as rows keyed `page_cache_NNNN` (chunk order),
  reassembled by concatenation; a couple of small decoy rows precede them. Rows
  live under an **interior b-tree root** (page 2), one row per leaf page, each
  spilling into its own **overflow-page chain** (capped at 256 vault rows so the
  root fits one page). The header's page-count (offset 28) equals the real page
  count and the change counter (24) equals version-valid-for (92). Crucially there
  are **no trailing bytes past the database's logical end**: `file size ==
page_count × page_size`. So `sqlite3 cache.db "SELECT * FROM cache"` opens
  cleanly, `PRAGMA integrity_check` returns `ok`, and structural triage (size vs.
  page count, header scan) finds nothing amiss. The remaining tell is that the row
  values are high-entropy, a content-level observation, not a structural one;
  spreading across ordinary-sized rows softens but does not remove it (see
  `docs/CRYPTO-REVIEW.md` §6b). The database is generated deterministically and is
  byte-identical across implementations; the reader walks the b-tree, reassembles
  each `page_cache_*` row, and concatenates them in order.

The **external key** (keyfile mode, `KB_LEN = 0`) MAY be delivered the same way:
the 92-byte key block (§5.1) wrapped in a branded or disguised container. Stego
key delivery (§5.3/§5.4) is unchanged; the key stays a cover image.

**Restore.** Detect the variant by its leading signature (the branded magic, or
the SQLite header). Branded strips its 5-byte prefix; disguised parses the
database and concatenates the `page_cache_*` rows. Bytes matching neither variant
(or a SQLite file that is not one of ours) are treated as a bare blob, letting
AES-GCM be the final arbiter. Then decrypt the segmented blob as §8.1 (unlocking
the key block as §5). The gzip guard (§4) uses the binary size cap (below), which
also bounds decompression on this path.

Canonical filenames used by the reference implementations: branded
`stegoshard-vault.ssbn` / `stegoshard-key.ssbn`; disguised `cache.db` /
`settings.db`.

---

## 9. Gallery Mode (deniable multi-image distribution)

Instead of visible QR images (§7) or one binary file (§8), Gallery Mode hides a
secret **fragmented across many ordinary photos**, so the set tolerates partial
loss and each photo stays deniable. It combines the vault blob (§6), Reed-Solomon
erasure coding (§7), DCT/LSB stego (§5.3/§5.4), and decoy ("chaffing") images
decoded blindly by trial-authentication ("winnowing").

> Gallery Mode is an access-structure path: the blob each fragment carries is the
> multi-region blob of §10.6 (not the §6 single-region blob), so every gallery vault
> holds the mandatory 4-slot / 2-region geometry. The winnowing/AEAD layer described
> here is unchanged and still password-keyed.

### 9.1 Keys

`seed = Argon2id(NFC(password), GALLERY_SALT, DEFAULT_ARGON2, 32 bytes)` where
`GALLERY_SALT` is the 16 ASCII bytes `"StegoShard-gllry"` (`53 74 65 67 6f 53 68
61 72 64 2d 67 6c 6c 72 79`), distinct from the §5 stego salt. HKDF-SHA256 (RFC
5869, empty salt) splits the seed into two 32-byte subkeys by `info` label:

- `posKey` ← `info = "stegoshard/gallery/pos"`, drives carrier selection.
- `aeadKey` ← `info = "stegoshard/gallery/aead"`, seals fragments (AES-256-GCM).

The gallery Argon2 cost is the format-defined v2-candidate `DEFAULT_ARGON2` and is **not stored**
anywhere (like the §5.3 stego salt). Because `aeadKey` is password-only,
extraction is image-independent, so a decoder can trial-open every photo blindly.

### 9.2 Fragment and slot layout (all lengths fixed)

```
SLOT_DATA = 2048                                  shard-data bytes per image
FRAG_LEN  = 33 + SLOT_DATA = 2081                 inner AEAD plaintext
SLOT_BYTES = 12 + FRAG_LEN + 16 = 2109            embedded per image

Inner plaintext P (FRAG_LEN bytes):
  [ header 33 (§3, CODEC_ID = 1 = gallery) ][ shard (SHARD_LEN) ][ zero pad ]

Embedded slot (SLOT_BYTES, identical for data / parity / decoy):
  [ NONCE 12 (random per fragment) ][ AES-256-GCM(aeadKey, NONCE, P) ]   (= FRAG_LEN + 16 tag)
```

The nonce is a fresh random 12 bytes carried in the slot, never derived from the
shard index, so two galleries under the same password never reuse a `(key,
nonce)` pair. A decoy image embeds `SLOT_BYTES` of CSPRNG bytes at the same
`posKey`-selected carriers; without the password it is indistinguishable from a
sealed fragment (both are uniform).

### 9.3 Carrier selection

Identical to §5.3/§5.4: an AES-CTR keystream seeded by `posKey` drives
rejection-sampled distinct carrier positions (RGB LSBs for a PNG cover; eligible
AC coefficients with `|coef| ≥ 2` for a baseline JPEG, keeping size invariance),
MSB-first bit order, **except** that there is no whitening pad (the sealed slot is
already uniform) and the length is `SLOT_BYTES·8` bits, not the fixed key-block
length. Unlike §5.3/§5.4 the keystream is **not** bound to a per-cover fingerprint:
positions may repeat across same-size covers, but this leaks nothing here because
each slot is an independent AES-GCM message (fresh random nonce, §9.2) with no
whitening, so there is no two-time-pad to exploit. A cover must have
`≥ SLOT_BYTES·8·4` eligible carriers (a ×4 margin keeps embedding sparse) or it is
rejected.

### 9.4 Encode

1. Build the standard vault blob (§6). By default this is **embedded key mode**
   (`KB_LEN = 92`), from the gzip-compressed envelope (§4) encrypted under a fresh
   DEK. A gallery may instead use **keyfile** or **stego** key mode (`KB_LEN = 0`),
   in which case the key block is not carried in the fragments but delivered
   separately: a loose `.key` file, or hidden in an ordinary cover photo (§5).
   This shrinks the blob by 92 bytes; the `blobLen ≤ 389120` bound (step 2) is
   unchanged. Deniability note: a separate key artifact is itself a tell, so this
   is opt-in.
2. `k = ceil(blobLen / SLOT_DATA)`, `m = max(ceil(k·0.3), 2)` (§7.2). Require
   `blobLen ≤ 389120` (`SLOT_DATA·190`) so `k + m + 2 ≤ 256` (GF limit, §7.1).
3. RS-encode into `k + m` shards (§7). For each shard `i`, build `P` (§9.2), seal
   it, and embed the slot into a distinct cover photo.
4. The remaining covers (≥ 2) become decoys. Total covers ≥ 5, ≤ 256.

### 9.5 Decode (blind winnowing)

For **every** photo: extract `SLOT_BYTES` at `posKey` carriers, split
`NONCE ‖ ciphertext`, and AES-GCM-open with `aeadKey`. A failed tag (decoy,
recompressed/destroyed carrier, foreign image, or wrong password) is dropped
silently. Surviving fragments are grouped by `SET_ID` (§3); once a group has
`≥ K` distinct valid shard indices, reconstruct (§7.5), verify `HASH_GLOBAL`,
and decrypt the blob (§6). For a keyfile/stego gallery (§9.4, `KB_LEN = 0`) the
decoder is additionally given the external key block. Wrong password ⇒ zero
survivors ⇒ indistinguishable from "no gallery here".

### 9.6 Deniability & limits

The `|coef| ≥ 2` magnitude-LSB invariant keeps a JPEG carrier the same size (byte-
faithful for `restartInterval = 0`; ≤ 0.5% drift from byte-stuffing otherwise) and
its Huffman size-category histogram unchanged. Honest limit: Gallery Mode modifies
**every** selected photo, so an adversary holding the untouched originals can diff
them, amplified vs. single-image stego (see `docs/CRYPTO-REVIEW.md`).

---

## 10. Access structures (multi-region geometry, gallery + `.db`)

This section generalises the single-payload container into a **fixed array of key
slots over a fixed array of payload regions**, the mandatory geometry of two output
paths: **Gallery Mode (§9)** and the **disguised `.db`** binary variant (§8). It is
the substrate for the duress and non-possession product modes; this section defines
only the geometry those modes share.

**Folded into `FORMAT_VERSION = 1`, not a new version.** The geometry is intrinsic to
these two paths: every gallery and every disguised `.db` vault carries it, so no field
distinguishes a plain vault from one with a hidden alternative, and there is no version
byte to leak the feature. The **excluded** paths (single cover image §5, PDF/paper,
QR-grid §2, branded `.ssbn` §8) keep the single-slot / single-region geometry of §5.1
and §6 unchanged, byte-for-byte.

### 10.1 Key slot array

```
SLOT_COUNT   = 4          # constant for all multi-region containers
SLOT_SIZE    = 76 bytes   # nonce[12] || AES-256-GCM(plaintext 48) = ct[48] || tag[16]
SLOT_ARRAY   = 304 bytes  # SLOT_COUNT × SLOT_SIZE, magicless

slot_plaintext (48) := dek[32] || region_index[1] || reserved[15]
                       reserved MUST be zero on write, ignored on read
```

- Each live slot AES-GCM-wraps an **independent per-region DEK** and the index of the
  region it unlocks. `region_index` is authenticated by the GCM tag, so a slot cannot be
  redirected to another region by editing the container. **Per-region DEKs are
  independent**: a shared DEK would let a slot opener derive every region's content key.
- **All `SLOT_COUNT` slots are always written.** Slots with no live DEK are filled from
  the CSPRNG (AES-GCM output is pseudorandom, so a random 76-byte block is
  indistinguishable from a live slot). Slot order is randomised by an unbiased CSPRNG
  permutation; slot position carries no meaning.
- The array is magicless: geometry is known from the decode entrypoint (a gallery decode,
  or the recovered `disguised` binary variant), never read from a byte.

### 10.2 Slot KEK derivation

```
kek       := Argon2id(password, vault_salt, DEFAULT_ARGON2) → 32 bytes   # runs ONCE
             (+ optional keyfile/stego factor, §10.3)
CEK_r     := HKDF-SHA256(ikm = dek_r, salt = region_contentSalt_r,
                         info = "stegoshard/vault/region" || region_index, len 32)
```

`vault_salt` is a fresh 16-byte per-vault CSPRNG value, shared across all slots (its job
is to defeat cross-vault precomputation; distinct passwords yield distinct KEKs
regardless). Unlike the §5.1 key block, the slot KEK's **Argon2 parameters are the format-defined
`DEFAULT_ARGON2` and are NOT stored** in the container; the geometry carries no cost
field (as with the gallery/stego keys, §5.3, §9.1).

### 10.3 Keyfile / stego as a key factor

On these paths the `keyfile` and `stego` key modes do **not** externalise the slot array
(that would shorten the container and become a distinguisher). Instead a random 32-byte
**key factor** is generated, delivered externally (a `.key` file, or hidden in a cover),
and mixed into the slot KEK:

```
kek := HKDF-SHA256(ikm = argon2_kek || key_factor, salt = vault_salt,
                   info = "stegoshard/v1/keyfile-kek", len 32)
```

`embedded` mode uses no factor. Because the slot array is always present regardless of
key mode, container length does not vary by key mode.

**Delivery.** `keyfile` writes the factor as the raw 32 bytes (a `.key` file, or a binary
key container). `stego` hides it in a cover photo using the same fixed, self-validating
LSB/DCT path as the 92-byte key block (§5.3/§5.4), but wrapped in a **key-factor envelope**
so a wrong-password extraction is indistinguishable from a cover that carries nothing:

```
SSKF envelope = "SSKF" (4) || version 1 (1) || key_factor (32)   # 37 bytes, whitened
```

The envelope is whitened (XORed with the keystream pad) before embedding, so its magic never
appears in the carrier LSBs; on extraction, a wrong password de-whitens to noise that fails
the magic check → reported as "no factor here". The raw `.key` file stays the bare 32 bytes
(on disk a magic would itself be a distinguisher; under stego the whole envelope is whitened).

**Composition with the access modes.** The key factor is mixed into the base slot KEK
(`slot_kek_raw`) and therefore composes with every mode as an **independent extra layer**:

- **Plain** (§10.6): the one live slot needs `password + factor`.
- **Non-possession** (§10.8): the base KEK is `slot_kek_raw(password, factor)`, then gated on
  the Shamir secret, so the real region needs `password + factor + a share quorum`. All three
  are independent (a cracker who obtains any two learns nothing about the third).
- **Duress** (§10.9): the factor gates the **real slot only**; the decoy slot takes **no**
  factor. A decoy exists to be surrendered under coercion, so it MUST open on the duress
  password alone; requiring an extra artifact to reveal the decoy would defeat its purpose.

Because restore presents whatever `.key`/cover sits beside the vault for **either** credential
(it cannot know which region a credential opens), the decoder's `slot_kek_candidates` offers
BOTH the password-only KEK and, when a factor is supplied, the factor-mixed KEK (both from the
single Argon2id output, plus their gated variants when a secret is supplied). This keeps a
no-factor decoy slot openable even when the factor is presented, while the real slot still
requires it. Credential independence (§10.9) guarantees the real and decoy KEKs never both match,
so the exactly-one-match rule (§10.4) holds. Every derivation with a null factor is byte-identical
to the password-only KEK, so `embedded` output, and every committed vector, is unchanged.

### 10.4 Constant-work unlock

Argon2id runs once per candidate KEK, never per slot. Every candidate KEK is then
attempted against **every** slot with no early exit, so wall-clock time is a function of
the number of candidate KEKs only, never of which slot matched or whether any did. A
well-formed container yields exactly one match; zero (wrong credential) and more than one
(malformed, fail closed) both surface as one uniform `WrongPasswordError`. Implementations
MUST NOT log, surface, or return which slot index or region matched.

### 10.5 Payload regions and buckets

```
REGION_COUNT = 2          # constant

region_plaintext (bucket bytes) := REGION_LEN[u32] || envelope (§4) || zero-pad → bucket
bucket := smallest ladder entry ≥ max(REGION_LEN_FIELD + len(region_0),
                                      REGION_LEN_FIELD + len(region_1))

Gallery ladder: 4 KiB · 16 KiB · 64 KiB
`.db` ladder:   64 KiB · 256 KiB · 1 MiB · 4 MiB · 16 MiB · 64 MiB
```

Each region is compressed (§4) first; a single shared bucket ≥ the larger compressed
region is chosen, then **both** regions are padded to it, so ciphertext length reveals only
the bucket and neither region's compression ratio is recoverable. The true length lives in
the region's encrypted `REGION_LEN`, never in a container header. A region with no live
payload is filled with CSPRNG bytes to the exact same length. Reed-Solomon (§7), where
used (gallery), encodes the whole container as one stream; regions are never sharded
independently.

The ladders are capped to real capacity: gallery to 64 KiB/region (the doubled blob must
fit `GALLERY_MAX_BLOB`); `.db` to 64 MiB/region (the SQLite writer allocates the database
in one buffer). Both are fixed for this format version candidate.

### 10.6 Multi-region vault blob (gallery, single-shot GCM)

```
[ vault_salt 16 ][ slot_array 304 ][ region0 R ][ region1 R ]        R = 44 + bucket
region block (R) := contentSalt[16] || IV[12] || AES-256-GCM_CEK(region_plaintext)
                    (ciphertext = bucket + 16-byte tag)
```

A dead region is exactly `R` CSPRNG bytes. Both blocks are the same length `R`, so which
region is real is invisible. This blob replaces the §6 vault blob inside each gallery
fragment.

### 10.7 Multi-region segmented blob (`.db`, chunked STREAM)

```
[ "SSCS" 4 ][ SEG_VERSION 1 ][ FLAGS 1 ][ vault_salt 16 ][ slot_array 304 ]
[ chunkSize u32 ][ bucketLen u64 ]                       # SHARED — one per container
[ region0_stream S ][ region1_stream S ]

region_stream (S) := contentSalt[16] || noncePrefix[7] || chunk_0 … chunk_{n-1}
                     n = ceil(bucketLen / chunkSize);  chunk_i = ct_i || tag_i(16)
```

`chunkSize` and `bucketLen` are container-level (shared by both regions) **on purpose**:
if they lived per region, a dead region's random bytes at those offsets would almost never
equal a valid value and would leak which region is real. With them hoisted, a region stream
is all pseudorandom (salt, prefix, GCM chunks), so a dead region is `S` CSPRNG bytes,
indistinguishable. Chunk nonce = `noncePrefix || u32_be(chunkIndex) || finalByte`; AAD binds
each chunk to the container head, its `region_index`, and its `contentSalt || noncePrefix`.
This blob is what the disguised `.db` container (§8) carries.

### 10.8 Mode B: Non-possession (threshold gating)

A product mode over the geometry above: **one live slot whose KEK is gated on threshold
material the holder does not possess, one real region, and no decoy** (the second region
is CSPRNG to the same bucket). Below the threshold, the holder does not possess the
cryptographic material required to derive the real region's key. The container is
byte-indistinguishable from a plain vault of the same bucket.

**Gated slot KEK (§10.6.2 of the design):**

```
slot_kek := HKDF-SHA256(ikm  = base_kek || S,
                        salt = vault_salt,
                        info = "stegoshard/v1/slot-kek", len 32)
```

`base_kek` is the ordinary slot KEK (§10.2, incl. any keyfile factor); `S` is a 32-byte
CSPRNG secret. HKDF (not XOR) gives domain separation and no algebraic relation to the
ungated KEK. At unlock the reader derives Argon2id **once** and tries `[ base_kek,
gate(base_kek, S) ]` across all slots, so timing depends only on whether threshold
material was supplied, never on the container.

**Shamir secret sharing (GF(2^8), §10.6.1):** `S` is split `k`-of-`n` over the same field
as Reed-Solomon (§7.1). Any `k` shares recover `S`; any `k-1` yield **zero** information
(not a partial key), so the container cannot "notice" a sub-threshold set and degrade;
`shamir_recover` has no notion of `k`. Share wire format (38 bytes):

```
share := version[1] || share_index[1] || share_value[32] || checksum[4]
         checksum = SHA-256(version || index || value)[0..4]
```

`share_index` ∈ 1..255, distinct per share. The checksum detects transcription errors
only; it does **not** authenticate a share against any container and MUST NOT be usable to
test a candidate share. The writer retains neither `S` nor any share, and nothing about
`k`, `n`, or a fingerprint enters the container.

### 10.9 Mode A: Duress

A product mode over the same geometry: **two live slots and two real regions**. One
credential (real) opens one region; a second, independent credential (duress) opens the
other, which holds a plausible decoy. Region indices are assigned by CSPRNG, so the decoy
is as likely to be region 0 as region 1. Because each region has an **independent DEK**
carried in its own slot (§10 governing decision), the duress credential yields **only** the
decoy; the real region's key is never derivable from it.

- **Independent credentials (author-time, normative).** The writer MUST reject a duress
  password that is equal to, a case-variant of, a prefix/suffix of, the reversal of, or a
  near-edit (small Levenshtein distance) of the real password, since a cracker who recovers one
  MUST NOT cheaply recover the other. This check runs only at authoring and its result is
  never stored or encoded (a stored relation would itself be a distinguisher, §10.2).
- **Silence on unlock.** A duress unlock and a real unlock take the identical code path and
  return the same shape (`filename`, `content`) with no "duress mode" indicator; anything
  else is observable over the user's shoulder.
- **Mutual exclusivity.** A conforming UI MUST present Mode A and Mode B as a choice, not
  both at once: Mode A works only under silence ("this is all there is"), Mode B only under
  disclosure ("there is more, and here is why I can't reach it"); a decoy poisons a
  non-possession defence.
- **Path applicability (normative).** Mode A is available on the **`.db` path only**. It is
  **excluded from Gallery Mode**: an author request for duress on a gallery MUST be refused
  with no bytes written. Mode B (§10.8) is available on both `.db` and gallery. Plain (§10.6)
  is available on both.

#### 10.9.1 Why Mode A is excluded from Gallery Mode (resolved)

This resolves the draft's open question on gallery duress. Gallery Mode has **two
independently-keyed layers**: an outer _winnowing_ layer (§9.1, `posKey`/`aeadKey` from
`Argon2id(password, GALLERY_SALT)`, which locates and authenticates fragments across photos)
and the inner access-structure blob (§10.6, the 4-slot / 2-region geometry those fragments
carry). Duress requires **two independent credentials**, but the winnowing key is a pure
function of _one_ password: only that password's `posKey`/`aeadKey` can be baked into the
carriers. A second, independent duress password derives a different keystream, reads different
carrier positions, and fails every fragment's AEAD tag; it cannot even _find_ the fragments,
let alone reach a second region. (Mode B escapes this because its second factor is threshold
_share_ material, not a second password; a single credential still winnows; see §10.8.)

The only way to let both credentials winnow the _same_ fragments is a **credential-independent
winnowing key**: a shared secret wrapped under both passwords at a fixed, credential-
independent carrier location. That necessarily converts gallery's presence-hiding from _"no
StegoShard structure is locatable without the password"_ (§9.5) to _"a fixed-position wrapped-
key header exists in these photos,"_ measurably weakening the **one property the photo carrier
uniquely provides**. Because duress is already available on the `.db` path, which has no
winnowing layer, so both credentials reach the shared slot array directly (§10.9), the
resolution is to **keep gallery presence-hiding intact and host duress on `.db`**, rather than
trade gallery's core guarantee for a mode that already has a stronger home.

---

## 11. Constants summary

| Name                  | Value                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `FORMAT_VERSION`      | 1                                                                                                    |
| Header magic          | `"SSHD"`                                                                                             |
| Key block magic       | `"SSKY"`                                                                                             |
| Binary magic          | `"SSBN"` (branded); SQLite DB, blob in `cache` table (disguised) (§8)                                |
| Header length         | 33 bytes                                                                                             |
| Codec IDs             | `0` qr-grid (§2.1); `1` gallery (§9); `2` color-grid (§2.2)                                          |
| Cipher                | AES-256-GCM, 12-byte IV, 16-byte tag                                                                 |
| KDF                   | Argon2id, 32-byte output, salt 16 bytes                                                              |
| KDF defaults          | iterations 4, memory 256 MiB, parallelism 1                                                          |
| GF polynomial         | `0x11D`, generator `0x02`                                                                            |
| Parity                | `m = max(ceil(k·0.3), 2)`                                                                            |
| Data per shard        | `capacity(profile) − 33`; qr-grid Disk 2767, Cloud 1567, Paper 767; color-grid Disk 8603, Cloud 3611 |
| Color grid (§2.2)     | 8 colours = 3 bits/module; finder 7x7 in an 8x8 box; block 64 B ‖ CRC-32; Disk n=168, Cloud n=128    |
| Gallery salt          | `"StegoShard-gllry"` (16 bytes) (§9.1)                                                               |
| Gallery slot          | `SLOT_DATA` 2048, `FRAG_LEN` 2081, `SLOT_BYTES` 2109 (§9.2)                                          |
| Limits                | file ≤ 1 MiB (images/PDF) or ≤ 1 GiB CLI / 256 MiB browser (binary); images ≤ 150                    |
| Gallery limits        | blob ≤ 389120 bytes; photos 5–256; decoys ≥ 2 (§9)                                                   |
| Compression           | gzip (RFC 1952), opportunistic                                                                       |
| Access structure      | `SLOT_COUNT` 4, `SLOT_SIZE` 76, `SLOT_ARRAY` 304; `REGION_COUNT` 2 (§10)                             |
| Vault salt            | 16 bytes, per-vault (§10.2)                                                                          |
| Region key label      | `"stegoshard/vault/region"` ‖ region_index (§10.2)                                                   |
| Keyfile factor        | 32 bytes; HKDF label `"stegoshard/v1/keyfile-kek"` (§10.3)                                           |
| Stego factor envelope | `"SSKF"` ‖ version 1 ‖ factor 32 = 37 bytes, whitened (§10.3)                                        |
| Gallery ladder        | 4 KiB · 16 KiB · 64 KiB (§10.5)                                                                      |
| `.db` ladder          | 64 KiB · 256 KiB · 1 MiB · 4 MiB · 16 MiB · 64 MiB (§10.5)                                           |
| Gate label (Mode B)   | `"stegoshard/v1/slot-kek"` (§10.8)                                                                   |
| Share (Mode B)        | 38 B: version 1 ‖ index 1 ‖ value 32 ‖ checksum 4; Shamir k-of-n GF(2^8) (§10.8)                     |

---

## 12. Reference implementation

The TypeScript core in `src/core/` is the reference encoder/decoder:

| Concern                        | Module                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| GF(2^8) arithmetic             | `gf256.ts`                                                                                                    |
| Reed-Solomon                   | `reed-solomon.ts`, `erasure.ts`                                                                               |
| Crypto / key block             | `crypto.ts`                                                                                                   |
| Compression                    | `compress.ts`                                                                                                 |
| Payload envelope               | `payload.ts`                                                                                                  |
| Image header                   | `header.ts`                                                                                                   |
| Vault blob & flow              | `vault.ts`                                                                                                    |
| qr-grid codec (§2.1)           | `codec/qr-grid.ts`                                                                                            |
| color-grid codec (§2.2)        | `codec/color-grid.ts`, `crc32.ts`; codec sniffing in `codec/index.ts`                                         |
| Image branding                 | `brand.ts` (mark + 5x7 ASCII font, shared by the browser and the CLI)                                         |
| Variable-len stego             | `stego.ts`                                                                                                    |
| Gallery Mode (§9)              | `gallery.ts`                                                                                                  |
| Access structures (§10)        | `crypto.ts` (slots + gated KEK), `buckets.ts`, `regions.ts`, `vault.ts` + `segmented.ts` (multi-region blobs) |
| Mode B, non-possession (§10.8) | `shamir.ts` (k-of-n over `gf256.ts`), `access.ts` (writer)                                                    |
| Mode A, duress (§10.9)         | `access.ts` (`buildDuress*`, `credentialsIndependent`)                                                        |

A standalone **Python reference decoder** in `python/stegoshard/` implements this
same specification independently (GF(2^8) + Reed-Solomon, header, key block,
Argon2id + AES-GCM, gzip, QR and color-grid decode, deniable stego + Gallery Mode §9, and the §10
access structures: 4-slot / 2-region parse, gated + factor-mixed slot KEKs,
per-region DEKs, and the duress + non-possession modes). It restores a vault without
the extension
and runs in CI as a cross-implementation conformance test: the extension encodes
and renders fixtures, the Python decoder reads them back, and the two must agree.
See `python/README.md`.

> The §10 multi-region geometry is mirrored in the Python decoder: the 4-slot /
> 2-region parse (`format.py` `split_multiregion_vault_blob` / `parse_region_plaintext`,
> `crypto.py` `try_open_slot` / `open_slot_array` / `slot_kek_candidates`, `pipeline.py`
> `decode_multiregion_vault_blob`, `segmented.py` `decode_multiregion_segmented_blob`),
> with committed cross-implementation vectors and gallery/`.db` conformance fixtures (incl.
> the duress and non-possession modes and the keyfile/stego key factor). §10 is therefore
> a normative cross-implementation contract, verified in CI like the rest of the format.
