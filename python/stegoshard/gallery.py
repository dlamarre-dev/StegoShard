"""Gallery Mode decode — mirrors src/core/gallery.ts and SPEC §9.

Restores a secret hidden, fragmented, across many ordinary photos. Every image
is trial-authenticated ("winnowing"): a slot is read at password-derived carrier
positions and AES-256-GCM-opened; failures (decoys, recompressed carriers,
foreign images, wrong password) are dropped silently. The surviving fragments —
each a standard `header || shard || padding` payload — are handed to the normal
vault decode, which groups by set id, Reed-Solomon-reconstructs, and decrypts.
"""

from __future__ import annotations

import io

from argon2.low_level import ARGON2_VERSION, Type, hash_secret_raw
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .crypto import normalize_password
from .format import split_payload
from .pipeline import RestoredFile, decode_vault
from .stego import GALLERY_SALT, extract_bytes_jpeg, extract_bytes_rgba

# Fixed slot geometry (SPEC §9.2). SLOT_BYTES is what blind decode reads per image.
GALLERY_SLOT_DATA = 2048
HEADER_LEN = 33
IV_LEN = 12
GCM_TAG_LEN = 16
GALLERY_FRAG_LEN = HEADER_LEN + GALLERY_SLOT_DATA
GALLERY_SLOT_BYTES = IV_LEN + GALLERY_FRAG_LEN + GCM_TAG_LEN
# Eligible carriers must exceed the slot by this factor (matches the TS encoder);
# below it an image can't be a carrier, so extraction skips it (never drains the
# keystream).
GALLERY_CAPACITY_MARGIN = 4


class GalleryRestoreError(Exception):
    """Raised when no gallery can be restored (wrong password or no gallery photos)."""


def _hkdf(seed: bytes, info: bytes, length: int = 32) -> bytes:
    # Empty salt matches WebCrypto's HKDF (HMAC zero-pads the key either way).
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=b"", info=info).derive(seed)


def _gallery_keys(
    password: str, iterations: int, memory_kib: int, parallelism: int
) -> tuple[bytes, bytes]:
    """Argon2id(password, GALLERY_SALT) → HKDF-split (position key, AEAD key)."""
    seed = hash_secret_raw(
        secret=normalize_password(password).encode("utf-8"),
        salt=GALLERY_SALT,
        time_cost=iterations,
        memory_cost=memory_kib,
        parallelism=parallelism,
        hash_len=32,
        type=Type.ID,
        version=ARGON2_VERSION,
    )
    return _hkdf(seed, b"stegoshard/gallery/pos"), _hkdf(seed, b"stegoshard/gallery/aead")


def _extract_slot(image_bytes: bytes, pos_key: bytes) -> bytes | None:
    """Read a fixed-size slot from one photo (JPEG DCT or PNG spatial LSB)."""
    if image_bytes[:2] == b"\xff\xd8":  # JPEG
        return extract_bytes_jpeg(image_bytes, pos_key, GALLERY_SLOT_BYTES, GALLERY_CAPACITY_MARGIN)
    from PIL import Image

    with Image.open(io.BytesIO(image_bytes)) as img:
        rgba = img.convert("RGBA")
        width, height = rgba.size
        data = rgba.tobytes()
    return extract_bytes_rgba(
        data, width, height, pos_key, GALLERY_SLOT_BYTES, GALLERY_CAPACITY_MARGIN
    )


def decode_gallery(
    images: list[bytes],
    password: str,
    key_block: bytes | None = None,
    iterations: int = 3,
    memory_kib: int = 64 * 1024,
    parallelism: int = 1,
) -> RestoredFile:
    """Restore a secret from a folder of photos, blindly (SPEC §9.5).

    `images` is the raw bytes of each candidate photo. `key_block` is the external
    key for a keyfile/stego gallery (omit for the default embedded-key gallery).
    The gallery Argon2 cost is the frozen default (not stored); override only to
    match test fixtures.
    """
    pos_key, aead_key = _gallery_keys(password, iterations, memory_kib, parallelism)
    aead = AESGCM(aead_key)

    fragments: list[bytes] = []
    for image_bytes in images:
        slot = _extract_slot(image_bytes, pos_key)
        if slot is None:
            continue
        try:
            # slot = nonce(12) || AES-GCM(header || shard || pad). A failed tag is
            # a decoy / destroyed carrier / foreign image / wrong password — drop it.
            frag = aead.decrypt(slot[:IV_LEN], slot[IV_LEN:], None)
        except Exception:  # noqa: BLE001 - any AEAD failure means "not a fragment"
            continue
        fragments.append(frag)

    if not fragments:
        raise GalleryRestoreError("no restorable gallery found (wrong password or no gallery photos)")

    # Each fragment is header || shard || zero-pad; the vault decoder's own
    # split_payload reads exactly shard_len bytes and ignores the padding. Group by
    # set id and try each group largest-first (mirrors the TS decoder), so a mixed
    # folder or a second same-password gallery still resolves to a complete set.
    groups: dict[bytes, list[bytes]] = {}
    for frag in fragments:
        try:
            header, _shard = split_payload(frag)
        except Exception:  # noqa: BLE001 - not a well-formed payload, skip it
            continue
        groups.setdefault(header.set_id, []).append(frag)

    for group in sorted(groups.values(), key=len, reverse=True):
        try:
            return decode_vault(group, password, key_block)
        except Exception:  # noqa: BLE001 - incomplete/failed set, try the next
            continue
    raise GalleryRestoreError("gallery reconstruction failed")
