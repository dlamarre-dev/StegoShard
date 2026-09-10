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

- `FORMAT_VERSION` = 2
- `KEY_BLOCK_VERSION` = 2
- `BINARY_VERSION` = 1
- `CODEC_GALLERY` = 1

## Contents

41 files, 1102 KiB.

```
81f3b862e8a812f4f9aa4ba89e8991ddc505878637ecc60d9a20f24939344bed  binary-branded/expected.bin
62217a15b3340ab245ff0989ce47cc075dfae0c06eca8387eead86cfe8a581f0  binary-branded/manifest.json
fba26fb90e8bd2cdfc5e115e97b217bd7073790d314989b1f32b9423579dd700  binary-branded/stegoshard-vault.ssbn
5b5bdd20b4824d6fe384647073cdeb7dbb504a6a53ccbb569c194971cb21bddf  binary-disguised/cache.db
81f3b862e8a812f4f9aa4ba89e8991ddc505878637ecc60d9a20f24939344bed  binary-disguised/expected.bin
75064755ad35eda158dcba264543624438829218606c4948858e84b14190eb5a  binary-disguised/manifest.json
114a233741eb1c432b05121d28255636b2cd74c9a3f9c0a17807c72a1c30b1fd  binary-disguised/settings.db
b4db555b860027a824e210142c1ab8e7b2952f9436d8b295ee69854857bb0183  color-grid/expected.bin
bb25dd5bc056a845839f6c4383fda727ec5a4adee3fcaabf9097d987fbebada7  color-grid/manifest.json
8820874e3ad10d49d36980e5a8cc4c10ff031c2205a7033981d6e0bede95462a  color-grid/page-01.png
9ff4cd452cdd9f061a3f9f6a879d1ad41d294e08f14baae8bc2b6c8f672b0cfb  color-grid/page-02.png
91be5a7c2b1fabfb5ac8fbcab109230c949294a26a00489c8a54616806d640ba  color-grid/page-03.png
29612692337a08bc64dbe132fe8f596bd427ac3819671d509125045a9eacc2ef  color-grid/page-04.png
db6ef214bec5d66c103e39fd11bb811643798e8ae2f5363fd36cd263716f9002  color-grid/page-05.png
81f3b862e8a812f4f9aa4ba89e8991ddc505878637ecc60d9a20f24939344bed  embedded/expected.bin
7e408034c19cf8b373a11bcf06e49e229d0661dc1b2c82d1b925284b96b7096c  embedded/manifest.json
d88d0c26d405ede077095f81777781ddc0af5156d68c5cde05f5e6ed78d62bdc  embedded/page-01.png
e174397e1f44ccacefa13309661c1636ad76fd3f16f5d0d90e22e5b70ae934ac  embedded/page-02.png
1ab01bb0e510c1443e634468c1d6e766d608d17418576ade2fbdc5eb5469d843  embedded/page-03.png
4eb8bf98b717719bee3de288bc166c7f539ae1da253d478d953871014bc97d51  embedded/page-04.png
81f3b862e8a812f4f9aa4ba89e8991ddc505878637ecc60d9a20f24939344bed  keyfile/expected.bin
fe44bead6b0a8d6f15df8807889fbd3d0c32def6de1cd0f84a83d83a2b5d04df  keyfile/manifest.json
00dd69307ba24587aed0e34d1d3782561b43f66149460427f8633075c01c6560  keyfile/page-01.png
d30f7c02c6392c27eb0183aaabcbefc1e70845683863ffab01c39d4694322daf  keyfile/page-02.png
48fec28dcf373cb084831d2067d0e55703630d1007564b3a5d851411019106cf  keyfile/page-03.png
973fe924cdf291a7d187d46e149c22c4f253469d2e573f1be0bae24e6f965ebb  keyfile/page-04.png
7d06eab1e2b1c5ef0a96be70590ba2e8b04bce439474529cca71b8f1c0e848af  keyfile/vault.key
81f3b862e8a812f4f9aa4ba89e8991ddc505878637ecc60d9a20f24939344bed  stego-jpeg/expected.bin
1c38dd50f85b1c722c424fdae239efd0b1a55d98d78d46a9a663f91965e1d2c1  stego-jpeg/key.jpg
112407b9a3362d53262a44910b6ec5e1bbb653786b3a033ffffcd560c3794996  stego-jpeg/manifest.json
b2690df1556ea94dfef0ffa6df64008c8f45e9ae5d146f60392293fa9bebb346  stego-jpeg/page-01.png
f0d879affc179200615547915b7a67c8e5608ce2a090fab4ecbab38c81c0d76e  stego-jpeg/page-02.png
20c146172650480d0890bd81495cfcbd34e293a202cb6f34e903312cf6574543  stego-jpeg/page-03.png
5d94bf7ecf1a8af5732563b0d61ac1b5c6c5262b0176ff1e2f39d62f4e25227b  stego-jpeg/page-04.png
81f3b862e8a812f4f9aa4ba89e8991ddc505878637ecc60d9a20f24939344bed  stego/expected.bin
8ecd6e83127dc03faf96bd92222d5f9eb778fa82dc9765e91bc8a28712de994c  stego/key.png
112407b9a3362d53262a44910b6ec5e1bbb653786b3a033ffffcd560c3794996  stego/manifest.json
aa4983a525ceae2fbfb336c9ae8cc9e6f630553629d59bb5d7e5d1ca7fede6bf  stego/page-01.png
c3f32b7578e89b6ab3a2edd2053bc80cb9e44ff546a41204543e0ccb49817f18  stego/page-02.png
b7dbf9ec9483aaa8e6f845c37ab11c8278741bb4025b62b116f82c341990233a  stego/page-03.png
d5689d49eb9c4c5d3e409393d537b36745efdb5eff700172bc24030e72fd9084  stego/page-04.png
```
