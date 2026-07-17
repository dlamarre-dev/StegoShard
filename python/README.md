# StegoShard reference decoder (Python)

A standalone, dependency-light implementation of the StegoShard format
([SPEC.md](../SPEC.md)). It restores a vault from its images **without the browser
extension** — the long-term survival guarantee: as long as you keep the images
(or a printout), your password, and this open-source script, your data is
recoverable.

It also runs in CI as a **cross-implementation conformance test**: the extension
encodes, this decoder decodes. If the two ever disagree, the format has drifted.

## Install

Requires Python ≥ 3.10.

```bash
cd python
pip install -r requirements.txt
```

All dependencies are common PyPI packages with prebuilt wheels (no system
libraries needed): `zxing-cpp`, `Pillow`, `argon2-cffi`, `cryptography`.

## Use

```bash
# Images on disk (a folder, a .zip, or a list of files):
python -m stegoshard.decode ./my-vault-images/ --out ./restored
python -m stegoshard.decode stegoshard-abcd1234.zip
python -m stegoshard.decode page-01.png page-02.png page-03.png

# Keyfile-mode sets need the separate .key (also auto-detected inside a zip/folder):
python -m stegoshard.decode ./images/ --key stegoshard-abcd1234.key
```

The password is prompted unless you pass `--password`. Restoring tolerates
missing images (Reed-Solomon erasure coding), and photos of printed pages are
downscaled automatically before decoding.

## Layout

| File             | Responsibility                                    |
| ---------------- | ------------------------------------------------- |
| `gf256.py`       | GF(2^8) arithmetic (SPEC §7.1)                    |
| `reedsolomon.py` | Cauchy-matrix erasure coding (SPEC §7)            |
| `format.py`      | header, key block, vault blob, envelope (SPEC §3–6) |
| `crypto.py`      | Argon2id KEK + AES-256-GCM (SPEC §5)              |
| `qr.py`          | QR image → payload bytes                          |
| `pipeline.py`    | images + password → restored file                |
| `decode.py`      | command-line entry point                          |
