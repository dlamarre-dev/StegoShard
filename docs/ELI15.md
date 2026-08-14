# How StegoShard works, explained from scratch

Written for someone comfortable with computers who has done a bit of programming, and who
has never studied cryptography. No prior knowledge is assumed beyond that. Every section
starts with a sentence in bold, so you can read only those and still come away with the
shape of the thing.

If you want the reasoning behind the design, read [WHY.md](WHY.md). If you want the exact
byte layouts, read [SPEC.md](../SPEC.md). This document sits between them and explains the
machinery.

## The two-minute version

You have a small secret: a wallet phrase, a private key, your account recovery codes. A
few kilobytes, impossible to regenerate, and you may need it in ten years.

StegoShard encrypts it on your own machine, then writes it out in a form built to survive.
It can become a set of images you print or store, where losing several of them still
recovers everything. It can also hide inside an ordinary photo, or a file that looks like a
boring app database.

Those two goals fight each other, and the project says so rather than pretending otherwise.
Surviving damage means adding redundancy, which is visible. Hiding means adding nothing
visible, which makes it fragile. You pick.

The rest explains each piece: password to key, why three keys instead of one, how
encryption detects tampering, how Reed-Solomon survives losing whole images, why coloured
squares beat a QR code, and how hiding in a photo actually works.

## 1. The problem with small secrets

**Some data is tiny, irreplaceable, and has to last longer than any device you own.**

A wallet seed phrase is about a hundred bytes. Lose it and the money is gone, with no
support line to call. These are not big files, so the challenge is not storage space. It is
time, and bad luck: drives fail, cloud accounts close, paper gets wet, and the service
holding your backup shuts down in 2031.

The scenario the project is built around: Alice prints six images into a drawer and puts
one ordinary family photo in her cloud drive. Four years later one page is missing and
another has a coffee stain across it. The five remaining pages plus the photo restore her
file exactly, byte for byte.

## 2. The trade-off nobody escapes

**You cannot maximise "survives damage" and "nobody can tell it exists" at the same time,
because they ask for opposite things.**

Surviving damage requires redundancy: extra parity, error correction, all of it taking
space and looking like what it is. An image full of coloured squares is obviously carrying
something.

Staying hidden requires adding nothing visible, so you tuck data into the tiny variations
of an existing photo. Those variations are exactly what an image compressor discards, so a
messaging app that resizes the photo kills the payload.

StegoShard offers both and keeps them separate:

| Mode              | Goal                        | Survives re-compression | Hides that data exists |
| ----------------- | --------------------------- | ----------------------- | ---------------------- |
| Resilient Storage | reliable long-term backup   | yes                     | no                     |
| Deniable Storage  | hide that anything is there | no                      | yes                    |

There is a middle path too. Store the bulk resiliently, and hide only the small recovery
key inside an everyday photo. If the photo gets mangled you lose the key, not the data,
and you can keep a backup of the key elsewhere.

## 3. Turning a password into a key

**Encryption needs a key of exactly 256 random bits, and a password is neither 256 bits
nor random, so a special function stretches one into the other on purpose slowly.**

The function is [Argon2id](https://en.wikipedia.org/wiki/Argon2), a
[key derivation function](https://en.wikipedia.org/wiki/Key_derivation_function). Feed it
your password and it produces a 256-bit key. StegoShard runs it with these settings:

- 4 passes over the data
- 256 MiB of memory
- 1 thread

The memory figure is the interesting one. A plain hash is fast, and fast is bad here:
someone holding your encrypted file can try billions of guesses per second on a graphics
card. Argon2id is deliberately _memory-hard_, so every guess needs a quarter gigabyte of
RAM for the whole computation. A graphics card has thousands of cores and nowhere near
enough memory to give each one 256 MiB, so the parallel attack collapses.

You pay one to two seconds when unlocking your own vault. That pause is the feature.

Two practical details. A random 16-byte _salt_ goes in, so two people with the same
password get different keys and nobody can precompute a table of answers. And your password
is normalised to a standard Unicode form first, so an accented password works the same on a
Mac and a phone, where the same visible character can be stored as different bytes.

One honest note: StegoShard enforces a 12-character minimum, and a minimum length is not a
guarantee of strength. `aaaaaaaaaaaa` passes it.

## 4. Three keys instead of one

**Your password does not encrypt your file. It encrypts a key, which encrypts another key,
which encrypts your file, and each link exists for a reason.**

The three keys:

- **KEK**, the key encryption key. This is what Argon2id makes from your password. Its only
  job is to wrap the next key.
- **DEK**, the data encryption key. 256 random bits from the operating system's randomness
  source. This is the real key.
- **CEK**, the content encryption key. Derived fresh from the DEK for each thing you
  export.

The password key could have encrypted the file directly. Two reasons it does not.

First, password changes. Here a change rewrites a 92-byte block and nothing else. Encrypt
the file directly with the password key and changing it means rewriting every image you
ever made.

Second, and less obvious: the DEK is reused across vaults, and encryption uses a
never-repeat number called a nonce. Reuse a nonce under one key and the encryption breaks
badly. A fresh CEK per export keeps that risk bounded per export instead of accumulating
across everything you have ever exported.

The derivation uses [HKDF](https://en.wikipedia.org/wiki/HKDF), which turns one key into
several unrelated ones. Each use carries a label such as `"stegoshard/vault/content"`, and
different labels give unrelated keys from the same input, so a key meant for one purpose
cannot serve another. That is called domain separation, and it appears in seven places.

## 5. Locking it so tampering shows

**The cipher does two jobs at once: it hides the data, and it produces a tag that proves
nobody altered it.**

The cipher is AES-256 in GCM mode, a form of
[authenticated encryption](https://en.wikipedia.org/wiki/Authenticated_encryption). Three
pieces go in and two come out:

- in: the key, a 12-byte number used once called the IV or nonce, and your data
- out: the ciphertext, and a 16-byte authentication tag

The tag is what separates this from older encryption. Change one byte of ciphertext, or
use the wrong key, and the tag fails to match. Decryption stops instead of handing back
plausible-looking garbage. That is why a wrong password gives a clean error rather than a
corrupted file.

The limit: the key block and the encrypted content are not cryptographically bound
together, so someone could pair a key block from one file with content from another. The
tag still has to verify, so that cannot silently produce wrong plaintext, but the format
detects the mismatch rather than preventing it. The
[cryptographic review](CRYPTO-REVIEW.md) says so explicitly.

## 6. Surviving loss with Reed-Solomon

**Split the encrypted data into pieces, compute a few extra pieces, and any full-size
subset of them rebuilds the original.**

This is an [erasure code](https://en.wikipedia.org/wiki/Erasure_code), and the specific one
is [Reed-Solomon](https://en.wikipedia.org/wiki/Reed%E2%80%93Solomon_error_correction).

The encrypted blob is split into `k` data pieces, called shards. Then `m` parity shards are
computed from them. StegoShard uses 30% extra, with a floor of 2:

```
m = max(ceil(k × 0.3), 2)
```

So 10 data shards get 3 parity shards, and a tiny vault with a single data shard still gets
2 spares. Each shard becomes one image.

The property worth the space: **any `k` of the `k + m` shards rebuild the original.** Not
the first k, not the data ones. Any k. With 10 data and 3 parity you can lose any 3 images,
and which 3 does not matter.

Lose more than `m` and the data is gone. There is no partial recovery and the project
claims none.

The first `k` output shards _are_ the data shards, unchanged, which mathematicians call a
systematic code. With nothing damaged, reconstruction is reading the pieces in order.

Every image carries a 33-byte header naming its set, its shard number, `k`, `m`, and the
original length. That header repeats in every image, so any single survivor describes the
whole set and there is no index file to lose.

### The number system underneath

**All this arithmetic happens in a system where numbers are single bytes, addition is XOR,
and every non-zero value has an exact reciprocal.**

It is called a [Galois field](https://en.wikipedia.org/wiki/Finite_field), specifically
GF(2⁸). The reason for using it is practical. Rebuilding lost shards means solving a system
of linear equations, which means dividing. With ordinary integers you would hit rounding
and overflow. In this field, every division is exact and every result is still one byte, so
the arithmetic never loses anything and never grows.

That is genuinely all you need to know to follow the rest. If you want to go further, the
field is defined by one specific polynomial, `0x11D`, and choosing a different valid one
would produce a completely different and incompatible code.

## 7. Drawing it: the colour grid

**Eight colours per square carry three bits each, so a colour image holds roughly three
times what the QR code it replaces holds, and does it in a smaller picture.**

A QR module is black or white, one bit, and after its own error correction it delivers
roughly 0.75 bits of your data. A StegoShard colour module is one of eight colours: the
corners of the RGB cube, where each of red, green and blue is either fully off or fully on.
Eight possibilities is three bits.

The layout will look familiar: four bullseye markers in the corners so a decoder can find
and orient the grid, and a quiet white border. The markers are black and white only, so
they stay findable even when colour information gets damaged.

One row is unusual, and it solves the main problem with using colour at all. JPEG treats
colour as less important than brightness: it stores colour at half resolution and quantises
it more harshly, so a decoder cannot assume the red it sees is the red that was drawn.
StegoShard reserves eight squares holding the eight palette colours as a calibration strip,
and classifies every other square against those _observed_ colours rather than the ideal
ones. Colour shift, gamma and white balance drift are absorbed, because the reference
drifted with everything else.

Two profiles, tuned for different fates:

| Profile | Grid    | Module size | Parity | Payload    |
| ------- | ------- | ----------- | ------ | ---------- |
| Disk    | 168×168 | 4 px        | 12%    | 8636 bytes |
| Cloud   | 128×128 | 12 px       | 35%    | 3644 bytes |

Disk assumes the file stays intact, so it packs tightly. Cloud assumes a chat app will
re-compress it, so it uses squares nine times the area and more than triples the parity.

### Why each block carries a checksum

An erasure code fixes pieces that are _missing_. It has to be told which ones are bad. It
cannot find errors by itself.

So the data inside one image is cut into 64-byte blocks, each stored with its own 4-byte
[CRC-32](https://en.wikipedia.org/wiki/Cyclic_redundancy_check) checksum. Every block is
checked on decode, failures are reported as missing, and Reed-Solomon fills them in. The
checksum turns "this block is wrong" into "this block is absent", which is the question the
code can answer.

Blocks run down columns rather than across rows, so each occupies a vertical stripe. That
makes localised damage _better_ for you: a coffee stain destroys a few blocks outright,
which the code absorbs, while damage spread thinly over the whole image would corrupt every
block slightly and leave the code helpless.

One last detail. When your data does not fill the image, the leftover is filled with
pseudo-random bytes rather than zeros. Zeros would paint a flat black band whose width
announces how much of the capacity your secret actually used.

## 8. QR codes and their error-correction levels

**StegoShard also emits ordinary QR codes, and the choice of error-correction level is the
same trade-off as the colour profiles.**

QR codes have four levels of built-in
[error correction](https://en.wikipedia.org/wiki/QR_code#Error_correction), named L, M, Q
and H. Higher levels survive more damage and hold less. At the largest QR size the capacity
runs 2953, 2331, 1663 and 1273 bytes for L, M, Q and H, so going from L to H costs more
than half the payload.

StegoShard picks per situation:

| Profile | Level | Payload    |
| ------- | ----- | ---------- |
| Disk    | L     | 2800 bytes |
| Cloud   | Q     | 1600 bytes |
| Paper   | H     | 800 bytes  |

A file on disk does not decay, so Disk takes the cheapest level. Paper takes the strongest,
because paper gets folded and photographed under kitchen lighting. Paper output is always
QR and never colour: print, ink and camera white balance make colour unreliable.

Note that this is a second, independent layer of error correction. The QR code fixes damage
_within_ one image. Reed-Solomon rebuilds images that are _entirely_ lost. They stack.

## 9. Hiding it

**Hiding works by making changes that are smaller than the noise already in the file.**

Three carriers, three approaches.

**Ordinary photos, spatial method.** Each pixel holds red, green and blue values from 0 to
255, and changing the last bit of one shifts it by a single step that no eye can see. This
is [LSB steganography](https://en.wikipedia.org/wiki/Steganography#Digital_messages), for
least significant bit. StegoShard hides only the 92-byte key block this way, 736 bits
spread across a photo with millions of available positions. Those positions come from a key
derived from your password and a fingerprint of the photo itself, so the image needs no
header or marker at all. Extract with the wrong password and you get random bytes failing a
sanity check, which looks exactly like "there was nothing here".

**JPEG photos, frequency method.** A `.png` in a phone's camera roll would itself look odd,
so JPEG is supported too. A JPEG stores not pixels but coefficients of a
[discrete cosine transform](https://en.wikipedia.org/wiki/Discrete_cosine_transform), which
describe patterns of light and dark at different scales. StegoShard flips the lowest bit of
selected coefficients, chosen so the flip never changes how the file compresses, so the
re-saved file keeps essentially the same size and structure.

**A file that looks like an app database.** This one is a real
[SQLite](https://en.wikipedia.org/wiki/SQLite) database. Open it with the sqlite3 tool and
it works; run an integrity check and it passes. The encrypted vault lives in a table that
looks like a cache. Its deniability is shallow and the project says so: the stored values
are high-entropy, and anyone who actually opens the database and looks at the contents will
find that suspicious. It defeats a quick sort through your files, not a determined
examiner.

## 10. When someone forces you to open it

**Two modes exist for coercion, and they work in opposite situations, so you must choose
one.**

**Duress mode.** The container holds two encrypted regions with two independent passwords,
one opening your real data and one a decoy you prepared. Both regions are always present,
both padded to the same size, and unlocking runs the same code either way and returns the
same shape of answer, so watching over your shoulder tells nothing. The tool refuses a
duress password that is a trivial variation of the real one.

**Non-possession mode.** Your data is locked behind material you genuinely do not have.
That uses [Shamir's secret sharing](https://en.wikipedia.org/wiki/Shamir%27s_secret_sharing),
which splits a secret into `n` shares such that any `k` of them rebuild it, and any `k - 1`
give _nothing at all_. Not a partial answer, not a head start: zero information. You hand
the shares to other people and keep none. Below the threshold, you do not possess the
material required to derive the key.

The two modes cannot be combined, and the reason is worth understanding. Duress works only
under silence, where you claim this is all there is. Non-possession works only under
disclosure, where you say there is more and explain why you cannot reach it. A decoy would
destroy the second story.

There is a warning attached to duress that belongs here rather than in a footnote. **Using
a decoy can make your legal situation worse.** If it is later shown to be a decoy, you have
converted "I complied" into "I lied under compulsion". Deniability is a technical property
of a file. It is not a legal defence, and this project does not offer one. The
[threat model](THREAT-MODEL.md) covers this properly.

## 11. What this does not promise

Everything above describes how the machinery works. The
[claims register](CLAIMS.md) records what is actually proven, and it is deliberately
stricter than any summary. The short version:

- **The project is in beta and has not had an independent security audit.** That is the
  largest open item.
- **Hiding is measured against cheap detection tools, not against a specialist.** The
  measurements show that off-the-shelf detectors score a carrier the same as its untouched
  original. That is not evidence of resistance to someone doing targeted analysis, and the
  documentation never claims it is.
- **The database disguise is shallow**, as described above.
- **Printed recovery has not completed physical sign-off.** Print, photograph and scan
  testing is still in progress, so do not treat paper output as a guarantee yet.
- **A 12-character password minimum is a floor, not strength.**
- **Reed-Solomon recovers up to `m` losses and no more.**
- **The randomness tests are a smoke test.** No statistical test can prove unpredictability.

If a claim anywhere else in this project sounds stronger than what
[CLAIMS.md](CLAIMS.md) says, the claims register is right and the other document is wrong.
