<!-- lang: en · review: source of truth · target ≤2500 chars · store long description -->

**Lock a small, precious file with a password, then keep it somewhere it will actually survive, or somewhere no one will find it.**

StegoShard turns a sensitive file (a password-manager export, a crypto wallet recovery phrase, account backup codes, private keys, a secret note) into something you can safely keep for years. Encrypt it, then choose: save it as sturdy, error-corrected images (or a printable page, or a single file) that survive being printed, copied and re-downloaded, or hide it invisibly inside an ordinary-looking photo so no one knows it's there. Or do both at once.

Everything happens on your own device. Nothing is uploaded, there is no account, and it works offline.

**What you can do with it**

- Back up your password-manager export and keep it for years without trusting a cloud company, and print it so a dead laptop can't take it with it.
- Protect a crypto wallet recovery phrase: tiny, irreplaceable, and with no "forgot password".
- Print an encrypted backup as a QR-code PDF, then restore it later by scanning the pages with your phone camera, even if a page is lost or stained.
- Hide a password or key backup inside a family photo you leave in your album, so its very existence stays discreet.
- Keep a secret spread across several ordinary photos plus decoys; losing a few is fine.
- Store account recovery codes and get the original file back byte-for-byte, even if some copies are damaged.

**Features**

- Password-based encryption; your key never leaves your device (Argon2id + AES-256-GCM)
- Hide secrets inside ordinary photos: a JPEG stays a JPEG, a PNG stays a PNG
- Error correction across several images: lose a page or a photo and still recover
- Printable paper / QR export, restorable by scan or phone camera
- Save to disk as images or a single .zip, or as one opaque file
- Decoy-database (.db) output and Gallery Mode (spread across everyday photos)
- Three ways to handle the key: embedded, a separate key file, or hidden in a photo
- Password-strength meter and passphrase generator, with first-run guidance
- Works in Chrome, Edge and Firefox, plus a matching no-install web app

**Private by design**
Free and open source (MIT). No account, no tracking, and selected files are processed locally. The web app and independent decoder provide separate recovery paths. The format is versioned but remains a pre-1.0 beta candidate.

**Please note**
StegoShard is made for small secrets, not whole-drive backups. There is no recovery if you lose your password, so keep it safe. Hiding a secret keeps it discreet from a casual look; it is not a guarantee against a determined forensic examiner. This is beta software.

Source code, documentation and the web app: https://github.com/dlamarre-dev/StegoShard
