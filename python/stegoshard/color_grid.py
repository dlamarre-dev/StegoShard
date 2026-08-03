"""Decode an 8-colour grid image to its raw payload bytes (SPEC §2.2).

A byte-exact mirror of ``src/core/codec/color-grid.ts``, in the same spirit as
``format.py`` mirroring ``header.ts``. Deliberately dependency-free beyond
Pillow, which the reference decoder already needs: the whole point of this
implementation is that a StegoShard image stays readable with nothing but common
PyPI wheels, offline, years from now. CRC-32 comes from the standard library, and
Reed-Solomon reuses ``reedsolomon.py``.

The layout, in one paragraph. A square grid of ``n`` modules, each painted one of
eight colours (the RGB cube corners) and so worth three bits. Four 7x7 QR-style
bullseye finders sit at the corners, each with a one-module white separator on
its inner sides. A calibration run of the eight colours, in canonical order, sits
in the row just below the top-left finder box. Everything else carries data, read
column-major, packed MSB-first, split into 64-byte Reed-Solomon blocks each
followed by its CRC-32. Whatever sits between the payload and the end of the last
block is filler with no defined content — this decoder reads exactly the declared
payload length and ignores the rest. Nothing about the geometry is written into the image: the
finders give the module pitch, the pitch gives ``n``, and ``n`` selects the rest.
"""

from __future__ import annotations

import io
import zlib

from PIL import Image

from .reedsolomon import reconstruct_data

QUIET_ZONE = 4
FINDER = 7
FINDER_BOX = FINDER + 1
CAL_LEN = 8
CAL_ROW = FINDER_BOX
BLOCK_LEN = 64
CRC_LEN = 4
STORED_BLOCK = BLOCK_LEN + CRC_LEN
LEN_PREFIX = 4

# Value v -> (bit2 = R, bit1 = G, bit0 = B), each channel fully off or fully on.
PALETTE = [
    (0, 0, 0),
    (0, 0, 255),
    (0, 255, 0),
    (0, 255, 255),
    (255, 0, 0),
    (255, 0, 255),
    (255, 255, 0),
    (255, 255, 255),
]

# Per-profile geometry, frozen in SPEC.md §2.2: (grid size, parity percent).
GRIDS = [(128, 35), (168, 12)]


class Layout:
    """Block counts and capacity for a grid size. A pure function of ``n``."""

    __slots__ = ("n", "k", "m", "capacity")

    def __init__(self, n: int, parity_percent: int) -> None:
        data_modules = n * n - 4 * FINDER_BOX * FINDER_BOX - CAL_LEN
        storable = (data_modules * 3) // 8
        total_blocks = storable // STORED_BLOCK
        self.n = n
        self.m = -(-total_blocks * parity_percent // 100)  # ceil
        self.k = total_blocks - self.m
        self.capacity = self.k * BLOCK_LEN - LEN_PREFIX


def _is_reserved(n: int, x: int, y: int) -> bool:
    far = n - FINDER_BOX
    near_x = x < FINDER_BOX or x >= far
    if (y < FINDER_BOX or y >= far) and near_x:
        return True
    return y == CAL_ROW and x < CAL_LEN


def _data_module_order(n: int) -> list[tuple[int, int]]:
    """Data modules in storage order: column-major, so a block is a vertical stripe."""
    return [(x, y) for x in range(n) for y in range(n) if not _is_reserved(n, x, y)]


# --- finder detection ------------------------------------------------------


def _runs(dark: list[bool]) -> tuple[list[int], list[int], bool]:
    """Split a line of samples into alternating dark/light runs.

    Returns parallel start/length lists plus the parity of the first run: runs
    strictly alternate, so one flag gives the polarity of them all.
    """
    starts: list[int] = []
    lengths: list[int] = []
    if not dark:
        return starts, lengths, False
    first = dark[0]
    cur = first
    start = 0
    n = len(dark)
    for i in range(1, n + 1):
        d = (not cur) if i == n else dark[i]
        if d != cur:
            starts.append(start)
            lengths.append(i - start)
            start = i
            cur = d
    return starts, lengths, first


def _pattern_hits(dark: list[bool]) -> list[tuple[float, float]]:
    """Find the 1:1:3:1:1 dark-light-dark-light-dark runs; return (centre, unit).

    Rejecting an image that is not a color grid is the hot path — a restore feeds
    every image through here — so this avoids building a tuple per run window.
    """
    starts, lengths, first_dark = _runs(dark)
    hits: list[tuple[float, float]] = []
    for i in range(len(lengths) - 4):
        # Runs alternate, so the window is the right polarity iff it starts dark.
        if first_dark != (i % 2 == 0):
            continue
        a, b, c, d, e = lengths[i : i + 5]
        total = a + b + c + d + e
        unit = total / 7
        if unit < 1:
            continue
        # Half a module of slack per run absorbs resampling and JPEG ringing.
        slack = unit * 0.5 + 0.5
        if abs(a - unit) > slack or abs(b - unit) > slack:
            continue
        if abs(c - unit * 3) > slack:
            continue
        if abs(d - unit) > slack or abs(e - unit) > slack:
            continue
        hits.append((starts[i] + total / 2, unit))
    return hits


# More finder-like spots than any real symbol could contain. A color grid has
# exactly four; anything past this is noise, and giving up early keeps the
# clustering below from going quadratic on a megapixel photo.
MAX_CLUSTERS = 64


def _locate_finders(
    luma: list[int], width: int, height: int
) -> tuple[list[tuple[float, float]], float]:
    """Locate the four corner finders.

    Returns their centres as (x, y) pixels, plus the module pitch they imply —
    the pitch is what lets the caller pick the right grid size straight away
    instead of trying each one.
    """
    lo, hi = min(luma), max(luma)
    threshold = (lo + hi) >> 1

    units: list[float] = []
    columns: dict[int, list[tuple[float, float]]] = {}
    clusters: list[list[float]] = []  # [sum_x, sum_y, count]
    radius = max(4.0, min(width, height) / 100)

    for y in range(height):
        row = luma[y * width : (y + 1) * width]
        dark_row = [v < threshold for v in row]
        for centre, unit in _pattern_hits(dark_row):
            x = round(centre)
            if not 0 <= x < width:
                continue
            # A real finder shows the same signature vertically through its
            # centre, at the same pitch. Requiring both — and requiring them to
            # agree — keeps captions and brand text from posing as finders.
            if x not in columns:
                col = [luma[i * width + x] < threshold for i in range(height)]
                columns[x] = _pattern_hits(col)
            if not any(
                abs(cy - y) <= 2 and abs(cu - unit) <= unit * 0.25
                for cy, cu in columns[x]
            ):
                continue

            units.append(unit)
            # Each finder produces a candidate on every scanline crossing it;
            # collapse those into one point per finder as we go.
            for c in clusters:
                if abs(c[0] / c[2] - centre) < radius and abs(c[1] / c[2] - y) < radius:
                    c[0] += centre
                    c[1] += y
                    c[2] += 1
                    break
            else:
                if len(clusters) >= MAX_CLUSTERS:
                    raise ValueError("color-grid: no color grid found in image")
                clusters.append([centre, float(y), 1])

    if len(clusters) < 4:
        raise ValueError("color-grid: no color grid found in image")

    points = [(c[0] / c[2], c[1] / c[2]) for c in clusters]
    tl = min(points, key=lambda p: p[0] + p[1])
    br = max(points, key=lambda p: p[0] + p[1])
    tr = max(points, key=lambda p: p[0] - p[1])
    bl = min(points, key=lambda p: p[0] - p[1])
    units.sort()
    return [tl, tr, bl, br], (units[len(units) // 2] if units else 1.0)


# --- decoding --------------------------------------------------------------


def _sample_point(
    corners: list[tuple[float, float]], u: float, v: float
) -> tuple[float, float]:
    """Bilinear map from grid coordinates to pixels, anchored on the finders.

    Digital images are axis-aligned and at most uniformly rescaled, so this
    absorbs everything they do to us without needing a homography solve.
    """
    tl, tr, bl, br = corners
    top = (tl[0] + (tr[0] - tl[0]) * u, tl[1] + (tr[1] - tl[1]) * u)
    bot = (bl[0] + (br[0] - bl[0]) * u, bl[1] + (br[1] - bl[1]) * u)
    return (top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v)


def _rotate(n: int, x: int, y: int, turns: int) -> tuple[int, int]:
    turns &= 3
    if turns == 1:
        return n - 1 - y, x
    if turns == 2:
        return n - 1 - x, n - 1 - y
    if turns == 3:
        return y, n - 1 - x
    return x, y


class _Sampler:
    """Averages the central half of each module, to reject inter-module bleed."""

    def __init__(
        self,
        raw: bytes,
        width: int,
        height: int,
        corners: list[tuple[float, float]],
        n: int,
        half: float,
    ) -> None:
        self.raw = raw
        self.width = width
        self.height = height
        self.corners = corners
        self.n = n
        self.span = n - FINDER
        self.offsets = list(range(-int(half), int(half) + 1))

    def read(self, mx: int, my: int) -> tuple[float, float, float]:
        cx, cy = _sample_point(
            self.corners, (mx - 3) / self.span, (my - 3) / self.span
        )
        r = g = b = 0
        count = 0
        raw = self.raw
        for dy in self.offsets:
            py = round(cy + dy)
            if not 0 <= py < self.height:
                continue
            base = py * self.width
            for dx in self.offsets:
                pxx = round(cx + dx)
                if not 0 <= pxx < self.width:
                    continue
                i = (base + pxx) * 3
                r += raw[i]
                g += raw[i + 1]
                b += raw[i + 2]
                count += 1
        if count == 0:
            return (0.0, 0.0, 0.0)
        return (r / count, g / count, b / count)


def _nearest(rgb: tuple[float, float, float], refs: list[tuple[float, float, float]]) -> int:
    best, best_d = 0, float("inf")
    for v, ref in enumerate(refs):
        d = (rgb[0] - ref[0]) ** 2 + (rgb[1] - ref[1]) ** 2 + (rgb[2] - ref[2]) ** 2
        if d < best_d:
            best_d, best = d, v
    return best


def _read_blocks(
    sampler: _Sampler, lay: Layout, turns: int
) -> tuple[list[bytes | None], int]:
    """Read every stored block at one candidate rotation; CRC failures become None."""
    n = lay.n

    def read(x: int, y: int) -> tuple[float, float, float]:
        rx, ry = _rotate(n, x, y, turns)
        return sampler.read(rx, ry)

    # Calibrate against the palette run as *observed*, not as encoded. This is
    # what absorbs JPEG chroma shift, gamma and white-balance drift.
    refs = [read(v, CAL_ROW) for v in range(CAL_LEN)]

    total = (lay.k + lay.m) * STORED_BLOCK
    stored = bytearray(total)
    bit_limit = total * 8
    for i, (x, y) in enumerate(_data_module_order(n)):
        bit_at = i * 3
        if bit_at >= bit_limit:
            break
        v = _nearest(read(x, y), refs)
        for b in range(3):
            # The stream is rarely a whole number of modules; the last module
            # carries one or two real bits, the rest padding.
            bit = bit_at + b
            if bit < bit_limit and (v >> (2 - b)) & 1:
                stored[bit >> 3] |= 0x80 >> (bit & 7)

    blocks: list[bytes | None] = []
    good = 0
    for i in range(lay.k + lay.m):
        at = i * STORED_BLOCK
        block = bytes(stored[at : at + BLOCK_LEN])
        want = int.from_bytes(stored[at + BLOCK_LEN : at + STORED_BLOCK], "big")
        if zlib.crc32(block) == want:
            blocks.append(block)
            good += 1
        else:
            blocks.append(None)
    return blocks, good


def decode_pixels(img: Image.Image) -> bytes | None:
    """Decode an already-loaded RGB image, or None if no grid is readable."""
    width, height = img.size
    # `tobytes()` is the oldest, most stable pixel accessor Pillow has — packed
    # RGB, three bytes per pixel. `getdata()` is deprecated, and anything newer
    # would narrow the Pillow versions this decoder runs on.
    raw = img.tobytes()
    luma = [
        (raw[i] * 77 + raw[i + 1] * 150 + raw[i + 2] * 29) >> 8
        for i in range(0, len(raw), 3)
    ]

    try:
        corners, unit = _locate_finders(luma, width, height)
    except ValueError:
        return None
    tl, tr = corners[0], corners[1]
    span_px = ((tr[0] - tl[0]) ** 2 + (tr[1] - tl[1]) ** 2) ** 0.5

    # Neither the grid size nor the orientation is written anywhere. The finder
    # pitch gives a good estimate of the grid size, so try the closest match
    # first; the others stay as a fallback. Only the sampling repeats —
    # Reed-Solomon runs once.
    estimated = span_px / unit + FINDER
    ordered = sorted(GRIDS, key=lambda g: abs(g[0] - estimated))

    best: tuple[Layout, list[bytes | None], int] | None = None
    for n, parity in ordered:
        lay = Layout(n, parity)
        pitch = span_px / (lay.n - FINDER)
        if pitch < 1:
            continue
        sampler = _Sampler(raw, width, height, corners, lay.n, pitch / 4)
        for turns in range(4):
            blocks, good = _read_blocks(sampler, lay, turns)
            if best is None or good > best[2]:
                best = (lay, blocks, good)
            # Once enough blocks survive to reconstruct, another rotation cannot
            # help: the remaining candidates are only worth sampling while we
            # still cannot read the payload at all.
            if good >= lay.k:
                break
        if best is not None and best[2] >= best[0].k:
            break

    if best is None or best[2] < best[0].k:
        return None

    lay, blocks, _ = best
    try:
        data = reconstruct_data(blocks, lay.k, lay.m)
    except Exception:
        return None
    region = b"".join(data)
    length = int.from_bytes(region[:LEN_PREFIX], "big")
    if length > lay.capacity:
        return None
    return region[LEN_PREFIX : LEN_PREFIX + length]


def decode_image(data: bytes) -> bytes | None:
    """Return the payload bytes for one image, or None if no grid is readable."""
    return decode_pixels(Image.open(io.BytesIO(data)).convert("RGB"))


#: Alias used by the package's lazy export map.
decode_color_grid = decode_image
