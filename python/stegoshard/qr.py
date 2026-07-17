"""Decode a QR image to its raw payload bytes.

Uses zxing-cpp, which returns the exact byte content of a byte-mode QR (unlike
some decoders that mangle binary data). Photos of printed pages are downscaled
first — full-resolution phone photos often fail to decode (see the extension's
image-io.ts for the same reasoning).
"""

from __future__ import annotations

import io

import zxingcpp
from PIL import Image

_MAX_SIDES = [1400, 1000, 1800]


def _downscale(img: Image.Image, max_side: int) -> Image.Image:
    w, h = img.size
    scale = min(1.0, max_side / max(w, h))
    if scale >= 1.0:
        return img
    return img.resize((max(1, round(w * scale)), max(1, round(h * scale))))


def _read(img: Image.Image) -> bytes | None:
    for result in zxingcpp.read_barcodes(img):
        if result.bytes:
            return bytes(result.bytes)
    return None


def decode_image(data: bytes) -> bytes | None:
    """Return the payload bytes for one image, or None if no QR is readable."""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    for max_side in _MAX_SIDES:
        found = _read(_downscale(img, max_side))
        if found is not None:
            return found
    return _read(img)
