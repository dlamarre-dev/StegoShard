"""The S1 reader recovers every message in tests/vectors/stc-vectors.json (SPEC §9.3.1).

An independent implementation of the syndrome and the keyed order: a bug the
TypeScript writer and reader share round-trips there, and fails here.
"""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib

import pytest
from stegoshard.stc import STC_HEIGHT, keyed_order, keyed_order_stream_len, stc_extract
from stegoshard.stego import _keystream_from_seed

VECTORS = json.loads(
    (pathlib.Path(__file__).parents[2] / "tests" / "vectors" / "stc-vectors.json").read_text()
)


def _bits(s: str) -> list[int]:
    return [1 if c == "1" else 0 for c in s]


def _xorshift_bits(seed: int, n: int) -> list[int]:
    s = seed & 0xFFFFFFFF
    out = []
    for _ in range(n):
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        out.append(s & 1)
    return out


def test_vectors_were_made_at_this_height() -> None:
    assert VECTORS["height"] == STC_HEIGHT


@pytest.mark.parametrize("case", VECTORS["small"], ids=lambda c: f"m={c['m']} w={c['w']}")
def test_small_syndromes(case: dict) -> None:
    assert stc_extract(_bits(case["y"]), case["m"], case["w"]) == _bits(case["message"])
    changes = sum(a != b for a, b in zip(_bits(case["x"]), _bits(case["y"]), strict=True))
    assert changes == case["changes"]


def test_gallery_sized_syndrome() -> None:
    large = VECTORS["large"]
    m, w = large["m"], large["w"]
    packed = base64.b64decode(large["y"])
    y = [(packed[i >> 3] >> (7 - (i & 7))) & 1 for i in range(m * w)]
    assert hashlib.sha256(bytes(y)).hexdigest() == large["ySha256"]
    assert stc_extract(y, m, w) == _xorshift_bits(large["messageSeed"], m)
    x = _xorshift_bits(large["xSeed"], m * w)
    assert sum(a != b for a, b in zip(x, y, strict=True)) == large["changes"]


@pytest.mark.parametrize("o", VECTORS["orders"], ids=lambda o: f"{o['n']} of {o['count']}")
def test_keyed_orders(o: dict) -> None:
    stream = _keystream_from_seed(bytes.fromhex(o["seed"]), keyed_order_stream_len(o["n"]))
    order = keyed_order(stream, o["count"], o["n"])
    assert order[:16] == o["first"]
    digest = hashlib.sha256(b"".join(v.to_bytes(4, "big") for v in order)).hexdigest()
    assert digest == o["sha256"]
