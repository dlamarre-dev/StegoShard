"""Crypto: Argon2id KEK derivation and AES-256-GCM — mirrors SPEC.md §5."""

from __future__ import annotations

import unicodedata

from argon2.low_level import ARGON2_VERSION, Type, hash_secret_raw
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .format import KeyBlock

DEK_LEN = 32
CONTENT_INFO = b"stegoshard/vault/content"


class WrongPasswordError(Exception):
    """Raised when the DEK cannot be unwrapped — almost always a wrong password."""


def normalize_password(password: str) -> str:
    """NFC-normalize the password before hashing (mirrors the extension, SPEC §5.1)."""
    return unicodedata.normalize("NFC", password)


def derive_kek(password: str, salt: bytes, iterations: int, memory_kib: int, parallelism: int) -> bytes:
    """Argon2id → 32-byte KEK. Version 0x13 matches the extension (hash-wasm)."""
    return hash_secret_raw(
        secret=normalize_password(password).encode("utf-8"),
        salt=salt,
        time_cost=iterations,
        memory_cost=memory_kib,
        parallelism=parallelism,
        hash_len=DEK_LEN,
        type=Type.ID,
        version=ARGON2_VERSION,  # 0x13 (19)
    )


def unwrap_dek(key_block: KeyBlock, password: str) -> bytes:
    """Recover the raw DEK from a key block and password."""
    kek = derive_kek(
        password, key_block.salt, key_block.iterations, key_block.memory_kib, key_block.parallelism
    )
    try:
        # WebCrypto AES-GCM output is ciphertext||tag, which AESGCM.decrypt expects.
        return AESGCM(kek).decrypt(key_block.iv, key_block.wrapped, None)
    except Exception as exc:  # noqa: BLE001 - normalize to a clear error
        raise WrongPasswordError("wrong password") from exc


def derive_content_key(dek: bytes, salt: bytes) -> bytes:
    """Per-export content key: HKDF-SHA256(DEK, salt=contentSalt, info=CONTENT_INFO).

    Mirrors crypto.deriveContentKey (SPEC §6): a fresh salt per export gives each
    vault its own content key even though the DEK is reused across vaults.
    """
    return HKDF(algorithm=hashes.SHA256(), length=DEK_LEN, salt=salt, info=CONTENT_INFO).derive(dek)


def decrypt_content(cek: bytes, iv: bytes, ciphertext: bytes) -> bytes:
    return AESGCM(cek).decrypt(iv, ciphertext, None)
