"""StegoShard reference decoder — a standalone implementation of the StegoShard
format (see SPEC.md), so a vault can be restored without the browser extension.

Public API (lazily imported so the pure modules — gf256, reedsolomon, format —
can be used without the crypto / QR dependencies installed):
    decode_vault(payloads, password, key_block=None) -> RestoredFile
    decode_image(data) -> bytes | None
"""

from __future__ import annotations

import importlib
from typing import Any

_LAZY = {
    "decode_vault": "pipeline",
    "decode_vault_binary": "pipeline",
    "RestoredFile": "pipeline",
    "MissingKeyError": "pipeline",
    "WrongPasswordError": "crypto",
    "decode_image": "qr",
    "extract_key_block": "stego",
    "extract_key_block_jpeg": "stego",
    "extract_key_block_from_image": "stego",
    "unwrap_binary": "binary_container",
    "wrap_binary": "binary_container",
}

__all__ = list(_LAZY)


def __getattr__(name: str) -> Any:
    module = _LAZY.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    return getattr(importlib.import_module(f".{module}", __name__), name)
