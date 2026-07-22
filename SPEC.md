# StegoShard format specification — v1

This document is the **stable, versioned interface** for the StegoShard on-image
format. It describes everything needed to decode a vault **without the extension**,
so the data survives even if the extension disappears. Any conforming
implementation (including the Python reference decoder, Phase 3) must interoperate
with images produced by format version 1.

> **Status:** frozen for format version 1 (`FORMAT_VERSION = 1`). Breaking changes
> require a new version number in the image header.

All multi-byte integers are **big-endian**. All lengths are in bytes.

---

## 1. Pipeline overview

**Export** (file → images):

```
file bytes
  → payload envelope         (§4)   [FLAGS][NAME_LEN][FILENAME][CONTENT], content gzip-optional
  → AES-GCM encrypt (DEK)    (§5)   → ciphertext
  → vault blob               (§6)   [KB_LEN][key block][IV][ciphertext]
  → Reed-Solomon erasure     (§7)   k data + m parity shards, equal length
  → per-image payload        (§3)   header ‖ shard
  → codec render             (§2)   one QR symbol per image
```

**Import** reverses each step. Reconstruction succeeds if **any k of the k+m**
shards survive (§7).

---

## 2. Image codec — `qr-grid` (`CODEC_ID = 0`)

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
  byte content — important for binary payloads.)

Profiles: `DISK = 0`, `CLOUD = 1`, `PAPER = 2`. (Cloud and Paper profiles are
defined here but exercised in later phases.)

---

## 3. Per-image payload = header ‖ shard

Every image contains a **self-describing header** followed by that image's shard
bytes. Because the header is replicated in every image, any single surviving image
describes the whole set — there is no separate manifest image.

### Header (33 bytes, fixed)

| Offset | Size | Field         | Notes                                   |
| -----: | ---: | ------------- | --------------------------------------- |
|      0 |    4 | `MAGIC`       | ASCII `"SSHD"` = `53 53 48 44`          |
|      4 |    1 | `VERSION`     | format version, `1`                     |
|      5 |    8 | `SET_ID`      | random per-vault identifier             |
|     13 |    2 | `SHARD_INDEX` | u16, global shard index `0 … k+m-1`     |
|     15 |    2 | `K`           | u16, number of data shards              |
|     17 |    2 | `M`           | u16, number of parity shards            |
|     19 |    1 | `CODEC_ID`    | `0` = qr-grid                           |
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

- `FLAGS` bit 0 (`0x01`): `CONTENT` is **gzip-compressed** (RFC 1952). Other bits
  reserved, zero.
- `FILENAME`: original file name, UTF-8. Carried **inside** the encrypted envelope,
  so neither the name nor the file type leaks.
- `CONTENT`: the original file bytes, gzip-compressed only when that is smaller
  (otherwise stored raw and bit 0 is clear).

---

## 5. Content encryption

- **Cipher:** AES-256-GCM (WebCrypto `AES-GCM`).
- **DEK:** a random 256-bit key. Encrypts the §4 envelope. Never stored in the clear.
- **IV:** 12 random bytes, unique per encryption (stored in the vault blob, §6).
- **Tag:** the standard 16-byte GCM tag is appended to the ciphertext (WebCrypto
  includes it in the ciphertext output).

The DEK is protected by the password via the key block (§5.1).

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

- **embedded** — the key block is stored in the vault blob (§6), i.e. inside the
  images. The images plus the password are self-sufficient. `KB_LEN > 0`.
- **keyfile** — the key block is _not_ in the images (`KB_LEN = 0`); it is saved
  separately as a **`.key` file** whose contents are exactly the serialized key
  block bytes of §5.1 (magic `"SSKY"`). Restore needs the images, the password,
  and this `.key` file. A leaked image then reveals nothing without the `.key`.
- **stego** — like keyfile, but the key block is hidden in an ordinary-looking
  cover image (§5.3 for a PNG cover, §5.4 for a JPEG cover). At the blob level it
  is identical to keyfile (`KB_LEN = 0`); only the delivery of the key block differs.

A decoder distinguishes the cases by `KB_LEN`: non-zero means the key block is
embedded; zero means it must be supplied externally.

### 5.3 Stego key block (deniable LSB embedding)

The stego mode hides the §5.1 key block in the RGB least-significant bits of a
cover image, keyed by the password so that — without the password — the carrier
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
2. `stream = AES-256-CTR(key = seed, counter = 0¹²⁸)` applied to zero bytes,
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
DCT coefficients so the carrier stays a JPEG of the same size and metadata — a
`.png` in a phone's photo library would itself be an anomaly. Only baseline
sequential Huffman (SOF0), 8-bit, is supported; progressive (SOF2), arithmetic
coding, and other formats (HEIC, WebP) MUST be rejected — never transcoded, which
would change the file's size/appearance and defeat deniability.

The keyed selection, whitening pad, MSB-first bit order, and §5.1 validation are
**identical to §5.3** — only the carrier differs:

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
- `m` = number of parity shards = `max(ceil(k * 0.3), 2)` — a +30% parity ratio
  with an absolute floor of **2** (`MIN_PARITY`), so even a one-shard vault keeps
  two spares. Tolerates the loss/corruption of up to `m` images.
- Absolute ceiling: `k + m ≤ 256` (field size) and, as a product guard,
  `k + m ≤ 150` images (`MAX_IMAGES`).

### 7.3 Sharding

- `shardLen = max(1, ceil(blobLen / k))`. The blob is zero-padded to `k · shardLen`
  and split into `k` contiguous data shards.

### 7.4 Encoding matrix

The systematic generator matrix is `G = [ I_k ; C ]` (size `(k+m) × k`):

- Rows `0 … k-1`: the `k × k` identity — output shards `0 … k-1` are the data
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
MAY write it to a single **container file**. This trades the images' loss
tolerance and camera-restore for a compact artifact and a much larger size
budget (no per-image ceiling). The blob is unchanged — the container is pure
packaging around the already-authenticated bytes, so it adds no secrecy.

Two variants:

```
branded    [ MAGIC "SSBN" = 53 53 42 4E ][ VERSION u8 = 1 ][ vault blob (§6) ]
disguised  [ SQLite database 1024 (see below) ][ vault blob (§6) ]
```

- **Branded** (`.ssbn`) is self-labelling: easy for the owner to recognize; it
  makes no attempt to hide.
- **Disguised** (`.db`) prepends a **complete, valid SQLite 3 database** — a fixed
  1024-byte constant (two 512-byte pages) holding a `notes` table with a few
  innocuous dummy rows — and appends the vault blob **after the DB's last page**.
  SQLite trusts the header's page-count (offset 28 == the real count; change
  counter 24 == version-valid-for 96) and reads only those pages, ignoring the
  trailing bytes — so `sqlite3 cache.db "SELECT * FROM notes"` opens cleanly and
  lists the dummy rows, and `PRAGMA integrity_check` passes. This is deniability
  against a **casual open** (type triage *and* a quick `sqlite3` peek), still not
  a forensic adversary who notices the high-entropy tail (see
  `docs/CRYPTO-REVIEW.md` §6b). The database is a frozen constant, byte-identical
  across implementations.

The **external key** (keyfile mode, `KB_LEN = 0`) MAY be delivered the same way:
the 92-byte key block (§5.1) wrapped in a branded or disguised container. Stego
key delivery (§5.3/§5.4) is unchanged — the key stays a cover image.

**Restore.** Detect the variant by its leading signature (the branded magic, or
the disguised database's header) and strip the full prefix to recover the blob;
bytes matching neither variant are treated as a bare blob, letting AES-GCM be the
final arbiter. Then decrypt exactly as §6/§5. The gzip guard (§4) uses the binary size
cap (below), which also bounds decompression on this path.

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

### 9.1 Keys

`seed = Argon2id(NFC(password), GALLERY_SALT, DEFAULT_ARGON2, 32 bytes)` where
`GALLERY_SALT` is the 16 ASCII bytes `"StegoShard-gllry"` (`53 74 65 67 6f 53 68
61 72 64 2d 67 6c 6c 72 79`), distinct from the §5 stego salt. HKDF-SHA256 (RFC
5869, empty salt) splits the seed into two 32-byte subkeys by `info` label:

- `posKey` ← `info = "stegoshard/gallery/pos"` — drives carrier selection.
- `aeadKey` ← `info = "stegoshard/gallery/aead"` — seals fragments (AES-256-GCM).

The gallery Argon2 cost is the frozen `DEFAULT_ARGON2` and is **not stored**
anywhere (like the §5.3 stego salt). Because `aeadKey` is password-only,
extraction is image-independent — a decoder can trial-open every photo blindly.

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

The nonce is a fresh random 12 bytes carried in the slot — never derived from the
shard index — so two galleries under the same password never reuse a `(key,
nonce)` pair. A decoy image embeds `SLOT_BYTES` of CSPRNG bytes at the same
`posKey`-selected carriers; without the password it is indistinguishable from a
sealed fragment (both are uniform).

### 9.3 Carrier selection

Identical to §5.3/§5.4 — an AES-CTR keystream seeded by `posKey` drives
rejection-sampled distinct carrier positions (RGB LSBs for a PNG cover; eligible
AC coefficients with `|coef| ≥ 2` for a baseline JPEG, keeping size invariance),
MSB-first bit order — **except** there is no whitening pad (the sealed slot is
already uniform) and the length is `SLOT_BYTES·8` bits, not the fixed key-block
length. A cover must have `≥ SLOT_BYTES·8·4` eligible carriers (a ×4 margin keeps
embedding sparse) or it is rejected.

### 9.4 Encode

1. Build the standard vault blob (§6). By default this is **embedded key mode**
   (`KB_LEN = 92`), from the gzip-compressed envelope (§4) encrypted under a fresh
   DEK. A gallery may instead use **keyfile** or **stego** key mode (`KB_LEN = 0`),
   in which case the key block is not carried in the fragments but delivered
   separately — a loose `.key` file, or hidden in an ordinary cover photo (§5).
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
them — amplified vs. single-image stego (see `docs/CRYPTO-REVIEW.md`).

---

## 10. Constants summary

| Name             | Value                                                         |
| ---------------- | ------------------------------------------------------------- |
| `FORMAT_VERSION` | 1                                                             |
| Header magic     | `"SSHD"`                                                      |
| Key block magic  | `"SSKY"`                                                      |
| Binary magic     | `"SSBN"` (branded); 1024-byte SQLite database (disguised) (§8) |
| Header length    | 33 bytes                                                      |
| Codec IDs        | `0` QR-grid; `1` gallery (§9)                                 |
| Cipher           | AES-256-GCM, 12-byte IV, 16-byte tag                          |
| KDF              | Argon2id, 32-byte output, salt 16 bytes                       |
| KDF defaults     | iterations 4, memory 256 MiB, parallelism 1                   |
| GF polynomial    | `0x11D`, generator `0x02`                                     |
| Parity           | `m = max(ceil(k·0.3), 2)`                                     |
| Data per shard   | `capacity(profile) − 33` (Disk 2767, Cloud 1567, Paper 767)   |
| Gallery salt     | `"StegoShard-gllry"` (16 bytes) (§9.1)                        |
| Gallery slot     | `SLOT_DATA` 2048, `FRAG_LEN` 2081, `SLOT_BYTES` 2109 (§9.2)   |
| Limits           | file ≤ 1 MiB (images/PDF) or ≤ 100 MiB (binary); images ≤ 150 |
| Gallery limits   | blob ≤ 389120 bytes; photos 5–256; decoys ≥ 2 (§9)            |
| Compression      | gzip (RFC 1952), opportunistic                                |

---

## 11. Reference implementation

The TypeScript core in `src/core/` is the reference encoder/decoder:

| Concern            | Module                          |
| ------------------ | ------------------------------- |
| GF(2^8) arithmetic | `gf256.ts`                      |
| Reed-Solomon       | `reed-solomon.ts`, `erasure.ts` |
| Crypto / key block | `crypto.ts`                     |
| Compression        | `compress.ts`                   |
| Payload envelope   | `payload.ts`                    |
| Image header       | `header.ts`                     |
| Vault blob & flow  | `vault.ts`                      |
| QR-grid codec      | `codec/qr-grid.ts`              |
| Variable-len stego | `stego.ts`                      |
| Gallery Mode (§9)  | `gallery.ts`                    |

A standalone **Python reference decoder** in `python/stegoshard/` implements this
same specification independently (GF(2^8) + Reed-Solomon, header, key block,
Argon2id + AES-GCM, gzip, QR decode, deniable stego + Gallery Mode §9). It
restores a vault without the extension
and runs in CI as a cross-implementation conformance test: the extension encodes
and renders fixtures, the Python decoder reads them back, and the two must agree.
See `python/README.md`.
