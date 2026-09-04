# Why StegoShard?

Why StegoShard is shaped the way it is. For the format read [SPEC.md](../SPEC.md); for
the guarantees and their limits, the [threat model](THREAT-MODEL.md).

## The problem: small secrets that must outlive everything

Some secrets are tiny but irreplaceable: a wallet seed phrase, a private key, a
password-manager export, account recovery codes, a handful of `.env` files. They are
awkward in three ways at once:

1. **They must last for years**, across dead laptops, closed cloud accounts, and the day
   the service holding them shuts down.
2. **Losing one is final.** There is no "forgot password" for a seed phrase.
3. **Sometimes their existence is the sensitive part.** At a border, under duress, or on
   a shared machine, the safest secret is one nobody knows is there.

No mainstream tool serves all three, and that follows from how they are built.

## Why the usual answers fall short

**Password managers** are excellent custodians while you are logged in, but they are one
system you have to keep trusting: one account, one vendor, one recovery path. They give
you no offline artifact to print and lock away, and they do not try to hide that a vault
exists. That is not their job.

**Classic encrypted backups** (an encrypted archive, a LUKS volume, an age file) solve
durability and confidentiality, but the ciphertext is conspicuously a secret. A blob of
high-entropy bytes named `backup.age` announces that something valuable is encrypted
here. Fine against a thief, useless against anyone who can **compel** you to open it.

**Classic steganography** hides data beautifully, until the carrier is touched. Re-encode
the image, upload it to a social network, print and re-scan it, and the payload is gone.
Those tools optimize for staying undetected, which is at odds with surviving change.

## The insight: two goals that cannot both be maximized

Line those failures up and the pattern is the same each time. Two properties, pulling in
opposite directions:

- **Resilience.** Survive loss, recompression, printing, and the death of any one copy.
  It needs redundancy and structure, which make the carrier look like what it is.
- **Deniability.** Hide that the secret exists. It needs blending into ordinary data,
  which is fragile: the moment a social network re-encodes your photo, the hidden bits
  die.

More of one means less of the other. Any tool claiming the best of both worlds is either
overselling or hiding a caveat.

## What StegoShard does about it

Rather than pretend the trade-off away, StegoShard names it and hands you the choice:

- **🛡 Resilient Storage.** Encrypt, then spread the secret across error-corrected images,
  or one opaque file, built to survive recompression, printing and cloud storage. Openly
  artificial. For never losing the data.
- **🎭 Deniable Storage.** Hide a small secret inside ordinary photos, or wrap it as a
  decoy database. For nobody knowing it exists. Fragile by design.
- **🔗 Hybrid.** Store the archive resiliently and hide **only the recovery key** in an
  everyday photo. The bulky part survives anything; the deniable part is small and
  expendable. Lose the photo and you have lost the key, not the data.

So StegoShard is really a choice between carriers rather than a single feature: two
properties that cannot both be had, and three ways to decide which one your secret needs.
The limits of each are written down in the [threat model](THREAT-MODEL.md), because a
tool that hides its caveats is the kind of tool this project is a reaction against.

## Further reading

- [README](../README.md): the two models at a glance, and how to use them.
- [Threat model](THREAT-MODEL.md): adversaries, guarantees, and deliberate non-goals.
- [Format specification](../SPEC.md): the versioned pre-1.0 on-disk / on-image format candidate.
- [Cryptographic review dossier](CRYPTO-REVIEW.md): claims mapped to enforcement and tests.
