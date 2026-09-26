"""Syndrome-trellis code extraction for embedding scheme S1; mirrors src/core/stc.ts.

Only the reader's half: the message is the syndrome H·y of the parities read at
the keyed carrier positions, which needs neither the costs nor the Viterbi pass
the writer runs (Filler, Judas and Fridrich, IEEE TIFS 2011). SPEC §9.3.1.
"""

from __future__ import annotations

STC_HEIGHT = 9
STC_WIDTH = 16

_STATES = 1 << STC_HEIGHT
_HALF = _STATES >> 1


def stc_submatrix(w: int) -> list[int]:
    """Ĥ for width `w`: xorshift32 from 0x53544331, h bits, first and last forced."""
    cols: list[int] = []
    s = 0x53544331
    for _ in range(w):
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        cols.append((s & (_STATES - 1)) | 1 | _HALF)
    return cols


def stc_extract(y: list[int] | bytes, m: int, w: int) -> list[int]:
    """The message H·y, one bit per entry, with H truncated below row m."""
    if len(y) != m * w:
        raise ValueError(f"stc: expected {m * w} parities, got {len(y)}")
    cols = stc_submatrix(w)
    out = [0] * m
    acc = 0
    idx = 0
    for i in range(m):
        rows = m - i
        mask = (1 << rows) - 1 if rows < STC_HEIGHT else _STATES - 1
        for j in range(w):
            if y[idx]:
                acc ^= cols[j] & mask
            idx += 1
        out[i] = acc & 1
        acc >>= 1
    return out


def keyed_order(stream: bytes, count: int, n: int) -> list[int]:
    """First `n` entries of a keyed partial Fisher-Yates permutation of range(count)."""
    if n > count:
        raise ValueError(f"stc: cannot order {n} of {count} carriers")
    order = list(range(count))
    o = 0
    for i in range(n):
        rng = count - i
        limit = (0x1_0000_0000 // rng) * rng
        while True:
            if o + 4 > len(stream):
                raise ValueError("stc: position keystream exhausted")
            r = int.from_bytes(stream[o : o + 4], "big")
            o += 4
            if r < limit:
                break
        j = i + r % rng
        order[i], order[j] = order[j], order[i]
    return order[:n]


def keyed_order_stream_len(n: int) -> int:
    return 4 * n + 65_536
