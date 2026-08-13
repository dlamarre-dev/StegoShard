"""A test for the test: does :func:`count_forgeries` still detect an accepted forgery?

``count_forgeries`` is the only thing standing between this suite and false
assurance. It exists because crypto-condor's ``invalid`` bucket cannot answer the
accept/reject question (two ``# FIXME: overly permissive`` branches upstream), and
it works by reaching into a per-vector debug record, ``info.data.ret_valid_tag``.

That is undocumented internal shape. If a future crypto-condor renames the field,
drops it, or restructures ``Results.data``, ``getattr(..., None)`` quietly returns
``None`` for every vector, every forgery is classified as "refused", and
``accepted`` is zero no matter what the implementation did. The security assertion
in ``test_aes_gcm.py`` would then pass forever without checking anything.

So the mechanism gets its own adversarial probe, run in CI rather than kept as a
note in a pull request: drive the real crypto-condor runner with a decryptor that
accepts every forgery, and require ``count_forgeries`` to say so.
"""

from __future__ import annotations

from crypto_condor.primitives import AES
from test_aes_gcm import count_forgeries

GCM = AES.Mode.GCM
AES256 = AES.KeyLength.AES256

#: CAVP marks this many AES-256-GCM decrypt vectors as "must be rejected".
CAVP_INVALID_VECTORS = 3919


def test_detects_a_decryptor_that_accepts_every_forgery() -> None:
    """The probe that the first version of this suite would have failed.

    A decryptor claiming ``valid_tag=True`` for every vector is the worst possible
    AEAD defect: no forgery is ever rejected. crypto-condor books all 3,919 of these
    as *passes* and reports ``invalid.failed == 0``, which is exactly what the
    original assertion checked, so it went green on this input.
    """

    def accepts_everything(key, ciphertext, *, iv=None, aad=None, mac=None, mac_len=0):
        return b"attacker-chosen plaintext", True

    results = AES.test_decrypt(accepts_everything, GCM, AES256, compliance=True, resilience=False)
    res = next(iter(results.values()))

    # First, pin the upstream behaviour this whole mechanism works around. If this
    # ever stops being true, crypto-condor has tightened its accounting and
    # count_forgeries may be able to retire.
    assert res.invalid.failed == 0, (
        "crypto-condor now reports a failure for accepted forgeries. Its `invalid` "
        "bucket may have become trustworthy; re-read the runner and consider "
        "simplifying count_forgeries."
    )

    accepted, rejected, refused = count_forgeries(res)
    assert accepted == CAVP_INVALID_VECTORS, (
        f"count_forgeries reported {accepted} accepted forgeries, expected "
        f"{CAVP_INVALID_VECTORS}. The debug-record shape it depends on has probably "
        "changed, which means the security assertion in test_aes_gcm.py is no longer "
        "checking anything."
    )
    assert (rejected, refused) == (0, 0), (
        f"expected every forgery to land in `accepted`, got rejected={rejected} refused={refused}"
    )


def test_detects_a_decryptor_that_rejects_everything() -> None:
    """The mirror case, so the counter cannot be passing by always saying "accepted".

    A decryptor that rejects every vector is wrong in the other direction (it fails
    the valid vectors), but every forgery must be counted as authenticated and
    rejected, never as refused.
    """

    def rejects_everything(key, ciphertext, *, iv=None, aad=None, mac=None, mac_len=0):
        return None, False

    results = AES.test_decrypt(rejects_everything, GCM, AES256, compliance=True, resilience=False)
    res = next(iter(results.values()))

    accepted, rejected, refused = count_forgeries(res)
    assert (accepted, rejected, refused) == (0, CAVP_INVALID_VECTORS, 0), (
        f"expected (0, {CAVP_INVALID_VECTORS}, 0), got {(accepted, rejected, refused)}"
    )


def test_counts_a_refusal_as_refused_not_as_rejected() -> None:
    """Raising before authenticating must not be credited as rejecting a forgery.

    This is the distinction that made the original "3,919 rejected per target"
    figure wrong: most invalid vectors never reach the crypto at all.
    """

    def refuses_everything(key, ciphertext, *, iv=None, aad=None, mac=None, mac_len=0):
        raise ValueError("outside the supported envelope")

    results = AES.test_decrypt(refuses_everything, GCM, AES256, compliance=True, resilience=False)
    res = next(iter(results.values()))

    accepted, rejected, refused = count_forgeries(res)
    assert (accepted, rejected, refused) == (0, 0, CAVP_INVALID_VECTORS), (
        f"expected (0, 0, {CAVP_INVALID_VECTORS}), got {(accepted, rejected, refused)}"
    )
