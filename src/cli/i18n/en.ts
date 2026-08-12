/**
 * The CLI's messages, in English. This file is the canonical catalog: every other
 * locale is typed against it (`src/cli/i18n/index.ts`), so a missing or misnamed
 * key is a compile error rather than a line of silent English.
 *
 * Values are plain strings with `{name}` placeholders, substituted by `t()`.
 * Plain strings rather than functions because they are also what a translator
 * reads, and because a parity test can then check that every locale carries the
 * same placeholders.
 *
 * The help text is *data*, not prose: `usage.ts` renders the flag columns from
 * these descriptions, so alignment is computed rather than hand-kept in eight
 * languages, and no locale can drift out of structure.
 */
export const en = {
  // --- errors: arguments ---------------------------------------------------
  errThresholdShape: '--threshold must look like "2-of-3" (got "{spec}")',
  errThresholdRange: '--threshold out of range: {spec} (need 1 ≤ k ≤ n ≤ 255)',
  errEntropyWrongCommand: '{command}: the --entropy options apply to save and gallery-save only',
  errUnknownCommand: 'unknown command "{command}" (try: stegoshard --help)',
  errSaveMissingInputs: 'save: missing <file|dir ...>',
  errSaveKeyMode: 'save: invalid --key-mode "{value}"',
  errSaveStegoCover: 'save: --key-mode stego requires --cover <image>',
  errSaveBinaryPaper: 'save: --binary and --paper are mutually exclusive',
  errSaveDisguise: 'save: --disguise requires --binary',
  errSaveMode: 'save: invalid --mode "{value}"',
  errSaveModeNeedsDisguise: 'save: --mode {mode} requires --binary --disguise',
  errSaveDuressDecoy: 'save: --mode duress requires --decoy <file>',
  errSaveThreshold: 'save: --mode nonpossession requires --threshold k-of-n',
  errRestoreMissing: 'restore: missing input images/folder/zip/pdf',
  errGalleryMissingFile: 'gallery-save: missing <file>',
  errGalleryNoCovers: 'gallery-save: give cover photos or a folder',
  errGalleryKeyMode: 'gallery-save: invalid --key-mode "{value}"',
  errGalleryStegoCover: 'gallery-save: --key-mode stego requires --cover <image>',
  errGalleryDuress:
    'gallery-save: --mode duress is not available on gallery; use --binary --disguise --mode duress',
  errGalleryMode: 'gallery-save: invalid --mode "{value}"',
  errGalleryThreshold: 'gallery-save: --mode nonpossession requires --threshold k-of-n',
  errGalleryRestoreMissing: 'gallery-restore: missing photos/folder',
  errCodecInvalid: 'invalid --codec "{value}"',
  errCodecColorPaper: '--codec color cannot be used with --paper (printed pages use QR)',
  errEntropyExclusive: '{flags} are mutually exclusive (pick one entropy source)',
  errEntropyFlagEmpty: '--entropy was empty (omit the flag if you do not want extra entropy)',
  errEstimateMissing: 'estimate: missing <file>',
  errUiPort: 'ui: --port must be a port number (got "{value}")',
  errUiNoWebApp:
    'ui: this build does not carry the web app.\n' +
    'The standalone binaries are compiled without network access, so they cannot\n' +
    'serve it. Use `npx stegoshard ui`, or download the offline web bundle from\n' +
    'the releases page and run its serve script.',

  // --- errors: passwords and entropy --------------------------------------
  errNoPassword: 'no password provided (an empty password is not allowed)',
  errNoDuressPassword: 'no duress password provided (an empty password is not allowed)',
  errPasswordShort:
    'the {label} is too short: {length} character(s), minimum {min}. ' +
    'This floor cannot be waived; an offline attacker holding the vault can grind it at leisure.',
  errWeakAcknowledge: '{warning} Re-run with --allow-weak-password to acknowledge this risk.',
  errWeakCancelled: 'cancelled: weak password was not acknowledged',
  errEntropyFile: '--entropy-file: cannot read "{path}"',
  errEntropyPromptTty:
    '--entropy-prompt needs a terminal; use --entropy-file or STEGOSHARD_ENTROPY',
  errEntropyPromptEmpty: '--entropy-prompt: nothing entered',
  errEntropyEmpty: 'extra entropy was empty (omit it if you do not want the extra layer)',

  // --- errors: the run itself ---------------------------------------------
  errWrongPassword: 'wrong password',
  errNoGallery: 'no restorable gallery found (wrong password or these are not gallery photos)',
  errNeedsKey: 'this image set needs a separate key (use --key <file|image>)',
  errDuressTooSimilar:
    'the duress password is too similar to the real one ({reason}); ' +
    'choose an unrelated duress password',
  errOverwrite: 'refusing to overwrite existing file: {path} (use --force to overwrite)',
  errStegoNeedsCover: 'stego mode requires a --cover image',
  errDuressNeedsPassword: 'save: --mode duress requires a duress password',
  errNoInputFiles: 'save: no input files found',
  errModeNeedsDisguise: 'save: --mode {mode} is only supported with --binary --disguise',
  errNoReadableImages: 'no readable StegoShard images found in the inputs',
  errNoCoversFound: 'gallery: no cover images found in the given paths',
  errNoGalleryImages: 'gallery: no images found in the inputs',

  // --- warnings and prompts -----------------------------------------------
  warnPasswordFlag:
    'Warning: --password is visible in your shell history and the process list; ' +
    'prefer STEGOSHARD_PASSWORD, --password-file, or the interactive prompt.',
  warnEntropyFlag:
    'Warning: --entropy is visible in your shell history and the process list; ' +
    'prefer STEGOSHARD_ENTROPY, --entropy-file, or --entropy-prompt.',
  warnWeakPassword:
    'Warning: the {label} is weak (estimated {bits} bits). ' +
    'Offline vaults can be guessed without contacting you.',
  warnPrefix: 'Warning: {message}',
  labelPassword: 'password',
  promptPassword: 'Password: ',
  promptDuressPassword: 'Duress password: ',
  promptEntropy: 'Extra entropy (type randomly, or paste dice rolls): ',
  promptAllow: 'Type ALLOW to continue: ',

  // --- progress phases ----------------------------------------------------
  phaseCompress: 'Compressing',
  phaseEncrypt: 'Encrypting',
  phaseDecrypt: 'Decrypting',
  phaseVerify: 'Verifying',
  phaseUnlock: 'Unlocking',
  phaseRender: 'Rendering',

  // --- what each written file is for --------------------------------------
  purposeVault: 'the vault: holds your file',
  purposeArchive: 'all images bundled in one .zip',
  purposeDocument: 'printable sheet',
  purposePhotos: 'fragment photos: keep the whole set',
  purposeKeyfile: 'separate key: needed with your password',
  purposeStegoCover: 'photo holding the hidden key',
  purposeShare: 'recovery share, for one holder',

  // --- results ------------------------------------------------------------
  outSaved: 'Saved {what}.',
  outSavedBinary: 'binary vault ({variant}) [{keyMode}]',
  outSavedImages: '{count} image(s) [{keyMode}]',
  outFilesCreated: 'Files created:',
  outKeepKeyArtifact: 'Keep the separate key artifact AND your password to restore.',
  outSavedGallery:
    'Saved gallery across {files} file(s) ({k} data + {m} parity + {decoys} decoy) [{keyMode}].',
  outGalleryKeep: 'Keep your password; any {k} of the fragment photos restore it.',
  outGalleryKeepKey: 'Keep the separate key artifact too (restore with --key).',
  outRestoredOne: 'Restored {name} -> {path}',
  outRestoredMany: 'Restored {count} files:',
  outDecoded: 'decoded {decoded} of {seen} image(s)',
  outScanned: 'scanned {seen} photo(s)',
  outEstimate: '{images} image(s)  (k={k} data + m={m} parity)',

  // --- help: prose --------------------------------------------------------
  helpTagline:
    'StegoShard: encrypt a file into resilient images, an opaque binary file, or a decoy database, and restore it.',
  helpUsageHeading: 'Usage:',
  helpUi:
    'Same app as the browser version, served on this machine only. Not available in the standalone binaries, which are compiled without network access.',
  helpUiHeading: 'Local web UI:',
  helpSaveHeading: 'Save options:',
  helpSaveIntro:
    'Several inputs (or a directory) are zipped into one bundle inside the vault; restore unpacks them back to the original files. One input is stored as-is.',
  helpRestoreHeading: 'Restore options:',
  helpCommonHeading: 'Common:',
  helpPasswordHeading: 'Password (any command that needs one), in order of precedence:',
  helpEntropyHeading:
    'Extra entropy for save / gallery-save (optional, expert; affects generation only, nothing to re-enter on restore, and the OS CSPRNG is always used regardless), in order of precedence:',
  helpEntropyNote:
    'Your text is XORed in as a second source: it can only add uncertainty, never replace the CSPRNG, so a weak string cannot weaken the vault.',
  helpGalleryHeading: 'Gallery Mode (a secret hidden, fragmented, across many ordinary photos):',
  helpGalleryNoDuress:
    '(duress is not available on gallery; use --binary --disguise --mode duress)',
  helpGalleryNote:
    'Every photo is modified; the best K+M carry Reed-Solomon fragments and the rest become decoys (min 5 photos total, at least 2 decoys). Restore is blind: any photos that authenticate are used, and any K fragments reconstruct.',
  helpExamplesHeading: 'Examples:',

  // --- help: option descriptions ------------------------------------------
  helpOut: 'Output directory (default: current directory)',
  helpPaper: 'Produce a printable PDF (high-ECC) instead of PNGs',
  helpZip: 'Bundle the PNG set into a single .zip (disk mode)',
  helpBinary: 'Output one opaque file instead of images (up to 1 GiB)',
  helpDisguise: 'With --binary: give it a SQLite-database header (.db)',
  helpMode: 'plain | duress | nonpossession   (.db only; default: plain)',
  helpModeDuress: 'duress: a decoy that opens under a 2nd password',
  helpModeNonpossession: "nonpossession: gate the vault on threshold shares you can't reach",
  helpDecoy: '--mode duress: the plausible decoy file',
  helpDuressPasswordFile: '--mode duress: the 2nd (duress) password',
  helpThreshold: '--mode nonpossession: e.g. 2-of-3 (writes n share files)',
  helpCodec: 'color | qr   (default: color; images only, not --paper)',
  helpCodecColor: 'color: 8-colour grid, ~3x the bytes per image',
  helpCodecQr: 'qr: plain QR, readable by any phone',
  helpKeyMode: 'embedded | keyfile | stego   (default: embedded)',
  helpCover: 'Cover photo for --key-mode stego (key hidden in it)',
  helpTitle: 'Human-readable label / PDF title',
  helpDate: 'Date shown on the pages (default: today)',
  helpLocale: 'Instruction-sheet language, e.g. fr, ja, zh_TW',
  helpInstructions: 'Include the restore instruction sheet (paper)',
  helpPasswordHint: 'Password hint printed on the instruction sheet',
  helpKeyLocation: 'Where the key is kept, printed on the sheet',
  helpFont: 'A .ttf/.otf for CJK instruction text (paper)',
  helpAllowWeakPassword:
    'Acknowledge a weak (but >= 12 character) password for a new vault. The 12-character minimum itself cannot be waived by this or any other flag.',
  helpKey: 'A .key file, a stego image, or a binary key container',
  helpShare: 'A threshold share file (repeatable) for a nonpossession vault',
  helpForce: 'Overwrite existing output files (default: refuse)',
  helpQuiet: 'Suppress the progress indicator on stderr',
  helpPasswordFlag: 'Discouraged: visible in shell history / process list',
  helpPasswordFile: 'Read the password from a file (first line)',
  helpPasswordEnv: 'Environment variable',
  helpPasswordPrompt: 'Asked (hidden) when none of the above is set',
  helpEntropyFlag: 'Discouraged: visible in shell history / process list',
  helpEntropyFile: 'Read it from a file (whole contents, e.g. dice rolls)',
  helpEntropyPrompt: 'Ask for it (hidden) at the terminal (needs a TTY)',
  helpEntropyEnv: 'Environment variable',
  helpGalleryOut: 'Output directory for the modified photos',
  helpGalleryKeyMode: 'embedded (default) | keyfile | stego   (gallery-save)',
  helpGalleryCover: 'Cover photo for --key-mode stego (gallery-save)',
  helpGalleryKey: 'External key for a keyfile/stego gallery (gallery-restore)',
  helpGalleryMode: 'Gate the gallery on threshold shares (with --threshold k-of-n)',
  helpGalleryShare: 'A threshold share file (repeatable) for gallery-restore',
  helpUiPort: 'Serve on this port instead of a free one',
  helpUiOpen: 'Open the address in your browser as well as printing it',
};
