# Why StegoShard?

This is not a specification. It is the story of a problem, and why StegoShard is shaped
the way it is. If you want the format, read [SPEC.md](../SPEC.md); if you want the
guarantees and their limits, read the [threat model](THREAT-MODEL.md).

## The problem: small secrets that must outlive everything

Some secrets are tiny but irreplaceable: a wallet seed phrase, an age/PGP private key, a
password-manager export, the recovery codes for your accounts, a handful of `.env` files.
They share three awkward properties:

1. **They must survive for years**, across dead laptops, rotated cloud accounts, bit-rot,
   and the day you can no longer log in to the service that held them.
2. **They are catastrophic to lose**: there is no "forgot password" for a seed phrase.
3. **Sometimes their very existence is sensitive**: at a border, under duress, or on a
   shared machine, the safest secret is one nobody knows is there.

No single mainstream tool serves all three at once. That is not an accident; it is a
consequence of how the tools are built.

## Why the usual answers fall short

**Password managers** are excellent custodians while you are logged in, but they are a
_single system you must keep trusting_: one account, one vendor, one recovery path. They
don't give you an offline artifact you can print and put in a safe, and they make no
attempt to hide that a vault exists; that is not their job.

**Classic encrypted backups** (an encrypted archive, a LUKS volume, an age file) solve
durability and confidentiality, but the ciphertext is _conspicuously a secret_. A blob of
high-entropy bytes named `backup.age` announces "something valuable is encrypted here."
That is fine against a thief and useless against anyone who can **compel** you to hand it
over, the existence of the secret is undeniable.

**Classic steganography** hides the existence of data beautifully, until the carrier is
touched. Re-encode the image, upload it to a social network, print and re-scan it, and the
hidden payload is gone. Steganographic tools optimize for _undetectability_, which is
fundamentally at odds with _surviving transformation_.

## The insight: two goals that cannot be maximized together

Line those failures up and a pattern appears. There are **two properties** you might want
from a carrier, and they pull in opposite directions:

- **Resilience.** Survive loss, recompression, printing, and the death of any one copy.
  Achieving it means adding redundancy and structure, which makes the carrier _look like_
  what it is.
- **Deniability.** Hide that the secret exists at all. Achieving it means blending into
  ordinary-looking data, which is fragile: the moment the carrier is normalized (a social
  network re-encodes your photo), the hidden bits die.

The more you have of one, the less you can have of the other. Any tool that claims "the
best of both worlds" is either overselling or hiding a caveat.

## What StegoShard does about it

Instead of pretending the trade-off away, StegoShard **names it and hands you the
choice**: two storage models plus a bridge:

- **🛡 Resilient Storage.** Encrypt, then spread the secret across error-corrected images
  (or one opaque file) that survive recompression, printing, and cloud storage. Openly
  artificial. Optimized for _never losing the data_.
- **🎭 Deniable Storage.** Hide a small secret inside ordinary-looking photos, or wrap it
  as a decoy database. Optimized for _nobody knowing it exists_. Fragile by design.
- **🔗 Hybrid.** Store the encrypted archive resiliently, and hide **only the recovery
  key** in an everyday photo. The bulky, robust part survives anything; the deniable part
  is a small, expendable key. Lose the photo and you've lost the key, not the data, and
  the key channel was never meant to survive a social network anyway.

Seen this way, StegoShard is less a single feature and more a small **taxonomy of
cryptographic carriers**: two incompatible properties, every carrier a compromise between
them, and three concrete strategies that let _you_ decide which compromise your secret
needs. The honest limits of each are written down in the [threat model](THREAT-MODEL.md),
because a tool that hides its caveats is exactly the kind of tool this project is a
reaction against.

## Further reading

- [README](../README.md): the two models at a glance, and how to use them.
- [Threat model](THREAT-MODEL.md): adversaries, guarantees, and deliberate non-goals.
- [Format specification](../SPEC.md): the versioned pre-1.0 on-disk / on-image format candidate.
- [Cryptographic review dossier](CRYPTO-REVIEW.md): claims mapped to enforcement and tests.
