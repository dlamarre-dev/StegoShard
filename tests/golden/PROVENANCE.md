# Golden corpus

Encoded artifacts that current decoders must keep reading. **Do not regenerate
these to make a test pass.** If a change makes them fail to decode, that is the
corpus doing its job.

Regenerating is legitimate exactly once per deliberate format change, and
`scripts/check-golden.ts` enforces the pairing: a diff here without a version
constant moving in the same commit fails CI.

    npm run golden

## What is pinned

- `embedded/` — QR-grid images, key block embedded (SPEC §2.1, §5.1)
- `color-grid/` — eight-colour grid images (SPEC §2.2)
- `keyfile/` — QR-grid images with a separate .key file (SPEC §5.2)
- `stego/` — key block hidden in a PNG cover by spatial LSB (SPEC §5.3)
- `stego-jpeg/` — key block hidden in a JPEG cover by DCT coefficient (SPEC §5.4)
- `binary-branded/` — branded .ssbn container (SPEC §8)
- `binary-disguised/` — disguised SQLite .db container (SPEC §8)

Gallery Mode is not here. Its smallest fixture is 2.4 MB against about 1 MB for
everything above together. Its slot format is partially pinned by the
`multiRegionSegmentedBlob` vectors in `tests/vectors/crypto-vectors.json`;
the photo carriers themselves are not pinned at all. That is the one output path
this corpus leaves uncovered, and it is stated here rather than left to be
discovered.

## Format version constants at generation

- `FORMAT_VERSION` = 1
- `KEY_BLOCK_VERSION` = 1
- `BINARY_VERSION` = 1
- `CODEC_GALLERY` = 1

## Contents

41 files, 1104 KiB.

```
81f3b862e8a812f4f9aa4ba89e8991ddc505878637ecc60d9a20f24939344bed  binary-branded/expected.bin
62217a15b3340ab245ff0989ce47cc075dfae0c06eca8387eead86cfe8a581f0  binary-branded/manifest.json
82fcb443b7e2512c94e6de93504e4c926da319f30256a4bc4248cffccd550f03  binary-branded/stegoshard-vault.ssbn
16c588505a297ea8494738a2c327a5db475958d3bb0f8938bed57a3787d2fdc7  binary-disguised/cache.db
81f3b862e8a812f4f9aa4ba89e8991ddc505878637ecc60d9a20f24939344bed  binary-disguised/expected.bin
75064755ad35eda158dcba264543624438829218606c4948858e84b14190eb5a  binary-disguised/manifest.json
88e74b1a0ce5e5cb9bcb142e133be20411d4cba2ed4e019f673231a6bfe09cac  binary-disguised/settings.db
b4db555b860027a824e210142c1ab8e7b2952f9436d8b295ee69854857bb0183  color-grid/expected.bin
bb25dd5bc056a845839f6c4383fda727ec5a4adee3fcaabf9097d987fbebada7  color-grid/manifest.json
7f3e787b8f385b33122c4234951f877fc04fbe4f12067735427c8826a2aa4fdc  color-grid/page-01.png
f92359ee061b77c4e056cdc9ea2437fcb53874b7714892838cd50a30c5651860  color-grid/page-02.png
7e256bc1eddb685423f3e1bcb0f034bcd6576520aa65a51a8fd2e104e3a498a7  color-grid/page-03.png
cfedc77d4db9aa7194b933f104bad0bfd6fd436e9b867533f94540a7931ded49  color-grid/page-04.png
0c790c19ac9ff59912ad07d9a18577da69fd7b5fc16bee0931ae278338e142e3  color-grid/page-05.png
81f3b862e8a812f4f9aa4ba89e8991ddc505878637ecc60d9a20f24939344bed  embedded/expected.bin
7e408034c19cf8b373a11bcf06e49e229d0661dc1b2c82d1b925284b96b7096c  embedded/manifest.json
dcb54a5fb48bb9c9a6b0bf312c1342b59967168e7c5c826954e392f27439f856  embedded/page-01.png
389d30c84c065e1cbefb4fa4c74db95edd537a2b40a1f7362081cf8f22e29fd4  embedded/page-02.png
43037c87de5a3ab6e19b4efb9e6586ebcabcfe2a3044de356eb68f34320027ff  embedded/page-03.png
4471ff85bd51b7779340f10f402ba1d20df62ef74cfb002a3ccf837cd5ae066b  embedded/page-04.png
81f3b862e8a812f4f9aa4ba89e8991ddc505878637ecc60d9a20f24939344bed  keyfile/expected.bin
fe44bead6b0a8d6f15df8807889fbd3d0c32def6de1cd0f84a83d83a2b5d04df  keyfile/manifest.json
29b2605c640146d8fb2d82bf36e8c9ab4c2dac3f2abe311e93c6a3aff5c44f1b  keyfile/page-01.png
909c6df72756f1842ee8c37f4da143424c76705831618f0f3765d6d0ad000a5a  keyfile/page-02.png
bfa73f11f2a834aee7db0ca53de859c28cd64f6ca79da7b45f9ff3c0092dba66  keyfile/page-03.png
4614898f9f9fa5748e02ff7f43922de1b2fe3073dc8c54cb77adab237d16e121  keyfile/page-04.png
c211051e79537b40762e6c353c5b7fcad70d6f4fa036ab105570c2d25b0593a1  keyfile/vault.key
81f3b862e8a812f4f9aa4ba89e8991ddc505878637ecc60d9a20f24939344bed  stego-jpeg/expected.bin
aba37f750188746672266378d42ba22ac343f4d8d52d02e13621c4f9c538eac5  stego-jpeg/key.jpg
112407b9a3362d53262a44910b6ec5e1bbb653786b3a033ffffcd560c3794996  stego-jpeg/manifest.json
306969c6dc7e969f9664848028b9004f1d0fec2fdce1a179be006d80be5e4fa3  stego-jpeg/page-01.png
deb51a664e8bac877292ef74b024f45e66cb872cf3a506e4e3402d4e580396e6  stego-jpeg/page-02.png
4019452910abf866e302a9802c4294ee700421dfdf577094ae5a27109211dfd6  stego-jpeg/page-03.png
e49f0a26d2e52c36cf39c0946a4808b4ea90b5947c1879ad5ba1e3ddad89b17b  stego-jpeg/page-04.png
81f3b862e8a812f4f9aa4ba89e8991ddc505878637ecc60d9a20f24939344bed  stego/expected.bin
4c782bd58ca459042ecea620dfac3fb666899867dbf0ca1541d1359245fe56b9  stego/key.png
112407b9a3362d53262a44910b6ec5e1bbb653786b3a033ffffcd560c3794996  stego/manifest.json
7a54cb75cfa66000023afafd856e39b9d7526185f98cb472ab3921032822ce3e  stego/page-01.png
28686877874c2407e68382f56eda79fcf34f571a112e7a564382c50a3b95b593  stego/page-02.png
ce794f99e9d61f8f80024d3480dc01a25a93f80c4d9e6c43891eed09f65ce9ee  stego/page-03.png
931f430ac332a6004823258012fea58db39586c3a871b461ef53808c403835fe  stego/page-04.png
```
