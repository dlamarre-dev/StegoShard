"""Deniable stego key block extraction — mirrors src/core/stego.ts and SPEC §5.3.

Recovers the 92-byte key block hidden in the RGB least-significant bits of a
cover image, keyed by the password. Returns None when the password is wrong or
the image carries no key (deliberately indistinguishable).
"""

from __future__ import annotations

from argon2.low_level import ARGON2_VERSION, Type, hash_secret_raw
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from .crypto import normalize_password
from .format import KEY_BLOCK_VERSION, KEY_MAGIC

KEY_BLOCK_LEN = 92
PAYLOAD_BITS = KEY_BLOCK_LEN * 8
MIN_CAPACITY = PAYLOAD_BITS * 16

# Fixed application salt: ASCII "StegoShard-stego" (exactly 16 bytes) (SPEC §5.3).
STEGO_SALT = b"StegoShard-stego"


def _keystream(password: str, length: int, iterations: int, memory_kib: int, parallelism: int) -> bytes:
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
    # AES-256-CTR over zero bytes, counter starting at 0 (matches WebCrypto).
    encryptor = Cipher(algorithms.AES(seed), modes.CTR(b"\x00" * 16)).encryptor()
    return encryptor.update(b"\x00" * length) + encryptor.finalize()


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


def _stream_len() -> int:
    return KEY_BLOCK_LEN + PAYLOAD_BITS * 8 + 1024


def extract_key_block(
    rgba: bytes,
    width: int,
    height: int,
    password: str,
    iterations: int = 3,
    memory_kib: int = 64 * 1024,
    parallelism: int = 1,
) -> bytes | None:
    """Recover a stego-embedded key block, or None if absent / wrong password.

    `rgba` is the cover image as RGBA bytes (4 bytes/pixel).
    """
    capacity = width * height * 3
    if capacity < MIN_CAPACITY:
        return None

    stream = _keystream(password, _stream_len(), iterations, memory_kib, parallelism)
    pad = stream[:KEY_BLOCK_LEN]
    positions = _pick_positions(stream, KEY_BLOCK_LEN, capacity, PAYLOAD_BITS)

    out = bytearray(KEY_BLOCK_LEN)
    for i, pos in enumerate(positions):
        byte_index = (pos // 3) * 4 + (pos % 3)
        if rgba[byte_index] & 1:
            out[i >> 3] |= 1 << (7 - (i & 7))
    for j in range(KEY_BLOCK_LEN):
        out[j] ^= pad[j]

    result = bytes(out)
    if len(result) == KEY_BLOCK_LEN and result[:4] == KEY_MAGIC and result[4] == KEY_BLOCK_VERSION:
        return result
    return None


JPEG_MIN_CAPACITY = PAYLOAD_BITS * 2  # matches src/core/stego.ts


def extract_key_block_jpeg(
    jpeg_bytes: bytes,
    password: str,
    iterations: int = 3,
    memory_kib: int = 64 * 1024,
    parallelism: int = 1,
) -> bytes | None:
    """Recover a key block hidden in a baseline JPEG's DCT coefficients (SPEC §5.4).

    Mirrors src/core/stego.ts embedKeyBlockStegoJpeg: the carriers are the AC
    coefficients with |coef| >= 2, in scan order; the payload bit is the LSB of
    each coefficient's magnitude. Returns None for a wrong password, no key, or a
    non-baseline JPEG.
    """
    from .jpeg_coeff import JpegUnsupported, decode, eligible_coefficients

    try:
        carriers = eligible_coefficients(decode(jpeg_bytes))
    except JpegUnsupported:
        return None
    capacity = len(carriers)
    if capacity < JPEG_MIN_CAPACITY:
        return None

    stream = _keystream(password, _stream_len(), iterations, memory_kib, parallelism)
    pad = stream[:KEY_BLOCK_LEN]
    positions = _pick_positions(stream, KEY_BLOCK_LEN, capacity, PAYLOAD_BITS)

    out = bytearray(KEY_BLOCK_LEN)
    for i, pos in enumerate(positions):
        block, k = carriers[pos]
        if abs(block[k]) & 1:
            out[i >> 3] |= 1 << (7 - (i & 7))
    for j in range(KEY_BLOCK_LEN):
        out[j] ^= pad[j]

    result = bytes(out)
    if len(result) == KEY_BLOCK_LEN and result[:4] == KEY_MAGIC and result[4] == KEY_BLOCK_VERSION:
        return result
    return None


def extract_key_block_from_image(
    image_bytes: bytes,
    password: str,
    iterations: int = 3,
    memory_kib: int = 64 * 1024,
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
