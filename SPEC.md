# ImageVault format specification — v1

This document is the **stable, versioned interface** for the ImageVault on-image
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

| Offset | Size | Field         | Notes                                        |
| -----: | ---: | ------------- | -------------------------------------------- |
|      0 |    4 | `MAGIC`       | ASCII `"IVLT"` = `49 56 4C 54`               |
|      4 |    1 | `VERSION`     | format version, `1`                          |
|      5 |    8 | `SET_ID`      | random per-vault identifier                  |
|     13 |    2 | `SHARD_INDEX` | u16, global shard index `0 … k+m-1`          |
|     15 |    2 | `K`           | u16, number of data shards                   |
|     17 |    2 | `M`           | u16, number of parity shards                 |
|     19 |    1 | `CODEC_ID`    | `0` = qr-grid                                |
|     20 |    1 | `PROFILE`     | `0`=disk, `1`=cloud, `2`=paper               |
|     21 |    4 | `SHARD_LEN`   | u32, bytes per shard (all shards equal)      |
|     25 |    4 | `BLOB_LEN`    | u32, true length of the vault blob (§6)      |
|     29 |    4 | `HASH_GLOBAL` | first 4 bytes of SHA-256(vault blob)         |

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
[ MAGIC 4 = "IVKY" = 49 56 4B 59 ][ VER 1 = 1 ]
[ salt 16 ]
[ iterations u32 ][ memoryKiB u32 ][ parallelism u8 ]      (Argon2id parameters)
[ wrapIv 12 ][ wrappedLen u16 ][ wrappedDEK (wrappedLen bytes) ]
```

- **KDF:** Argon2id, `hashLength = 32` (the KEK is a 256-bit AES-GCM key).
  Parameters are stored in the block so any decoder can reproduce the derivation.
  The extension's production defaults are `iterations = 3`, `memoryKiB = 65536`
  (64 MiB), `parallelism = 1`.
- **Wrapping:** `wrappedDEK = AES-256-GCM(KEK, rawDEK)` using `wrapIv`. The GCM tag
  is included in `wrappedDEK`, so a wrong password fails to unwrap (authenticated).
- **salt:** 16 random bytes for the KDF.

Recovery requires **the password _and_ this key block**.

### 5.2 Key modes

Where the key block travels is chosen per save:

- **embedded** — the key block is stored in the vault blob (§6), i.e. inside the
  images. The images plus the password are self-sufficient. `KB_LEN > 0`.
- **keyfile** — the key block is *not* in the images (`KB_LEN = 0`); it is saved
  separately as a **`.key` file** whose contents are exactly the serialized key
  block bytes of §5.1 (magic `"IVKY"`). Restore needs the images, the password,
  and this `.key` file. A leaked image then reveals nothing without the `.key`.
- **stego** — like keyfile, but the key block is hidden in an ordinary-looking
  cover image (added in a later phase). At the blob level it is identical to
  keyfile (`KB_LEN = 0`); only the delivery of the key block differs.

A decoder distinguishes the cases by `KB_LEN`: non-zero means the key block is
embedded; zero means it must be supplied externally.

---

## 6. Vault blob

The blob is what gets erasure-coded and split across images. It bundles everything
needed (besides the password) to decrypt:

```
[ KB_LEN u16 ][ key block (KB_LEN bytes, §5.1) ][ IV 12 ][ ciphertext (§5) ]
```

`KB_LEN` is `0` for the keyfile/stego modes (§5.2); the key block is then
supplied externally at restore time.

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

## 8. Constants summary

| Name             | Value                                             |
| ---------------- | ------------------------------------------------- |
| `FORMAT_VERSION` | 1                                                 |
| Header magic     | `"IVLT"`                                          |
| Key block magic  | `"IVKY"`                                          |
| Header length    | 33 bytes                                          |
| Cipher           | AES-256-GCM, 12-byte IV, 16-byte tag              |
| KDF              | Argon2id, 32-byte output, salt 16 bytes           |
| KDF defaults     | iterations 3, memory 64 MiB, parallelism 1        |
| GF polynomial    | `0x11D`, generator `0x02`                         |
| Parity           | `m = max(ceil(k·0.3), 2)`                          |
| Data per shard   | `capacity(profile) − 33` (Disk 2767, Cloud 1567, Paper 767) |
| Limits           | file ≤ 256 KiB, images ≤ 150                       |
| Compression      | gzip (RFC 1952), opportunistic                    |

---

## 9. Reference implementation

The TypeScript core in `src/core/` is the reference encoder/decoder:

| Concern            | Module                        |
| ------------------ | ----------------------------- |
| GF(2^8) arithmetic | `gf256.ts`                    |
| Reed-Solomon       | `reed-solomon.ts`, `erasure.ts` |
| Crypto / key block | `crypto.ts`                   |
| Compression        | `compress.ts`                 |
| Payload envelope   | `payload.ts`                  |
| Image header       | `header.ts`                   |
| Vault blob & flow  | `vault.ts`                    |
| QR-grid codec      | `codec/qr-grid.ts`            |

A standalone **Python reference decoder** in `python/imagevault/` implements this
same specification independently (GF(2^8) + Reed-Solomon, header, key block,
Argon2id + AES-GCM, gzip, QR decode). It restores a vault without the extension
and runs in CI as a cross-implementation conformance test: the extension encodes
and renders fixtures, the Python decoder reads them back, and the two must agree.
See `python/README.md`.
