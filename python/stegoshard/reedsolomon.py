"""Systematic Reed-Solomon erasure coding over GF(2^8).

Mirrors src/core/reed-solomon.ts and SPEC.md §7: a `[ I_k ; Cauchy ]` generator
matrix (MDS), so the k data shards reconstruct from any k of the k+m shards.
"""

from __future__ import annotations

from .gf256 import gf_add, gf_div, gf_mul


def build_cauchy(k: int, m: int) -> list[list[int]]:
    if k < 1 or m < 0:
        raise ValueError("reed-solomon: k must be >=1, m >=0")
    if k + m > 256:
        raise ValueError("reed-solomon: k + m must be <= 256")
    rows: list[list[int]] = []
    for i in range(m):
        row = [gf_div(1, gf_add(i, m + j)) for j in range(k)]
        rows.append(row)
    return rows


def build_encoding_matrix(k: int, m: int) -> list[list[int]]:
    rows: list[list[int]] = []
    for i in range(k):
        row = [0] * k
        row[i] = 1
        rows.append(row)
    rows.extend(build_cauchy(k, m))
    return rows


def invert_matrix(matrix: list[list[int]]) -> list[list[int]]:
    n = len(matrix)
    a = [row[:] for row in matrix]
    inv = [[1 if i == j else 0 for j in range(n)] for i in range(n)]

    for col in range(n):
        pivot = col
        while pivot < n and a[pivot][col] == 0:
            pivot += 1
        if pivot == n:
            raise ValueError("reed-solomon: matrix is singular (not reconstructable)")
        if pivot != col:
            a[col], a[pivot] = a[pivot], a[col]
            inv[col], inv[pivot] = inv[pivot], inv[col]

        pv = a[col][col]
        for j in range(n):
            a[col][j] = gf_div(a[col][j], pv)
            inv[col][j] = gf_div(inv[col][j], pv)

        for row in range(n):
            if row == col:
                continue
            factor = a[row][col]
            if factor == 0:
                continue
            for j in range(n):
                a[row][j] ^= gf_mul(factor, a[col][j])
                inv[row][j] ^= gf_mul(factor, inv[col][j])
    return inv


def reconstruct_data(shards: list[bytes | None], k: int, m: int) -> list[bytes]:
    """Reconstruct the k data shards from any k (or more) surviving shards."""
    if len(shards) != k + m:
        raise ValueError(f"reed-solomon: expected {k + m} shard slots, got {len(shards)}")
    present = [i for i, s in enumerate(shards) if s is not None]
    if len(present) < k:
        raise ValueError(f"reed-solomon: only {len(present)} of {k} required shards present")

    shard_len = len(shards[present[0]])  # type: ignore[arg-type]
    use = present[:k]
    encoding = build_encoding_matrix(k, m)
    sub = [encoding[idx] for idx in use]
    decode_matrix = invert_matrix(sub)

    data: list[bytes] = []
    for t in range(k):
        out = bytearray(shard_len)
        row = decode_matrix[t]
        for s in range(k):
            coeff = row[s]
            if coeff == 0:
                continue
            shard = shards[use[s]]
            for b in range(shard_len):
                out[b] ^= gf_mul(coeff, shard[b])  # type: ignore[index]
        data.append(bytes(out))
    return data
