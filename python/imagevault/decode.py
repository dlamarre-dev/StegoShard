"""Command-line reference decoder.

Usage:
    python -m imagevault.decode IMAGES... --password PW [--key FILE] [--out DIR]

IMAGES may be image files, directories, or .zip archives. A .key file (loose,
or inside a .zip/directory) is picked up automatically for keyfile-mode sets.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
import zipfile

from .crypto import WrongPasswordError
from .pipeline import MissingKeyError, decode_vault
from .qr import decode_image

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff")

# Bounds for extracting an untrusted .zip (zip-bomb / resource guard).
_MAX_ZIP_ENTRIES = 154
_MAX_ENTRY_BYTES = 25 * 1024 * 1024
_MAX_TOTAL_BYTES = 300 * 1024 * 1024


def _is_image(name: str) -> bool:
    return name.lower().endswith(_IMAGE_EXTS)


def _gather(paths: list[str]) -> tuple[list[bytes], bytes | None]:
    """Collect image byte blobs and an optional key block from the inputs."""
    images: list[bytes] = []
    key_block: bytes | None = None

    def add_file(name: str, data: bytes) -> None:
        nonlocal key_block
        if name.lower().endswith(".key"):
            key_block = data
        elif _is_image(name):
            images.append(data)

    for path in paths:
        if os.path.isdir(path):
            for root, _dirs, files in os.walk(path):
                for f in files:
                    with open(os.path.join(root, f), "rb") as fh:
                        add_file(f, fh.read())
        elif path.lower().endswith(".zip"):
            with zipfile.ZipFile(path) as zf:
                count = 0
                total = 0
                for info in zf.infolist():
                    name = info.filename
                    if not (name.lower().endswith(".key") or _is_image(name)):
                        continue
                    if info.file_size > _MAX_ENTRY_BYTES:
                        raise ValueError("a .zip entry is too large")
                    count += 1
                    total += info.file_size
                    if count > _MAX_ZIP_ENTRIES:
                        raise ValueError("too many entries in the .zip")
                    if total > _MAX_TOTAL_BYTES:
                        raise ValueError("the .zip contents are too large")
                    add_file(name, zf.read(info))
        else:
            with open(path, "rb") as fh:
                add_file(os.path.basename(path), fh.read())

    return images, key_block


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ImageVault reference decoder")
    parser.add_argument("inputs", nargs="+", help="image files, directories, or .zip archives")
    parser.add_argument("--password", help="vault password (prompted if omitted)")
    parser.add_argument("--key", help="path to a .key file (keyfile-mode sets)")
    parser.add_argument("--out", default=".", help="output directory (default: current)")
    args = parser.parse_args(argv)

    images, key_block = _gather(args.inputs)
    if not images:
        print("no images found in the inputs", file=sys.stderr)
        return 2

    payloads = [p for p in (decode_image(img) for img in images) if p is not None]
    print(f"decoded {len(payloads)} of {len(images)} image(s)", file=sys.stderr)
    if not payloads:
        print("no readable QR codes found", file=sys.stderr)
        return 1

    password = args.password or getpass.getpass("Password: ")

    # --key may be a raw .key file, or a stego cover image (PNG/JPEG) that hides
    # the key — the latter needs the password to extract.
    if args.key:
        with open(args.key, "rb") as fh:
            raw = fh.read()
        if raw[:2] == b"\xff\xd8" or raw[:8] == b"\x89PNG\r\n\x1a\n":
            from .stego import extract_key_block_from_image

            key_block = extract_key_block_from_image(raw, password)
            if key_block is None:
                print(
                    "no key found in the image (wrong password or not a stego cover)",
                    file=sys.stderr,
                )
                return 1
        else:
            key_block = raw
    try:
        restored = decode_vault(payloads, password, key_block)
    except WrongPasswordError:
        print("wrong password", file=sys.stderr)
        return 1
    except MissingKeyError:
        print("this set needs a separate .key file (use --key)", file=sys.stderr)
        return 1

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, os.path.basename(restored.filename) or "restored.bin")
    with open(out_path, "wb") as fh:
        fh.write(restored.content)
    print(f"restored {restored.filename} -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
