"""Command-line reference decoder.

Usage:
    python -m stegoshard.decode IMAGES... --password PW [--key FILE] [--out DIR]

IMAGES may be image files, directories, or .zip archives. A .key file (loose,
or inside a .zip/directory) is picked up automatically for keyfile-mode sets.
A single binary container file (SPEC §8, e.g. *.ssbn or a disguised *.db) is
also accepted in place of images. --key may be a .key file, a stego cover image,
or a binary key container.
"""

from __future__ import annotations

import argparse
import getpass
import os
import struct
import sys
import zipfile

from .binary_container import unwrap_binary
from .crypto import WrongPasswordError
from .pipeline import MissingKeyError, decode_vault, decode_vault_binary
from .qr import decode_image

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff")

# Bounds for extracting an untrusted .zip (zip-bomb / resource guard).
_MAX_ZIP_ENTRIES = 154
_MAX_ENTRY_BYTES = 25 * 1024 * 1024
_MAX_TOTAL_BYTES = 300 * 1024 * 1024


def _is_image(name: str) -> bool:
    return name.lower().endswith(_IMAGE_EXTS)


def _find_binary_vault(paths: list[str]) -> bytes | None:
    """Return the bytes of the first input that is a binary container (SPEC §8)."""
    for path in paths:
        if not os.path.isfile(path):
            continue
        with open(path, "rb") as fh:
            head = fh.read(128)  # covers the disguised variant's 100-byte header
        try:
            is_container = unwrap_binary(head) is not None
        except ValueError:
            is_container = True  # our magic, unsupported version — still ours
        if is_container:
            with open(path, "rb") as fh:
                return fh.read()
    return None


def _resolve_key(path: str, password: str) -> bytes | None:
    """A --key input may be a raw .key, a binary key container, or a stego image."""
    with open(path, "rb") as fh:
        raw = fh.read()
    unwrapped = unwrap_binary(raw)
    if unwrapped:
        return unwrapped[0]
    if raw[:2] == b"\xff\xd8" or raw[:8] == b"\x89PNG\r\n\x1a\n":
        from .stego import extract_key_block_from_image

        return extract_key_block_from_image(raw, password)
    return raw  # raw .key


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


def _gather_image_bytes(paths: list[str]) -> list[bytes]:
    """Collect the raw bytes of every image file in the inputs (Gallery Mode)."""
    images: list[bytes] = []
    for path in paths:
        if os.path.isdir(path):
            for root, _dirs, files in os.walk(path):
                for f in sorted(files):
                    if _is_image(f):
                        with open(os.path.join(root, f), "rb") as fh:
                            images.append(fh.read())
        elif _is_image(path):
            with open(path, "rb") as fh:
                images.append(fh.read())
    return images


def _restore_gallery(args: argparse.Namespace) -> int:
    from .gallery import GalleryRestoreError, decode_gallery

    images = _gather_image_bytes(args.inputs)
    if not images:
        print("no images found in the inputs", file=sys.stderr)
        return 2
    password = args.password or getpass.getpass("Password: ")
    try:
        restored = decode_gallery(images, password)
    except GalleryRestoreError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, os.path.basename(restored.filename) or "restored.bin")
    with open(out_path, "wb") as fh:
        fh.write(restored.content)
    print(f"restored {restored.filename} -> {out_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="StegoShard reference decoder")
    parser.add_argument(
        "inputs", nargs="+", help="images, directories, .zip archives, or a binary container"
    )
    parser.add_argument("--password", help="vault password (prompted if omitted)")
    parser.add_argument("--key", help="a .key file, stego image, or binary key container")
    parser.add_argument("--out", default=".", help="output directory (default: current)")
    parser.add_argument(
        "--gallery",
        action="store_true",
        help="restore a Gallery Mode secret hidden across the given photos (SPEC §9)",
    )
    args = parser.parse_args(argv)

    if args.gallery:
        return _restore_gallery(args)

    # A binary container (SPEC §8) short-circuits the image pipeline.
    binary_vault = _find_binary_vault(args.inputs)

    if binary_vault is None:
        images, key_block = _gather(args.inputs)
        if not images:
            print("no images found in the inputs", file=sys.stderr)
            return 2
        payloads = [p for p in (decode_image(img) for img in images) if p is not None]
        print(f"decoded {len(payloads)} of {len(images)} image(s)", file=sys.stderr)
        if not payloads:
            print("no readable QR codes found", file=sys.stderr)
            return 1
    else:
        key_block = None

    password = args.password or getpass.getpass("Password: ")

    if args.key:
        key_block = _resolve_key(args.key, password)
        if key_block is None:
            print(
                "no key found in the image (wrong password or not a stego cover)",
                file=sys.stderr,
            )
            return 1
    try:
        if binary_vault is not None:
            restored = decode_vault_binary(binary_vault, password, key_block)
        else:
            restored = decode_vault(payloads, password, key_block)
    except WrongPasswordError:
        print("wrong password", file=sys.stderr)
        return 1
    except MissingKeyError:
        print("this vault needs a separate key (use --key)", file=sys.stderr)
        return 1
    except (ValueError, struct.error) as exc:
        # Malformed / truncated input — a clean message, not a stack trace.
        print(f"not a valid StegoShard vault: {exc}", file=sys.stderr)
        return 1

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, os.path.basename(restored.filename) or "restored.bin")
    with open(out_path, "wb") as fh:
        fh.write(restored.content)
    print(f"restored {restored.filename} -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
