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

from .binary_container import looks_like_binary_container, unwrap_binary
from .codecs import decode_any
from .crypto import WrongPasswordError
from .format import unpack_bundle
from .pipeline import MissingKeyError, decode_vault, decode_vault_binary
from .shamir import decode_share_text, shamir_recover

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
            head = fh.read(128)  # a head peek is enough to recognise the container
        if looks_like_binary_container(head):
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
        # A stego cover carries either a 92-byte key block (single-region) or the
        # 32-byte key factor (multi-region .db / gallery). They self-distinguish by
        # magic, so try block then factor; only the one embedded returns non-None.
        from .stego import extract_key_block_from_image, extract_key_factor_from_image

        return extract_key_block_from_image(raw, password) or extract_key_factor_from_image(
            raw, password
        )
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


def _recover_secret(share_paths: list[str] | None) -> bytes | None:
    """Recover the Mode B gating secret from a quorum of share files (SPEC §10.6).

    Each file holds its share as a dash-grouped Crockford base32 token wrapped in
    instructions, so `decode_share_text` locates the token rather than decoding
    the prose around it. Below the threshold the interpolation simply yields a
    wrong secret, which the vault then rejects as a wrong password — deliberately
    indistinguishable.
    """
    if not share_paths:
        return None
    shares = []
    for path in share_paths:
        with open(path, encoding="utf-8") as fh:
            shares.append(decode_share_text(fh.read()))
    return shamir_recover(shares)


def _restore_gallery(args: argparse.Namespace) -> int:
    from .gallery import GalleryRestoreError, decode_gallery

    images = _gather_image_bytes(args.inputs)
    if not images:
        print("no images found in the inputs", file=sys.stderr)
        return 2
    password = args.password or getpass.getpass("Password: ")
    # A keyfile/stego gallery delivers its key separately (a .key or a cover photo).
    key_block = _resolve_key(args.key, password) if args.key else None
    try:
        restored = decode_gallery(images, password, key_block, secret=_recover_secret(args.share))
    except GalleryRestoreError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    return _write_restored(args.out, restored, args.force)


def _write_one(path: str, data: bytes, force: bool) -> None:
    """Write a restored file, refusing to clobber unless --force.

    Mirrors `writeOut` in the Node CLI. It matters twice over for a bundle:
    flattening `a/x.txt` and `b/x.txt` to a basename makes them collide, and a
    restore should never quietly destroy something already on disk.
    """
    if not force and os.path.exists(path):
        raise FileExistsError(f"refusing to overwrite existing file: {path} (use --force)")
    with open(path, "wb") as fh:
        fh.write(data)


def _write_restored(out_dir: str, restored, force: bool = False) -> int:
    """Write what a restore recovered, unpacking a bundle into its files.

    `unpack_bundle` reduces each entry to a basename and bounds expansion, so
    nothing an archive names or claims can escape `out_dir` or exhaust it
    (SPEC §4).
    """
    os.makedirs(out_dir, exist_ok=True)
    try:
        if not restored.bundled:
            out_path = os.path.join(out_dir, os.path.basename(restored.filename) or "restored.bin")
            _write_one(out_path, restored.content, force)
            print(f"restored {restored.filename} -> {out_path}")
            return 0
        written = []
        for name, data in unpack_bundle(restored.content):
            path = os.path.join(out_dir, name)
            _write_one(path, data, force)
            written.append(path)
    except (FileExistsError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"restored {len(written)} files:")
    for path in written:
        print(f"  {path}")
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
        "--force", action="store_true", help="overwrite existing output files (default: refuse)"
    )
    parser.add_argument(
        "--gallery",
        action="store_true",
        help="restore a Gallery Mode secret hidden across the given photos (SPEC §9)",
    )
    parser.add_argument(
        "--share",
        action="append",
        metavar="FILE",
        help="a threshold share file for a non-possession vault (repeatable, SPEC §10.6)",
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
        payloads = [p for p in (decode_any(img) for img in images) if p is not None]
        print(f"decoded {len(payloads)} of {len(images)} image(s)", file=sys.stderr)
        if not payloads:
            print("no readable QR codes or color grids found", file=sys.stderr)
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
        secret = _recover_secret(args.share)
        if binary_vault is not None:
            restored = decode_vault_binary(binary_vault, password, key_block, secret=secret)
        else:
            restored = decode_vault(payloads, password, key_block, secret=secret)
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

    return _write_restored(args.out, restored, args.force)


if __name__ == "__main__":
    raise SystemExit(main())
