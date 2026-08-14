"""The Cauchy erasure code of SPEC.md §7, against an independent linear algebra engine.

What was missing
----------------
``test_gf256_field.py`` anchored the *field*. Everything built on top of it stayed
self-referential: the Cauchy matrix, the Gauss-Jordan inversion and the MDS property
were checked only by encoding and decoding with the same code, which succeeds under any
invertible matrix, correct construction or not.

No Reed-Solomon library can close that gap. StegoShard uses a systematic Cauchy code
with ``x_i = i, y_j = m + j``; reedsolo is a BCH-view codec, and the matrix-based
libraries (Backblaze, klauspost, ISA-L, the Rust ``reed-solomon-erasure`` crate behind
the WASM packages) all build a Vandermonde reduced to systematic form, or a Cauchy with
a different x/y assignment. None of them emits these parity bytes.

What closes it is a different kind of tool. ``galois`` is not a codec that imposes its
own construction; it is linear algebra over finite fields. The formula from SPEC.md
§7.4 goes in, and an engine that is not ours computes the result.

What this establishes, and what it does not
-------------------------------------------
It establishes that three things agree: the specification, the two implementations, and
an independent algebra engine. Concretely, that the matrix built by
``build_cauchy``/``buildCauchyMatrix`` is the matrix the formula describes, that the
Gauss-Jordan inverter agrees with ``numpy`` over GF(2^8), that every k-subset really is
invertible, and that the frozen parity bytes follow from the formula.

It does not establish that the formula is a good design choice. Transcribing SPEC.md
§7.4 into ``cauchy_reference`` below is still a human act, and a specification that was
wrong in the same way as the code would pass. What has been removed is the possibility
of the two implementations sharing a transcription error, and of the arithmetic being
subtly wrong in a way that round-trips hide.
"""

from __future__ import annotations

import itertools
import json
from math import comb
from typing import Any

import numpy as np
import pytest
from conftest import REPO_ROOT

#: Above this many k-subsets the MDS check samples instead of enumerating. C(154, 135)
#: has 33 digits, so exhaustive is not a choice at the colour-grid layouts. The number
#: actually tested is printed by every test that uses this, because a silent cap reads
#: as full coverage.
MDS_EXHAUSTIVE_LIMIT = 5000

#: Fixed, so a failure is reproducible rather than a story about one unlucky night.
MDS_SAMPLE_SEED = 20260814

#: How many subsets to draw when enumeration is out of reach.
MDS_SAMPLES = 400


#: The (k, m) pairs the encoder really produces. `parityCount` is
#: max(ceil(k * 0.3), 2) (src/core/erasure.ts:12-18); the last two are the colour-grid
#: layouts from SPEC.md:155-161, which no other test in this repository touches.
def real_layouts() -> list[tuple[int, int]]:
    pairs = [(k, max(-(-k * 3 // 10), 2)) for k in range(1, 41)]
    return pairs + [(135, 19), (57, 31)]


def cauchy_reference(GF: Any, k: int, m: int) -> Any:
    """The Cauchy matrix as SPEC.md:465-466 defines it, built with galois.

    ``C[i][j] = 1 / (x_i XOR y_j)`` with ``x_i = i`` and ``y_j = m + j``. In GF(2^n)
    addition *is* XOR, so ``x + y`` here is the specification's ``x_i ⊕ y_j`` rather
    than a different operation that happens to look similar.
    """
    x = GF(np.arange(m, dtype=np.uint8).reshape(m, 1))
    y = GF(np.arange(m, m + k, dtype=np.uint8).reshape(1, k))
    return GF(np.ones((m, k), dtype=np.uint8)) / (x + y)


def encoding_reference(GF: Any, k: int, m: int) -> Any:
    """``G = [ I_k ; C ]``, SPEC.md:461-463."""
    return np.vstack([GF.Identity(k), cauchy_reference(GF, k, m)])


def py_rs() -> Any:
    from stegoshard import reedsolomon

    return reedsolomon


def as_array(rows: list[list[int]]) -> np.ndarray:
    return np.array(rows, dtype=np.uint8)


# --------------------------------------------------------------------------
# The matrix
# --------------------------------------------------------------------------


def test_cauchy_matrix_matches_the_specification(GF: Any) -> None:
    """Every layout the encoder can produce, against the formula."""
    rs = py_rs()
    bad = []
    for k, m in real_layouts():
        ref = np.array(cauchy_reference(GF, k, m), dtype=np.uint8)
        ours = as_array(rs.build_cauchy(k, m))
        if ours.shape != ref.shape or not (ours == ref).all():
            bad.append(f"k={k} m={m}")
    print(f"\n  {len(real_layouts())} layouts compared, including 135+19 and 57+31")
    assert not bad, (
        "the Cauchy matrix no longer matches SPEC.md §7.4 at: "
        + ", ".join(bad)
        + ". Every artifact already produced depends on this matrix; fix the "
        "implementation, or the specification if the specification is what changed."
    )


def test_encoding_matrix_is_systematic_and_correct(GF: Any) -> None:
    """G = [I_k ; C]. The identity half is what makes shards 0..k-1 the data itself."""
    rs = py_rs()
    for k, m in [(1, 2), (4, 3), (10, 3), (135, 19)]:
        ref = np.array(encoding_reference(GF, k, m), dtype=np.uint8)
        ours = as_array(rs.build_encoding_matrix(k, m))
        assert (ours == ref).all(), f"k={k} m={m}: generator matrix differs from the formula"
        assert (ours[:k] == np.eye(k, dtype=np.uint8)).all(), (
            f"k={k} m={m}: the top block is no longer the identity, so output shards "
            "0..k-1 would stop being the data shards verbatim"
        )


# --------------------------------------------------------------------------
# The inversion
# --------------------------------------------------------------------------


def test_gauss_jordan_matches_numpy(GF: Any) -> None:
    """The hand-written inverter against numpy's, over the same field.

    Reconstruction is a matrix inversion followed by a product. If the inverter were
    wrong in a way that round-trips still tolerated, every restore would be wrong in
    the same way and nothing in this repository would have said so.
    """
    rs = py_rs()
    checked = 0
    for k, m in [(4, 3), (10, 3), (20, 6)]:
        g = encoding_reference(GF, k, m)
        for idx in itertools.islice(itertools.combinations(range(k + m), k), 60):
            sub = g[list(idx), :]
            ours = as_array(rs.invert_matrix([[int(v) for v in sub[r]] for r in range(k)]))
            ref = np.array(np.linalg.inv(sub), dtype=np.uint8)
            assert (ours == ref).all(), f"k={k} m={m} subset {idx}: inverses differ"
            checked += 1
    print(f"\n  {checked} submatrices inverted both ways")


# --------------------------------------------------------------------------
# The MDS property
# --------------------------------------------------------------------------


def test_every_k_subset_is_invertible(GF: Any) -> None:
    """MDS: any k of the k+m shards must reconstruct.

    This is the assumption every recovery rests on, and until now nothing checked it
    beyond one layout (k=4, m=3) in reed-solomon.test.ts. Exhaustive where the subset
    count allows, sampled with a fixed seed where it does not, and the split is printed
    rather than left implicit: reporting a sample as if it were a proof is the failure
    this suite exists to refuse.
    """
    rng = np.random.default_rng(MDS_SAMPLE_SEED)
    exhaustive = sampled = 0
    for k, m in real_layouts():
        n = k + m
        total = comb(n, k)
        g = encoding_reference(GF, k, m)
        if total <= MDS_EXHAUSTIVE_LIMIT:
            subsets = list(itertools.combinations(range(n), k))
            exhaustive += 1
        else:
            subsets = [tuple(rng.choice(n, size=k, replace=False)) for _ in range(MDS_SAMPLES)]
            sampled += 1
        for idx in subsets:
            rank = np.linalg.matrix_rank(g[list(idx), :])
            assert rank == k, (
                f"k={k} m={m}: the submatrix for shards {sorted(idx)} has rank {rank}, "
                f"not {k}. That set of survivors cannot reconstruct, so the MDS property "
                "the format depends on no longer holds."
            )
    print(
        f"\n  {exhaustive} layouts checked exhaustively, "
        f"{sampled} sampled at {MDS_SAMPLES} subsets each "
        f"(threshold {MDS_EXHAUSTIVE_LIMIT} subsets)"
    )


# --------------------------------------------------------------------------
# The frozen parity bytes
# --------------------------------------------------------------------------


@pytest.fixture(scope="module")
def rs_vectors() -> list[dict[str, Any]]:
    path = REPO_ROOT / "tests" / "vectors" / "crypto-vectors.json"
    return json.loads(path.read_text(encoding="utf-8"))["reedSolomon"]


def test_frozen_parity_follows_from_the_formula(GF: Any, rs_vectors: list[dict[str, Any]]) -> None:
    """The committed parity, recomputed by an engine that is not ours.

    The TypeScript suite reproduces these bytes with the encoder that produced them and
    the Python suite reconstructs from them, which together prove the two stacks agree.
    They agreed before. This is the assertion that makes the file evidence rather than a
    snapshot.
    """
    assert rs_vectors, "the reedSolomon vector set is empty"
    for case in rs_vectors:
        k, m = case["k"], case["m"]
        data = GF(np.array([list(bytes.fromhex(h)) for h in case["dataHex"]], dtype=np.uint8))
        expected = np.array([list(bytes.fromhex(h)) for h in case["parityHex"]], dtype=np.uint8)
        got = np.array(cauchy_reference(GF, k, m) @ data, dtype=np.uint8)
        print(f"\n  {case['name']:18} k={k:2} m={m} shardLen={case['shardLen']}")
        assert got.shape == expected.shape and (got == expected).all(), (
            f"{case['name']}: the frozen parity no longer follows from the SPEC.md §7.4 "
            "formula. Either the encoder changed or the vectors were regenerated from a "
            "changed encoder; verify by hand before touching this file."
        )


def test_vector_set_covers_the_min_parity_floor(rs_vectors: list[dict[str, Any]]) -> None:
    """k=1 must be present.

    It is the degenerate layout, the one where MIN_PARITY does the work, and the one
    where an off-by-one in the y_j assignment is least likely to show up elsewhere.
    """
    assert any(c["k"] == 1 for c in rs_vectors), (
        "no k=1 case in the frozen vectors. That is the MIN_PARITY floor "
        "(src/core/erasure.ts:12-18) and it must stay covered."
    )
    assert len(rs_vectors) == 3, (
        f"{len(rs_vectors)} frozen Reed-Solomon cases, expected 3. Drift in either "
        "direction should fail loudly: a set that quietly shrank would still be green."
    )
