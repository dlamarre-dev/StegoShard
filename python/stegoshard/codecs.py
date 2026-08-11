"""Pick the right image codec for an image, and decode it (SPEC §2).

The per-image header lives *inside* the payload, so ``CODEC_ID`` cannot tell a
decoder which codec to use; it has to guess from the pixels. A qr-grid symbol is
pure greyscale; a color-grid symbol is mostly saturated. One cheap number
separates them, and either way both are tried, so a wrong guess only costs a
second attempt.

This mirrors ``decodeWithAnyCodec`` in ``src/core/codec/index.ts``.
"""

from __future__ import annotations

import io

from PIL import Image

from . import color_grid, qr

# Colour separation above which an image is more likely a color grid than a QR.
CHROMA_HINT = 24


def _mean_chroma(img: Image.Image) -> float:
    """Mean (max - min) channel spread over a sparse sample, on a 0..255 scale."""
    raw = img.tobytes()  # packed RGB, three bytes per pixel
    total_px = img.size[0] * img.size[1]
    step = max(1, total_px // 4096)
    total = 0
    count = 0
    for i in range(0, total_px * 3, step * 3):
        r, g, b = raw[i], raw[i + 1], raw[i + 2]
        total += max(r, g, b) - min(r, g, b)
        count += 1
    return total / count if count else 0.0


def decode_any(data: bytes) -> bytes | None:
    """Return the payload bytes for one image, whichever codec it uses."""
    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return None

    if _mean_chroma(img) >= CHROMA_HINT:
        return color_grid.decode_pixels(img) or qr.decode_image(data)
    return qr.decode_image(data) or color_grid.decode_pixels(img)
