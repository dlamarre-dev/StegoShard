# StegoShard reference decoder (Python)

A standalone, dependency-light implementation of the StegoShard format
([SPEC.md](../SPEC.md)). It restores a vault from its images **without the browser
extension**, the long-term survival guarantee: as long as you keep the images
(or a printout), your password, and this open-source script, your data is
recoverable.

It also runs in CI as a **cross-implementation conformance test**: the extension
encodes, this decoder decodes. If the two ever disagree, the format has drifted.

## Install

Requires Python ≥ 3.10.

```bash
cd python
pip install --require-hashes -r requirements.lock
```

The checked-in locks are resolved universally at the CI floor (Python 3.12).
Regenerate them from the repository root after changing an input file:

```bash
uv pip compile --universal --python-version 3.12 --generate-hashes \
  --output-file python/requirements.lock python/requirements.in
uv pip compile --universal --python-version 3.12 --generate-hashes \
  --output-file python/requirements-dev.lock python/requirements-dev.in
```

All dependencies are common PyPI packages with prebuilt wheels (no system
libraries needed): `zxing-cpp`, `Pillow`, `argon2-cffi`, `cryptography`.

## Use from the command line

```bash
# Images on disk (a folder, a .zip, or a list of files):
python -m stegoshard.decode ./my-vault-images/ --out ./restored
python -m stegoshard.decode stegoshard-abcd1234.zip
python -m stegoshard.decode page-01.png page-02.png page-03.png

# A single binary container (SPEC §8), either a branded .ssbn or a disguised .db:
python -m stegoshard.decode ./vault/stegoshard-vault.ssbn --out ./restored
python -m stegoshard.decode ./vault/cache.db --out ./restored

# Keyfile-mode sets need the separate key. `--key` takes a .key, a binary key
# container (settings.db), or the cover photo a stego key is hidden in:
python -m stegoshard.decode ./images/ --key stegoshard-abcd1234.key
python -m stegoshard.decode ./vault/cache.db --key ./vault/IMG_2043.png

# Non-possession vaults (SPEC §10.6) are gated on threshold shares you hold
# none of alone; pass any k of the n share files:
python -m stegoshard.decode ./vault/cache.db \
  --share ./vault/recovery-1.txt --share ./vault/recovery-3.txt --out ./restored

# Gallery Mode (SPEC §9): a secret fragmented across a folder of photos,
# decoded blindly: decoys and unrelated photos are ignored automatically:
python -m stegoshard.decode ./album/ --gallery --out ./restored
```

The password is prompted unless you pass `--password`. Restoring tolerates
missing images (Reed-Solomon erasure coding), and photos of printed pages are
downscaled automatically before decoding.

**Several files in one vault.** A multi-file save travels as a `.zip` inside the
envelope (SPEC §4 FLAGS bit 1). The decoder unpacks it for you:

```
$ python -m stegoshard.decode ./vault/stegoshard-vault.ssbn --out ./restored
restored 3 files:
  ./restored/notes.txt
  ./restored/key.pem
  ./restored/photo.jpg
```

## Use as a library

The package exposes the same pipeline the CLI drives. Everything is lazily
imported, so the pure modules (`gf256`, `reedsolomon`, `format`) work without the
crypto or QR dependencies installed.

```python
from pathlib import Path
from stegoshard import decode_any, decode_vault, decode_vault_binary
from stegoshard.format import unpack_bundle

# --- from a set of images -------------------------------------------------
payloads = []
for path in sorted(Path("my-vault-images").glob("*.png")):
    payload = decode_any(path.read_bytes())  # None if it is not a vault image
    if payload is not None:
        payloads.append(payload)

restored = decode_vault(payloads, "your password")

# --- or from a single binary container (.ssbn / .db) ----------------------
restored = decode_vault_binary(Path("vault/cache.db").read_bytes(), "your password")

# --- write the result -----------------------------------------------------
if restored.bundled:  # several files were saved together
    for name, data in unpack_bundle(restored.content):
        Path("restored", name).write_bytes(data)
else:
    Path("restored", restored.filename).write_bytes(restored.content)
```

`decode_vault` and `decode_vault_binary` return a `RestoredFile`
(`filename`, `content`, `bundled`). Both raise:

| Exception            | Meaning                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WrongPasswordError` | The password did not unwrap the key block. Also raised for a sub-threshold share set, deliberately: a Mode B vault must not confirm that the password was right. |
| `MissingKeyError`    | A keyfile/stego vault was opened without its external key. Pass `key_block=`.                                                                                    |

### Keys held outside the vault

```python
from stegoshard import extract_key_block_from_image, unwrap_binary

# A plain .key file:
key_block = Path("stegoshard-abcd1234.key").read_bytes()

# A binary key container (settings.db beside a disguised cache.db):
unwrapped = unwrap_binary(Path("vault/settings.db").read_bytes())
key_block = unwrapped[0] if unwrapped else None

# A key hidden in an ordinary-looking cover photo (stego mode). Keyed by the
# vault password, so it needs that too:
key_block = extract_key_block_from_image(Path("IMG_2043.png").read_bytes(), "your password")

restored = decode_vault(payloads, "your password", key_block)
```

### Threshold shares (non-possession, SPEC §10.6)

A Mode B vault is gated on a quorum of share files the writer never kept. Pass
any `k` of them:

```bash
python -m stegoshard.decode ./vault/cache.db \
  --share ./vault/recovery-1.txt --share ./vault/recovery-3.txt --out ./restored
```

The share files carry their 38 bytes as a dash-grouped **Crockford base32**
token (no `I`, `L`, `O`, `U`, so a handwritten share cannot be mistranscribed
into a different valid one) wrapped in instructions. The token is located by
pattern, so the surrounding prose, in any of the eight shipped languages, is
ignored, and a user who pastes only the token is equally fine.

From Python:

```python
from pathlib import Path
from stegoshard import decode_vault_binary
from stegoshard.shamir import decode_share_text, shamir_recover

shares = [decode_share_text(Path(p).read_text()) for p in ("recovery-1.txt", "recovery-3.txt")]
restored = decode_vault_binary(container, "your password", secret=shamir_recover(shares))
```

Below the threshold this reports **`wrong password`**, exactly as a bad
credential does. That is deliberate: a sub-threshold set must not confirm that
the password was right (SPEC §10.6). The same `--share` flag works with
`--gallery`.

## What you need to keep

| Key mode   | To restore you need                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `embedded` | The images (or the container) and the password.                                                                           |
| `keyfile`  | Those, plus the separate `.key` / `settings.db`.                                                                          |
| `stego`    | Those, plus the cover photo, **stored losslessly**. Re-encoding it (a chat app, a photo service) destroys the hidden key. |

Gallery Mode needs every photo in the set, also losslessly.

## Layout

| File             | Responsibility                                              |
| ---------------- | ----------------------------------------------------------- |
| `gf256.py`       | GF(2^8) arithmetic (SPEC §7.1)                              |
| `reedsolomon.py` | Cauchy-matrix erasure coding (SPEC §7)                      |
| `format.py`      | header, key block, vault blob, envelope (SPEC §3–6)         |
| `crypto.py`      | Argon2id KEK + AES-256-GCM (SPEC §5)                        |
| `qr.py`          | QR image → payload bytes                                    |
| `stego.py`       | deniable stego extraction (key block + gallery, SPEC §5/§9) |
| `gallery.py`     | Gallery Mode blind decode (SPEC §9)                         |
| `shamir.py`      | threshold-share recovery + share text (SPEC §10.6)          |
| `pipeline.py`    | images + password → restored file                           |
| `decode.py`      | command-line entry point                                    |
