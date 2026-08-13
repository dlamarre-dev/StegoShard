"""AES-256-GCM against NIST CAVP and Wycheproof, through crypto-condor.

Why this exists
---------------
``docs/CRYPTO-REVIEW.md`` rested its "validated against a third party, not just the
two implementations agreeing with each other" claim on **two** vectors
(McGrew-Viega 13/14). Two vectors do not break a correlated-error argument: both
stacks were written from one specification by similar means, so they can share a
misreading of it. crypto-condor brings the full CAVP GCM-256 set (7,875 vectors
per direction) plus Wycheproof's adversarial cases, which is what actually catches
a misused binding.

Four targets, two per stack
---------------------------
- **platform** - WebCrypto (Node) and OpenSSL (``cryptography``) driven directly.
  Validates the primitive both stacks depend on.
- **framing** - this project's own ``aeadSeal``/``aeadOpen``. Validates our nonce
  handling and the ``ciphertext || tag`` layout. A defect of *ours* lives here.

What the numbers mean
---------------------
crypto-condor sorts every vector into three buckets, each with a passed/failed
count:

- ``valid``      - the operation should succeed and match.
- ``invalid``    - the operation should be **rejected** (forged tag, wrong AAD).
- ``acceptable`` - either answer is defensible, typically unusual IV sizes.

``valid.failed`` is not zero here, and that is expected. It counts vectors the
binding refuses outright:

- **8-bit IVs** (2,625 of CAVP). Node answers ``OperationError``; ``cryptography``
  and PyCryptodome raise "Nonce must be between 8 and 128 bytes". Short GCM nonces
  are a known weakness and every mainstream binding declines them by policy.
- **Very long IVs** (1 Wycheproof vector, "long IV size").
- **Truncated tags**, for the Python decrypt target: ``cryptography``'s ``AESGCM``
  has no tag-length parameter and always expects a full 16-byte tag.
- **Everything outside the framing envelope**, for the two framing targets:
  ``aeadSeal``/``aeadOpen`` pin the nonce at 12 bytes and the tag at 128 bits, so
  only 375 of the 7,875 CAVP vectors are reachable through them. That number is
  measured here rather than assumed, because a filter that silently swallowed the
  whole set would otherwise look like a pass.

StegoShard pins ``IV_LEN = 12`` and uses WebCrypto's default 128-bit tag
everywhere, so none of the refused classes is reachable in the product.

The assertions
--------------
1. **No forged tag was accepted**, for every decrypt target. This is the
   security-critical direction and it is checked by reading ``ret_valid_tag`` back
   out of each vector's debug record, not by trusting crypto-condor's ``invalid``
   bucket. See :func:`count_forgeries`: that bucket carries two
   ``# FIXME: overly permissive`` branches upstream, and a decryptor that accepts
   every forgery still reports ``invalid.failed == 0`` through it. The first
   version of this file asserted exactly that and would have passed a decryptor
   which verified all 3,919 CAVP forgeries.
2. **How many forgeries each target actually authenticated**, frozen in
   :data:`FORGERIES`. Distinguishing "rejected after authenticating" from "declined
   before authenticating" matters: 3,919 CAVP vectors are marked invalid, but only
   2,601 reach WebCrypto and only 33 reach the decoder's ``decrypt_content``. A
   drop in that first number weakens the test while leaving it green, so it is
   asserted rather than reported.
3. The full bucket table matches :data:`EXPECTED`. Freezing the counts follows the
   same philosophy as ``tests/vectors/crypto-vectors.json``: the committed numbers
   are the contract, and any drift - in crypto-condor's vectors, in Node, or in
   OpenSSL - fails loudly so a human looks at it.
"""

from __future__ import annotations

from collections.abc import Callable

from _bridge import Bridge, BridgeRefused
from crypto_condor.primitives import AES
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

GCM = AES.Mode.GCM
AES256 = AES.KeyLength.AES256

#: StegoShard's AEAD helpers accept exactly this envelope. Mirrors ``IV_LEN`` and
#: WebCrypto's default tag length in ``src/core/crypto.ts``.
FRAMING_IV_LEN = 12
FRAMING_TAG_LEN = 16

#: ``(valid.passed, valid.failed, invalid.passed, acceptable.passed, acceptable.failed)``
#: measured against crypto-condor 2025.9.8, Node 22, and OpenSSL via cryptography 43.
#: ``invalid.failed`` is deliberately absent from this tuple: crypto-condor's own
#: invalid bucket is not trustworthy for the accept/reject question, so the forgery
#: check lives in :func:`count_forgeries` and :data:`FORGERIES` instead.
EXPECTED: dict[str, tuple[int, int, int, int, int]] = {
    "ts-platform-encrypt/cavp": (5250, 2625, 0, 0, 0),
    "ts-platform-encrypt/wycheproof": (45, 1, 29, 0, 10),
    "ts-platform-decrypt/cavp": (2649, 1307, 3919, 0, 0),
    "ts-platform-decrypt/wycheproof": (45, 1, 29, 0, 10),
    "ts-framing-encrypt/cavp": (375, 7500, 0, 0, 0),
    "ts-framing-encrypt/wycheproof": (21, 25, 29, 0, 10),
    "ts-framing-decrypt/cavp": (184, 3772, 3919, 0, 0),
    "ts-framing-decrypt/wycheproof": (21, 25, 29, 0, 10),
    "py-platform-encrypt/cavp": (5250, 2625, 0, 0, 0),
    "py-platform-encrypt/wycheproof": (45, 1, 29, 2, 8),
    "py-platform-decrypt/cavp": (372, 3584, 3919, 0, 0),
    "py-platform-decrypt/wycheproof": (45, 1, 29, 2, 8),
    "py-framing-decrypt/cavp": (42, 3914, 3919, 0, 0),
    "py-framing-decrypt/wycheproof": (12, 34, 29, 0, 10),
}

#: Forgery accounting for the decrypt targets, as
#: ``(authenticated_and_rejected, structurally_refused)``. See
#: :func:`count_forgeries` for why crypto-condor's own ``invalid`` bucket cannot
#: supply these numbers.
FORGERIES: dict[str, tuple[int, int]] = {
    "ts-platform-decrypt/cavp": (2601, 1318),
    "ts-platform-decrypt/wycheproof": (27, 2),
    "ts-framing-decrypt/cavp": (191, 3728),
    "ts-framing-decrypt/wycheproof": (27, 2),
    "py-platform-decrypt/cavp": (378, 3541),
    "py-platform-decrypt/wycheproof": (27, 2),
    "py-framing-decrypt/cavp": (33, 3886),
    "py-framing-decrypt/wycheproof": (27, 2),
}

SOURCES = (("cavp", True, False), ("wycheproof", False, True))


def count_forgeries(res) -> tuple[int, int, int]:
    """Classify every "must be rejected" vector by what the target actually said.

    crypto-condor's ``invalid`` bucket cannot be used for this. Its runner carries
    two ``# FIXME: overly permissive`` branches: an exception on an invalid vector
    is booked as a pass, and the accept/reject decision is folded into
    ``is_same_pt and is_valid_tag``, so a decryptor that returns the *wrong*
    plaintext while claiming ``valid_tag=True`` also lands in the pass column. A
    deliberately broken decryptor that accepts every forgery therefore reports
    ``invalid.failed == 0``, which is what the first version of this file asserted.

    Reading ``ret_valid_tag`` back out of the per-vector debug record avoids all of
    that: it is what the implementation itself returned.

    Returns:
        ``(accepted, rejected, refused)``: forgeries wrongly accepted, forgeries
        authenticated and correctly rejected, and vectors the target declined
        before any authentication happened.
    """
    accepted = rejected = refused = 0
    for info in res.data.values():
        if str(info.type) != "invalid":
            continue
        tag = getattr(info.data, "ret_valid_tag", None) if info.data is not None else None
        if tag is True:
            accepted += 1
        elif tag is False:
            rejected += 1
        else:
            refused += 1
    return accepted, rejected, refused


def run(label: str, fn: Callable, direction: str) -> None:
    """Drive one target over both vector sources and check every invariant."""
    runner = AES.test_encrypt if direction == "encrypt" else AES.test_decrypt
    for source, compliance, resilience in SOURCES:
        key = f"{label}/{source}"
        results = runner(fn, GCM, AES256, compliance=compliance, resilience=resilience)
        assert len(results) == 1, f"{key}: expected one result set, got {len(results)}"
        res = next(iter(results.values()))

        if direction == "decrypt":
            accepted, rejected, refused = count_forgeries(res)
            assert accepted == 0, (
                f"{key}: {accepted} forged tag(s) were ACCEPTED. The implementation "
                "returned valid_tag=True for a vector that must be rejected. Treat this "
                "as a security defect, not a drift."
            )
            print(f"\n  {key}: forgeries rejected={rejected} refused={refused}")
            assert (rejected, refused) == FORGERIES[key], (
                f"{key}: forgery accounting moved.\n"
                f"  expected (rejected, refused) = {FORGERIES[key]}\n"
                f"  got                          = {(rejected, refused)}\n"
                "A drop in `rejected` means fewer forgeries are actually being "
                "authenticated, which weakens this test even when it stays green."
            )

        got = (
            res.valid.passed,
            res.valid.failed,
            res.invalid.passed,
            res.acceptable.passed,
            res.acceptable.failed,
        )
        print(f"  {key}: valid={got[0]}/{got[0] + got[1]}")
        assert got == EXPECTED[key], (
            f"{key}: bucket counts moved.\n"
            f"  expected (valid.passed, valid.failed, invalid.passed, acc.passed, acc.failed)\n"
            f"         = {EXPECTED[key]}\n"
            f"  got      = {got}\n"
            "If crypto-condor, Node, or OpenSSL changed, verify the new numbers by hand "
            "and update EXPECTED in this file."
        )


# --------------------------------------------------------------------------- #
# TypeScript, platform layer (WebCrypto)
# --------------------------------------------------------------------------- #


def test_typescript_platform_encrypt(bridge: Bridge) -> None:
    """WebCrypto's AES-256-GCM encryption, as Node exposes it."""

    def encrypt(key, plaintext, *, iv=None, aad=None, mac_len=0):
        r = bridge.call(
            "gcm.encrypt",
            key=key.hex(),
            pt=plaintext.hex(),
            iv=(iv or b"").hex(),
            aad=(aad or b"").hex(),
            tagBits=(mac_len or FRAMING_TAG_LEN) * 8,
        )
        return bytes.fromhex(r["ct"]), bytes.fromhex(r["tag"])

    run("ts-platform-encrypt", encrypt, "encrypt")


def test_typescript_platform_decrypt(bridge: Bridge) -> None:
    """WebCrypto's AES-256-GCM decryption, including tag rejection."""

    def decrypt(key, ciphertext, *, iv=None, aad=None, mac=None, mac_len=0):
        try:
            r = bridge.call(
                "gcm.decrypt",
                key=key.hex(),
                ct=ciphertext.hex(),
                tag=(mac or b"").hex(),
                iv=(iv or b"").hex(),
                aad=(aad or b"").hex(),
                tagBits=(len(mac) if mac else mac_len or FRAMING_TAG_LEN) * 8,
            )
        except BridgeRefused as e:
            # A rejected tag is the *correct* answer for an invalid vector. A nonce
            # the binding declines outright is a different thing, and re-raising
            # lets crypto-condor book it as a valid-bucket failure.
            if "OperationError" in str(e) and iv is not None and 8 <= len(iv) <= 128:
                return None, False
            raise
        return bytes.fromhex(r["pt"]), True

    run("ts-platform-decrypt", decrypt, "decrypt")


# --------------------------------------------------------------------------- #
# TypeScript, our framing (aeadSeal / aeadOpen)
# --------------------------------------------------------------------------- #


def test_typescript_framing_encrypt(bridge: Bridge) -> None:
    """``aeadSeal`` over the slice of CAVP that fits its envelope (375 vectors)."""

    def encrypt(key, plaintext, *, iv=None, aad=None, mac_len=0):
        if not iv or len(iv) != FRAMING_IV_LEN or (mac_len or FRAMING_TAG_LEN) != FRAMING_TAG_LEN:
            raise ValueError("outside the aeadSeal envelope (12-byte nonce, 128-bit tag)")
        r = bridge.call(
            "stego.seal",
            key=key.hex(),
            nonce=iv.hex(),
            pt=plaintext.hex(),
            aad=(aad or b"").hex(),
        )
        return bytes.fromhex(r["ct"]), bytes.fromhex(r["tag"])

    run("ts-framing-encrypt", encrypt, "encrypt")


def test_typescript_framing_decrypt(bridge: Bridge) -> None:
    """``aeadOpen``: same envelope, and it must still reject every forged tag."""

    def decrypt(key, ciphertext, *, iv=None, aad=None, mac=None, mac_len=0):
        tag_len = len(mac) if mac else mac_len
        if not iv or len(iv) != FRAMING_IV_LEN or tag_len != FRAMING_TAG_LEN:
            raise ValueError("outside the aeadOpen envelope (12-byte nonce, 128-bit tag)")
        try:
            r = bridge.call(
                "stego.open",
                key=key.hex(),
                nonce=iv.hex(),
                ct=ciphertext.hex(),
                tag=mac.hex(),
                aad=(aad or b"").hex(),
            )
        except BridgeRefused as e:
            if "OperationError" in str(e):
                return None, False
            raise
        return bytes.fromhex(r["pt"]), True

    run("ts-framing-decrypt", decrypt, "decrypt")


# --------------------------------------------------------------------------- #
# Python, platform layer (OpenSSL via `cryptography`)
# --------------------------------------------------------------------------- #


def test_python_platform_encrypt() -> None:
    """The decoder's AES-GCM stack, which independent recovery relies on."""

    def encrypt(key, plaintext, *, iv=None, aad=None, mac_len=0):
        out = AESGCM(key).encrypt(iv, plaintext, aad)
        return out[:-FRAMING_TAG_LEN], out[-FRAMING_TAG_LEN:][: (mac_len or FRAMING_TAG_LEN)]

    run("py-platform-encrypt", encrypt, "encrypt")


def test_python_platform_decrypt() -> None:
    """Same stack, decryption, including tag rejection."""

    def decrypt(key, ciphertext, *, iv=None, aad=None, mac=None, mac_len=0):
        if mac is None or len(mac) != FRAMING_TAG_LEN:
            # `cryptography`'s AESGCM has no tag-length parameter: it always expects
            # a full 16-byte tag, so truncated-tag vectors are unreachable here.
            raise ValueError("cryptography.AESGCM cannot verify a truncated tag")
        try:
            return AESGCM(key).decrypt(iv, ciphertext + mac, aad), True
        except InvalidTag:
            # Note: InvalidTag does not subclass ValueError, so it needs its own
            # clause. This is the right answer for an invalid vector.
            return None, False

    run("py-platform-decrypt", decrypt, "decrypt")


# --------------------------------------------------------------------------- #
# Python, the decoder's own framing (decrypt_content)
# --------------------------------------------------------------------------- #


def test_python_framing_decrypt() -> None:
    """``stegoshard.crypto.decrypt_content``, the decoder's actual entry point.

    The mirror of ``ts-framing-decrypt``: it is the decoder's own wrapper that an
    independent recovery runs, not the raw binding underneath it. Its envelope is
    tighter still, because it hard-codes ``aad=None``, so only empty-AAD vectors
    with a 12-byte IV and a full tag are reachable.
    """
    from stegoshard.crypto import decrypt_content

    def decrypt(key, ciphertext, *, iv=None, aad=None, mac=None, mac_len=0):
        if not iv or len(iv) != FRAMING_IV_LEN or mac is None or len(mac) != FRAMING_TAG_LEN:
            raise ValueError("outside the decrypt_content envelope")
        if aad:
            raise ValueError("decrypt_content passes aad=None")
        try:
            return decrypt_content(key, iv, ciphertext + mac), True
        except InvalidTag:
            return None, False

    run("py-framing-decrypt", decrypt, "decrypt")
