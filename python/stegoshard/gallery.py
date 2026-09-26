"""Gallery Mode decode; mirrors src/core/gallery.ts and SPEC §9.

Restores a secret hidden, fragmented, across many ordinary photos. Every image
is trial-authenticated ("winnowing"): a slot is read at password-derived carrier
positions and AES-256-GCM-opened; failures (decoys, recompressed carriers,
foreign images, wrong password) are dropped silently. The surviving fragments,
each a standard `header || shard || padding` payload, are handed to the normal
vault decode, which groups by set id, Reed-Solomon-reconstructs, and decrypts.
"""

from __future__ import annotations

import io

from argon2.low_level import ARGON2_VERSION, Type, hash_secret_raw
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .aad import gallery_frag_aad
from .crypto import normalize_password
from .format import split_payload
from .pipeline import RestoredFile, decode_vault
from .stego import (
    GALLERY_SALT,
    extract_bytes_from_carriers,
    extract_bytes_jpeg,
    extract_bytes_rgba,
    extract_bytes_stc_from_carriers,
)

# Fixed slot geometry (SPEC §9.2). SLOT_BYTES is what blind decode reads per image.
GALLERY_SLOT_DATA = 2048
HEADER_LEN = 33
IV_LEN = 12
GCM_TAG_LEN = 16
GALLERY_FRAG_LEN = HEADER_LEN + GALLERY_SLOT_DATA
GALLERY_SLOT_BYTES = IV_LEN + GALLERY_FRAG_LEN + GCM_TAG_LEN
# Eligible carriers must exceed the slot by this factor; below it an image can't
# be a carrier, so extraction skips it (never drains the keystream).
#
# This is a decoder, so it mirrors the TS reader's margin (GALLERY_READ_MARGIN),
# not the writer's. The writer asks for 16 now, for sparseness; a reader that
# demanded 16 would refuse to open galleries written when the bar was 4.
GALLERY_READ_MARGIN = 4


class GalleryRestoreError(Exception):
    """Raised when no gallery can be restored (wrong password or no gallery photos)."""


def _hkdf(seed: bytes, info: bytes, length: int = 32) -> bytes:
    # Empty salt matches WebCrypto's HKDF (HMAC zero-pads the key either way).
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=b"", info=info).derive(seed)


def _gallery_keys(
    password: str, iterations: int, memory_kib: int, parallelism: int
) -> tuple[bytes, bytes]:
    """Argon2id(password, GALLERY_SALT) → HKDF-split (S0 position key, AEAD key)."""
    pos_key, _s1_key, aead_key = _gallery_key_set(password, iterations, memory_kib, parallelism)
    return pos_key, aead_key


def _gallery_key_set(
    password: str, iterations: int, memory_kib: int, parallelism: int
) -> tuple[bytes, bytes, bytes]:
    """(S0 position key, S1 position key, AEAD key), from one Argon2id (SPEC §9.3.1)."""
    seed = _gallery_seed(password, iterations, memory_kib, parallelism)
    return (
        _hkdf(seed, b"stegoshard/gallery/pos"),
        _hkdf(seed, b"stegoshard/gallery/pos/s1"),
        _hkdf(seed, b"stegoshard/gallery/aead"),
    )


def _gallery_seed(password: str, iterations: int, memory_kib: int, parallelism: int) -> bytes:
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
    return seed


def _open_slot(image_bytes: bytes, pos_key: bytes, s1_key: bytes, aead: AESGCM) -> bytes | None:
    """A photo's authenticated fragment: S1 first for a JPEG, then S0, else None."""
    if image_bytes[:2] != b"\xff\xd8":  # a raster: S0 only
        return _open_sealed(_extract_slot(image_bytes, pos_key), aead, "S0")
    from .jpeg_coeff import JpegUnsupported, decode, eligible_coefficients

    # Decoded once for both attempts, as the TypeScript reader does: the decode is
    # most of the cost, and a decoy pays for both.
    try:
        carriers = eligible_coefficients(decode(image_bytes))
    except JpegUnsupported:
        return None
    s1 = extract_bytes_stc_from_carriers(carriers, s1_key, GALLERY_SLOT_BYTES)
    opened = _open_sealed(s1, aead, "S1")
    if opened is not None:
        return opened
    s0 = extract_bytes_from_carriers(carriers, pos_key, GALLERY_SLOT_BYTES, GALLERY_READ_MARGIN)
    return _open_sealed(s0, aead, "S0")


def _open_sealed(slot: bytes | None, aead: AESGCM, scheme: str) -> bytes | None:
    """AES-GCM-open a slot under one scheme's AAD; None on a failed tag."""
    if slot is None:
        return None
    try:
        return aead.decrypt(slot[:IV_LEN], slot[IV_LEN:], gallery_frag_aad(scheme))
    except Exception:  # noqa: BLE001 - any AEAD failure means "not this scheme"
        return None


def _extract_slot(image_bytes: bytes, pos_key: bytes) -> bytes | None:
    """Read a fixed-size slot from one photo (JPEG DCT or PNG spatial LSB)."""
    if image_bytes[:2] == b"\xff\xd8":  # JPEG
        return extract_bytes_jpeg(image_bytes, pos_key, GALLERY_SLOT_BYTES, GALLERY_READ_MARGIN)
    from PIL import Image

    with Image.open(io.BytesIO(image_bytes)) as img:
        rgba = img.convert("RGBA")
        width, height = rgba.size
        data = rgba.tobytes()
    return extract_bytes_rgba(data, width, height, pos_key, GALLERY_SLOT_BYTES, GALLERY_READ_MARGIN)


def decode_gallery(
    images: list[bytes],
    password: str,
    key_block: bytes | None = None,
    iterations: int = 4,
    memory_kib: int = 256 * 1024,
    parallelism: int = 1,
    secret: bytes | None = None,
) -> RestoredFile:
    """Restore a secret from a folder of photos, blindly (SPEC §9.5).

    `images` is the raw bytes of each candidate photo. `key_block` is the external
    key for a keyfile/stego gallery (omit for the default embedded-key gallery).
    The gallery Argon2 cost is the frozen default (not stored); override only to
    match test fixtures.
    """
    pos_key, s1_key, aead_key = _gallery_key_set(password, iterations, memory_kib, parallelism)
    aead = AESGCM(aead_key)

    fragments: list[bytes] = []
    for image_bytes in images:
        # slot = nonce(12) || AES-GCM(header || shard || pad). A failed tag under
        # every scheme is a decoy / destroyed carrier / foreign image / wrong
        # password, so drop it.
        frag = _open_slot(image_bytes, pos_key, s1_key, aead)
        if frag is not None:
            fragments.append(frag)

    if not fragments:
        raise GalleryRestoreError(
            "no restorable gallery found (wrong password or no gallery photos)"
        )

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
            # Gallery vaults carry the §10 multi-region blob; the external artifact
            # for a keyfile/stego gallery is a 32-byte key factor (here `key_block`).
            return decode_vault(
                group,
                password,
                multiregion=True,
                key_factor=key_block,
                secret=secret,
                iterations=iterations,
                memory_kib=memory_kib,
                parallelism=parallelism,
            )
        except Exception:  # noqa: BLE001 - incomplete/failed set, try the next
            continue
    raise GalleryRestoreError("gallery reconstruction failed")
