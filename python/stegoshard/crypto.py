"""Crypto: Argon2id KEK derivation and AES-256-GCM — mirrors SPEC.md §5."""

from __future__ import annotations

import unicodedata

from argon2.low_level import ARGON2_VERSION, Type, hash_secret_raw
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .format import (
    IV_LEN,
    KeyBlock,
    REGION_COUNT,
    REGION_INDEX_OFF,
    SLOT_ARRAY_LEN,
    SLOT_COUNT,
    SLOT_PLAINTEXT_LEN,
    SLOT_SIZE,
)

DEK_LEN = 32
CONTENT_INFO = b"stegoshard/vault/content"
KEYFILE_KEK_INFO = b"stegoshard/v1/keyfile-kek"
SLOT_KEK_INFO = b"stegoshard/v1/slot-kek"
REGION_INFO_PREFIX = b"stegoshard/vault/region"


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


# --- Access structures (SPEC §10): slot KEK, region key, constant-work unlock --


def derive_slot_kek(
    password: str,
    vault_salt: bytes,
    key_factor: bytes | None,
    iterations: int,
    memory_kib: int,
    parallelism: int,
) -> bytes:
    """Slot-array KEK: Argon2id(password, vault_salt) run once, plus an OPTIONAL
    external key factor (keyfile/stego secret) mixed in via HKDF (SPEC §10.2-3).
    Argon2 params are NOT stored in the container — the caller supplies the frozen
    defaults (or test values)."""
    kek = derive_kek(password, vault_salt, iterations, memory_kib, parallelism)
    if not key_factor:
        return kek
    return HKDF(
        algorithm=hashes.SHA256(), length=DEK_LEN, salt=vault_salt, info=KEYFILE_KEK_INFO
    ).derive(kek + key_factor)


def gate_kek(base_kek: bytes, secret: bytes, vault_salt: bytes) -> bytes:
    """Gate a base KEK on threshold material (SPEC §10.6.2): HKDF-SHA256(base_kek ||
    secret, salt=vault_salt, info='stegoshard/v1/slot-kek'). HKDF, not XOR."""
    return HKDF(algorithm=hashes.SHA256(), length=DEK_LEN, salt=vault_salt, info=SLOT_KEK_INFO).derive(
        base_kek + secret
    )


def slot_kek_candidates(
    password: str,
    vault_salt: bytes,
    key_factor: bytes | None,
    secret: bytes | None,
    iterations: int,
    memory_kib: int,
    parallelism: int,
) -> list[bytes]:
    """Candidate slot KEKs, all from the SAME single Argon2id output (§10.6.2). The
    password-only KEK, plus — when a key factor is supplied — the factor-mixed KEK;
    each optionally gated on the recovered Shamir secret. BOTH bases are offered when
    a factor is present because a duress decoy slot (§10.9) is sealed WITHOUT the
    factor while the real slot is sealed WITH it, and restore presents the factor for
    either credential — so the no-factor base keeps the decoy openable even when the
    factor is present. The extra base matches nothing in plain/Mode B, and credential
    independence guarantees the real and decoy KEKs never both match."""
    kek_bytes = derive_kek(password, vault_salt, iterations, memory_kib, parallelism)
    bases = [kek_bytes]
    if key_factor:
        bases.append(
            HKDF(
                algorithm=hashes.SHA256(), length=DEK_LEN, salt=vault_salt, info=KEYFILE_KEK_INFO
            ).derive(kek_bytes + key_factor)
        )
    candidates: list[bytes] = []
    for base in bases:
        candidates.append(base)
        if secret:
            candidates.append(gate_kek(base, secret, vault_salt))
    return candidates


def derive_region_key(dek: bytes, salt: bytes, region_index: int) -> bytes:
    """Per-region content key from that region's INDEPENDENT DEK (SPEC §10.2)."""
    info = REGION_INFO_PREFIX + bytes([region_index])
    return HKDF(algorithm=hashes.SHA256(), length=DEK_LEN, salt=salt, info=info).derive(dek)


def try_open_slot(kek: bytes, slot: bytes) -> tuple[bytes, int] | None:
    """Try to open one 76-byte slot; None on any failure (wrong KEK or dead slot)."""
    if len(slot) != SLOT_SIZE:
        return None
    nonce, sealed = slot[:IV_LEN], slot[IV_LEN:]
    try:
        pt = AESGCM(kek).decrypt(nonce, sealed, None)
    except Exception:  # noqa: BLE001 - a bad tag just means "not this slot"
        return None
    if len(pt) != SLOT_PLAINTEXT_LEN:
        return None
    region_index = pt[REGION_INDEX_OFF]
    if region_index >= REGION_COUNT:
        return None
    return pt[:DEK_LEN], region_index


def open_slot_array(slot_array: bytes, keks: list[bytes]) -> tuple[bytes, int]:
    """Constant-work slot open (SPEC §10.4): try EVERY candidate KEK against EVERY
    slot with no early exit. Exactly one match is required; zero and >1 both raise
    the uniform WrongPasswordError, leaking nothing about which slot matched."""
    if len(slot_array) != SLOT_ARRAY_LEN:
        raise WrongPasswordError("wrong password")
    found: tuple[bytes, int] | None = None
    matches = 0
    for kek in keks:
        for i in range(SLOT_COUNT):
            opened = try_open_slot(kek, slot_array[i * SLOT_SIZE : (i + 1) * SLOT_SIZE])
            if opened is not None:
                matches += 1
                if found is None:
                    found = opened
    if matches != 1 or found is None:
        raise WrongPasswordError("wrong password")
    return found
