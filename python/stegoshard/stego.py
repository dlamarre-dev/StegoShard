"""Deniable stego key block extraction — mirrors src/core/stego.ts and SPEC §5.3.

Recovers the 92-byte key block hidden in the RGB least-significant bits of a
cover image, keyed by the password. Returns None when the password is wrong or
the image carries no key (deliberately indistinguishable).
"""

from __future__ import annotations

import hashlib
import struct

from argon2.low_level import ARGON2_VERSION, Type, hash_secret_raw
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .crypto import normalize_password
from .format import KEY_BLOCK_VERSION, KEY_MAGIC

KEY_BLOCK_LEN = 92

# Stego key-factor envelope (SSKF, §10.3): the 32-byte external key factor, wrapped
# with a magic + version so a stego extraction self-validates (wrong password →
# de-whitened noise → no magic → None), mirroring the 92-byte key block's check.
KEY_FACTOR_LEN = 32
KEY_FACTOR_MAGIC = b"SSKF"
KEY_FACTOR_BLOCK_VERSION = 1
KEY_FACTOR_BLOCK_LEN = len(KEY_FACTOR_MAGIC) + 1 + KEY_FACTOR_LEN  # 37


def _min_capacity_rgba(payload_len: int) -> int:
    return payload_len * 8 * 16


def _min_capacity_jpeg(payload_len: int) -> int:
    return payload_len * 8 * 2

# Fixed application salt: ASCII "StegoShard-stego" (exactly 16 bytes) (SPEC §5.3).
STEGO_SALT = b"StegoShard-stego"
# Fixed application salt for Gallery Mode: ASCII "StegoShard-gllry" (SPEC §9.1).
GALLERY_SALT = b"StegoShard-gllry"
# HKDF info binding the keystream to the specific cover (SPEC §5.3/§5.4/§9.3).
STEGO_COVER_INFO = b"stegoshard/stego/cover"


def _cover_fingerprint_rgba(rgba: bytes, width: int, height: int) -> bytes:
    """SHA-256 over an RGBA cover's embedding-invariant bits (RGB, LSB masked;
    alpha excluded). Mirrors coverFingerprintRgba in src/core/stego.ts."""
    pixels = width * height
    masked = bytearray(pixels * 3)
    o = 0
    for p in range(pixels):
        base = p * 4
        masked[o] = rgba[base] & 0xFE
        masked[o + 1] = rgba[base + 1] & 0xFE
        masked[o + 2] = rgba[base + 2] & 0xFE
        o += 3
    return hashlib.sha256(bytes(masked)).digest()


def _cover_fingerprint_jpeg(carriers: list[tuple[list[int], int]]) -> bytes:
    """SHA-256 over eligible carriers' signed magnitudes with bit 0 masked, big-
    endian int32, in carrier order. Mirrors coverFingerprintJpeg in stego.ts."""
    buf = bytearray()
    for block, k in carriers:
        v = block[k]
        m = abs(v) & ~1
        buf += struct.pack(">i", -m if v < 0 else m)
    return hashlib.sha256(bytes(buf)).digest()


def _cover_key(seed: bytes, fingerprint: bytes) -> bytes:
    """Per-cover keystream key: HKDF-SHA256(seed, salt=fingerprint, info=COVER)."""
    return HKDF(
        algorithm=hashes.SHA256(), length=32, salt=fingerprint, info=STEGO_COVER_INFO
    ).derive(seed)


def _keystream_from_seed(seed: bytes, length: int) -> bytes:
    """AES-256-CTR keystream of `length` bytes from a 32-byte seed (counter 0)."""
    encryptor = Cipher(algorithms.AES(seed), modes.CTR(b"\x00" * 16)).encryptor()
    return encryptor.update(b"\x00" * length) + encryptor.finalize()


def _keystream(
    password: str,
    length: int,
    iterations: int,
    memory_kib: int,
    parallelism: int,
    fingerprint: bytes,
) -> bytes:
    seed = hash_secret_raw(
        secret=normalize_password(password).encode("utf-8"),
        salt=STEGO_SALT,
        time_cost=iterations,
        memory_cost=memory_kib,
        parallelism=parallelism,
        hash_len=32,
        type=Type.ID,
        version=ARGON2_VERSION,
    )
    # Bind the keystream to this cover, then AES-256-CTR over zero bytes (counter
    # 0, matches WebCrypto).
    return _keystream_from_seed(_cover_key(seed, fingerprint), length)


def _pick_positions(stream: bytes, offset: int, capacity: int, count: int) -> list[int]:
    limit = (0x1_0000_0000 // capacity) * capacity  # reject above this (no modulo bias)
    used: set[int] = set()
    positions: list[int] = []
    o = offset
    while len(positions) < count:
        if o + 4 > len(stream):
            raise ValueError("stego: keystream exhausted")
        r = int.from_bytes(stream[o : o + 4], "big")
        o += 4
        if r >= limit:
            continue
        pos = r % capacity
        if pos in used:
            continue
        used.add(pos)
        positions.append(pos)
    return positions


def _stream_len(payload_len: int) -> int:
    return payload_len + payload_len * 8 * 8 + 1024


def _extract_fixed_rgba(
    rgba: bytes,
    width: int,
    height: int,
    length: int,
    password: str,
    iterations: int,
    memory_kib: int,
    parallelism: int,
) -> bytes | None:
    """De-whitened fixed-length payload from an RGBA cover, or None if too small.
    Magic validation is the caller's job. Mirrors extractFixedStego in stego.ts."""
    capacity = width * height * 3
    if capacity < _min_capacity_rgba(length):
        return None
    bits = length * 8
    fingerprint = _cover_fingerprint_rgba(rgba, width, height)
    stream = _keystream(
        password, _stream_len(length), iterations, memory_kib, parallelism, fingerprint
    )
    pad = stream[:length]
    positions = _pick_positions(stream, length, capacity, bits)
    out = bytearray(length)
    for i, pos in enumerate(positions):
        byte_index = (pos // 3) * 4 + (pos % 3)
        if rgba[byte_index] & 1:
            out[i >> 3] |= 1 << (7 - (i & 7))
    for j in range(length):
        out[j] ^= pad[j]
    return bytes(out)


def _extract_fixed_jpeg(
    jpeg_bytes: bytes,
    length: int,
    password: str,
    iterations: int,
    memory_kib: int,
    parallelism: int,
) -> bytes | None:
    """De-whitened fixed-length payload from a baseline JPEG, or None. Magic
    validation is the caller's job. Mirrors extractFixedStegoJpeg in stego.ts."""
    from .jpeg_coeff import JpegUnsupported, decode, eligible_coefficients

    try:
        carriers = eligible_coefficients(decode(jpeg_bytes))
    except JpegUnsupported:
        return None
    capacity = len(carriers)
    if capacity < _min_capacity_jpeg(length):
        return None
    bits = length * 8
    fingerprint = _cover_fingerprint_jpeg(carriers)
    stream = _keystream(
        password, _stream_len(length), iterations, memory_kib, parallelism, fingerprint
    )
    pad = stream[:length]
    positions = _pick_positions(stream, length, capacity, bits)
    out = bytearray(length)
    for i, pos in enumerate(positions):
        block, k = carriers[pos]
        if abs(block[k]) & 1:
            out[i >> 3] |= 1 << (7 - (i & 7))
    for j in range(length):
        out[j] ^= pad[j]
    return bytes(out)


def _is_key_block(b: bytes) -> bool:
    return len(b) == KEY_BLOCK_LEN and b[:4] == KEY_MAGIC and b[4] == KEY_BLOCK_VERSION


def _parse_key_factor(b: bytes) -> bytes | None:
    if (
        len(b) == KEY_FACTOR_BLOCK_LEN
        and b[:4] == KEY_FACTOR_MAGIC
        and b[4] == KEY_FACTOR_BLOCK_VERSION
    ):
        return b[5:]
    return None


def extract_key_block(
    rgba: bytes,
    width: int,
    height: int,
    password: str,
    iterations: int = 4,
    memory_kib: int = 256 * 1024,
    parallelism: int = 1,
) -> bytes | None:
    """Recover a stego-embedded key block, or None if absent / wrong password.

    `rgba` is the cover image as RGBA bytes (4 bytes/pixel).
    """
    out = _extract_fixed_rgba(
        rgba, width, height, KEY_BLOCK_LEN, password, iterations, memory_kib, parallelism
    )
    return out if out is not None and _is_key_block(out) else None


def extract_key_block_jpeg(
    jpeg_bytes: bytes,
    password: str,
    iterations: int = 4,
    memory_kib: int = 256 * 1024,
    parallelism: int = 1,
) -> bytes | None:
    """Recover a key block hidden in a baseline JPEG's DCT coefficients (SPEC §5.4).

    Returns None for a wrong password, no key, or a non-baseline JPEG.
    """
    out = _extract_fixed_jpeg(
        jpeg_bytes, KEY_BLOCK_LEN, password, iterations, memory_kib, parallelism
    )
    return out if out is not None and _is_key_block(out) else None


def extract_key_factor(
    rgba: bytes,
    width: int,
    height: int,
    password: str,
    iterations: int = 4,
    memory_kib: int = 256 * 1024,
    parallelism: int = 1,
) -> bytes | None:
    """Recover the 32-byte external key factor from an SSKF-wrapped stego cover
    (RGBA / PNG), or None if absent / wrong password. Mirrors extractKeyFactorStego."""
    out = _extract_fixed_rgba(
        rgba, width, height, KEY_FACTOR_BLOCK_LEN, password, iterations, memory_kib, parallelism
    )
    return _parse_key_factor(out) if out is not None else None


def extract_key_factor_jpeg(
    jpeg_bytes: bytes,
    password: str,
    iterations: int = 4,
    memory_kib: int = 256 * 1024,
    parallelism: int = 1,
) -> bytes | None:
    """Recover the 32-byte key factor from a baseline JPEG (SSKF), or None."""
    out = _extract_fixed_jpeg(
        jpeg_bytes, KEY_FACTOR_BLOCK_LEN, password, iterations, memory_kib, parallelism
    )
    return _parse_key_factor(out) if out is not None else None


# --- Variable-length payload stego (Gallery Mode, SPEC §9) -------------------
#
# Mirrors src/core/stego.ts extractBytesStego{Rgba,Jpeg}: same keyed carrier
# selection as the key-block paths, but seeded by a raw 32-byte position key
# (not a password), with no whitening and no magic — the caller authenticates
# each extracted slot via its AEAD tag.


def _position_stream_len(payload_bits: int) -> int:
    return payload_bits * 8 + 4096


def extract_bytes_rgba(
    rgba: bytes, width: int, height: int, seed: bytes, length: int, margin: int = 1
) -> bytes | None:
    """Read `length` bytes from an RGBA buffer at seed-derived LSBs.

    Returns None when the carrier count is below `length*8*margin` — the same
    threshold embedding used, so a real carrier passes and a too-small image is
    skipped instead of draining the position keystream (raising).
    """
    capacity = width * height * 3
    bits = length * 8
    if capacity < bits * margin:
        return None
    stream = _keystream_from_seed(seed, _position_stream_len(bits))
    positions = _pick_positions(stream, 0, capacity, bits)
    out = bytearray(length)
    for i, pos in enumerate(positions):
        byte_index = (pos // 3) * 4 + (pos % 3)
        if rgba[byte_index] & 1:
            out[i >> 3] |= 1 << (7 - (i & 7))
    return bytes(out)


def extract_bytes_jpeg(
    jpeg_bytes: bytes, seed: bytes, length: int, margin: int = 1
) -> bytes | None:
    """Read `length` bytes from a baseline JPEG's DCT coefficients, or None.

    None when undecodable or when the carrier count is below `length*8*margin`
    (matches embedding, so undersized/foreign images are skipped safely).
    """
    from .jpeg_coeff import JpegUnsupported, decode, eligible_coefficients

    try:
        carriers = eligible_coefficients(decode(jpeg_bytes))
    except JpegUnsupported:
        return None
    capacity = len(carriers)
    bits = length * 8
    if capacity < bits * margin:
        return None
    stream = _keystream_from_seed(seed, _position_stream_len(bits))
    positions = _pick_positions(stream, 0, capacity, bits)
    out = bytearray(length)
    for i, pos in enumerate(positions):
        block, k = carriers[pos]
        if abs(block[k]) & 1:
            out[i >> 3] |= 1 << (7 - (i & 7))
    return bytes(out)


def extract_key_block_from_image(
    image_bytes: bytes,
    password: str,
    iterations: int = 4,
    memory_kib: int = 256 * 1024,
    parallelism: int = 1,
) -> bytes | None:
    """Extract the key from a stego cover, sniffing PNG (spatial LSB) vs baseline
    JPEG (DCT coefficients)."""
    if image_bytes[:2] == b"\xff\xd8":  # JPEG
        return extract_key_block_jpeg(image_bytes, password, iterations, memory_kib, parallelism)

    import io

    from PIL import Image

    with Image.open(io.BytesIO(image_bytes)) as img:
        rgba = img.convert("RGBA")
        width, height = rgba.size
        data = rgba.tobytes()
    return extract_key_block(data, width, height, password, iterations, memory_kib, parallelism)


def extract_key_factor_from_image(
    image_bytes: bytes,
    password: str,
    iterations: int = 4,
    memory_kib: int = 256 * 1024,
    parallelism: int = 1,
) -> bytes | None:
    """Extract the 32-byte key factor from a stego cover (PNG or baseline JPEG),
    sniffing the format. Mirrors extractKeyFactorImage in src/ui/image-io.ts."""
    if image_bytes[:2] == b"\xff\xd8":  # JPEG
        return extract_key_factor_jpeg(image_bytes, password, iterations, memory_kib, parallelism)

    import io

    from PIL import Image

    with Image.open(io.BytesIO(image_bytes)) as img:
        rgba = img.convert("RGBA")
        width, height = rgba.size
        data = rgba.tobytes()
    return extract_key_factor(data, width, height, password, iterations, memory_kib, parallelism)
