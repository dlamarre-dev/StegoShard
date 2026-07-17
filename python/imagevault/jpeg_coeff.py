"""Pure-Python **baseline** JPEG entropy decoder → quantized DCT coefficients.

Read-only counterpart to src/core/jpeg-coeff.ts, used to extract a stego key
hidden in a JPEG's coefficients (SPEC §5.4). No libjpeg / native dependency, so
the reference decoder stays wheels-only. Baseline sequential Huffman (SOF0), 8-bit
only; progressive/arithmetic/missing-table files raise JpegUnsupported.
"""

from __future__ import annotations


class JpegUnsupported(Exception):
    """Raised when a JPEG is not plain baseline (progressive, arithmetic, …)."""


def _u16(b: bytes, o: int) -> int:
    return (b[o] << 8) | b[o + 1]


class _BitReader:
    """MSB-first bit reader over the entropy scan, with byte-unstuffing."""

    def __init__(self, data: bytes, pos: int) -> None:
        self.data = data
        self.pos = pos
        self.byte = 0
        self.bits = 0

    def _fill(self) -> None:
        if self.pos >= len(self.data):
            self.byte = 0xFF  # feed 1-bits past the end (JPEG pad convention)
            self.bits = 8
            return
        b = self.data[self.pos]
        self.pos += 1
        if b == 0xFF:
            nxt = self.data[self.pos] if self.pos < len(self.data) else 0xD9
            if nxt == 0x00:
                self.pos += 1  # stuffed FF00 → literal 0xFF
            else:
                b = 0xFF  # marker: feed 1-bits so an in-flight read completes
        self.byte = b
        self.bits = 8

    def read_bit(self) -> int:
        if self.bits == 0:
            self._fill()
        self.bits -= 1
        return (self.byte >> self.bits) & 1

    def read_bits(self, n: int) -> int:
        v = 0
        for _ in range(n):
            v = (v << 1) | self.read_bit()
        return v

    def align_restart(self) -> None:
        self.bits = 0
        while self.pos < len(self.data) and self.data[self.pos] != 0xFF:
            self.pos += 1
        if self.pos + 1 < len(self.data):
            self.pos += 2  # skip FF Dn


def _build_huff(counts: list[int], values: list[int]) -> dict[int, int]:
    """Canonical Huffman decode map: (length << 16) | code → symbol."""
    table: dict[int, int] = {}
    code = 0
    k = 0
    for length in range(1, 17):
        for _ in range(counts[length - 1]):
            table[(length << 16) | code] = values[k]
            k += 1
            code += 1
        code <<= 1
    return table


def _decode_sym(br: _BitReader, table: dict[int, int]) -> int:
    code = 0
    for length in range(1, 17):
        code = (code << 1) | br.read_bit()
        sym = table.get((length << 16) | code)
        if sym is not None:
            return sym
    raise JpegUnsupported("bad Huffman code in scan")


def _extend(v: int, n: int) -> int:
    return v - (1 << n) + 1 if v < (1 << (n - 1)) else v


class JpegModel:
    """Decoded baseline JPEG: per-component lists of 64-int coefficient blocks."""

    def __init__(self) -> None:
        self.width = 0
        self.height = 0
        # components: list of dicts {id, h, v, dc, ac, blocks: list[list[int]]}
        self.components: list[dict] = []


def decode(data: bytes) -> JpegModel:
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        raise JpegUnsupported("not a JPEG")
    dc_tables: dict[int, dict[int, int]] = {}
    ac_tables: dict[int, dict[int, int]] = {}
    frame: dict | None = None
    restart_interval = 0
    o = 2

    while o < len(data):
        if data[o] != 0xFF:
            raise JpegUnsupported("expected marker")
        marker = data[o + 1]
        o += 2
        if marker == 0xD9:  # EOI
            break
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            continue
        length = _u16(data, o)
        seg = o + 2
        seg_end = o + length

        if marker == 0xC0:  # SOF0 baseline
            if data[seg] != 8:
                raise JpegUnsupported("precision != 8")
            height = _u16(data, seg + 1)
            width = _u16(data, seg + 3)
            nf = data[seg + 5]
            comps = []
            for i in range(nf):
                p = seg + 6 + i * 3
                comps.append(
                    {"id": data[p], "h": data[p + 1] >> 4, "v": data[p + 1] & 15, "blocks": []}
                )
            frame = {"width": width, "height": height, "comps": comps}
        elif marker == 0xC2:
            raise JpegUnsupported("progressive (SOF2)")
        elif marker in (0xC9, 0xCB):
            raise JpegUnsupported("arithmetic coding")
        elif marker == 0xC4:  # DHT
            p = seg
            while p < seg_end:
                tc = data[p] >> 4
                th = data[p] & 15
                p += 1
                counts = list(data[p : p + 16])
                total = sum(counts)
                p += 16
                values = list(data[p : p + total])
                p += total
                table = _build_huff(counts, values)
                (dc_tables if tc == 0 else ac_tables)[th] = table
        elif marker == 0xDD:  # DRI
            restart_interval = _u16(data, seg)
        elif marker == 0xDA:  # SOS
            if frame is None:
                raise JpegUnsupported("SOS before SOF")
            ns = data[seg]
            for i in range(ns):
                cs = data[seg + 1 + i * 2]
                td = data[seg + 2 + i * 2] >> 4
                ta = data[seg + 2 + i * 2] & 15
                comp = next((c for c in frame["comps"] if c["id"] == cs), None)
                if comp is None:
                    raise JpegUnsupported("SOS component not in SOF")
                comp["dc"] = td
                comp["ac"] = ta
            _decode_scan(data, seg_end, frame, dc_tables, ac_tables, restart_interval)
            model = JpegModel()
            model.width = frame["width"]
            model.height = frame["height"]
            model.components = frame["comps"]
            return model
        o = seg_end
    raise JpegUnsupported("no scan found")


def _decode_scan(data, scan_start, frame, dc_tables, ac_tables, restart_interval) -> None:
    comps = frame["comps"]
    max_h = max(c["h"] for c in comps)
    max_v = max(c["v"] for c in comps)
    mcus_x = (frame["width"] + 8 * max_h - 1) // (8 * max_h)
    mcus_y = (frame["height"] + 8 * max_v - 1) // (8 * max_v)
    br = _BitReader(data, scan_start)
    pred = [0] * len(comps)
    mcu = 0
    for _my in range(mcus_y):
        for _mx in range(mcus_x):
            if restart_interval > 0 and mcu > 0 and mcu % restart_interval == 0:
                br.align_restart()
                pred = [0] * len(comps)
            for ci, comp in enumerate(comps):
                dc_t = dc_tables.get(comp["dc"])
                ac_t = ac_tables.get(comp["ac"])
                if dc_t is None or ac_t is None:
                    raise JpegUnsupported("missing Huffman table for scan")
                for _ in range(comp["h"] * comp["v"]):
                    block = [0] * 64
                    t = _decode_sym(br, dc_t)
                    diff = _extend(br.read_bits(t), t) if t else 0
                    pred[ci] += diff
                    block[0] = pred[ci]
                    k = 1
                    while k < 64:
                        rs = _decode_sym(br, ac_t)
                        r = rs >> 4
                        s = rs & 15
                        if s == 0:
                            if r == 15:
                                k += 16
                                continue
                            break
                        k += r
                        if k >= 64:
                            break
                        block[k] = _extend(br.read_bits(s), s)
                        k += 1
                    comp["blocks"].append(block)
            mcu += 1


def eligible_coefficients(model: JpegModel) -> list[tuple[list[int], int]]:
    """Ordered (block, k) refs of AC coefficients with |coef| ≥ 2 — the stego
    carriers, in the same order as src/core/jpeg-coeff.ts."""
    refs: list[tuple[list[int], int]] = []
    for comp in model.components:
        for block in comp["blocks"]:
            for k in range(1, 64):
                if abs(block[k]) >= 2:
                    refs.append((block, k))
    return refs
