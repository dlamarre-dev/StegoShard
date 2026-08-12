/** German. Flag names, environment variables and file extensions stay verbatim. */
import type { CliCatalog } from './index';

export const de: CliCatalog = {
  errThresholdShape: '--threshold muss wie „2-of-3“ aussehen (erhalten: „{spec}“)',
  errThresholdRange: '--threshold außerhalb des Bereichs: {spec} (nötig: 1 ≤ k ≤ n ≤ 255)',
  errEntropyWrongCommand: '{command}: die --entropy-Optionen gelten nur für save und gallery-save',
  errUnknownCommand: 'unbekannter Befehl „{command}“ (versuchen Sie: stegoshard --help)',
  errSaveMissingInputs: 'save: <Datei|Verzeichnis ...> fehlt',
  errSaveKeyMode: 'save: ungültiges --key-mode „{value}“',
  errSaveStegoCover: 'save: --key-mode stego erfordert --cover <Bild>',
  errSaveBinaryPaper: 'save: --binary und --paper schließen sich gegenseitig aus',
  errSaveDisguise: 'save: --disguise erfordert --binary',
  errSaveMode: 'save: ungültiges --mode „{value}“',
  errSaveModeNeedsDisguise: 'save: --mode {mode} erfordert --binary --disguise',
  errSaveDuressDecoy: 'save: --mode duress erfordert --decoy <Datei>',
  errSaveThreshold: 'save: --mode nonpossession erfordert --threshold k-of-n',
  errRestoreMissing: 'restore: Eingabebilder/-verzeichnis/-zip/-pdf fehlen',
  errGalleryMissingFile: 'gallery-save: <Datei> fehlt',
  errGalleryNoCovers: 'gallery-save: Titelfotos oder ein Verzeichnis angeben',
  errGalleryKeyMode: 'gallery-save: ungültiges --key-mode „{value}“',
  errGalleryStegoCover: 'gallery-save: --key-mode stego erfordert --cover <Bild>',
  errGalleryDuress:
    'gallery-save: --mode duress gibt es für die Galerie nicht; verwenden Sie --binary --disguise --mode duress',
  errGalleryMode: 'gallery-save: ungültiges --mode „{value}“',
  errGalleryThreshold: 'gallery-save: --mode nonpossession erfordert --threshold k-of-n',
  errGalleryRestoreMissing: 'gallery-restore: Fotos/Verzeichnis fehlen',
  errCodecInvalid: 'ungültiges --codec „{value}“',
  errCodecColorPaper:
    '--codec color lässt sich nicht mit --paper verwenden (gedruckte Seiten nutzen QR)',
  errEntropyExclusive: '{flags} schließen sich gegenseitig aus (nur eine Entropiequelle)',
  errEntropyFlagEmpty:
    '--entropy war leer (lassen Sie die Option weg, wenn Sie keine zusätzliche Entropie wollen)',
  errEstimateMissing: 'estimate: <Datei> fehlt',
  errUiPort: 'ui: --port muss eine Portnummer sein (erhalten: „{value}“)',
  errUiNoWebApp:
    'ui: dieser Build enthält die Web-App nicht.\n' +
    'Die eigenständigen Binaries sind ohne Netzwerkzugriff kompiliert und können sie\n' +
    'daher nicht bereitstellen. Verwenden Sie „npx stegoshard ui“, oder laden Sie das\n' +
    'Offline-Web-Paket von der Releases-Seite und starten Sie dessen serve-Skript.',

  errNoPassword: 'kein Passwort angegeben (ein leeres Passwort ist nicht erlaubt)',
  errNoDuressPassword: 'kein Zwangspasswort angegeben (ein leeres Passwort ist nicht erlaubt)',
  errPasswordShort:
    'das {label} ist zu kurz: {length} Zeichen, Minimum {min}. ' +
    'Diese Untergrenze lässt sich nicht aufheben; ein Angreifer offline, der den Tresor hat, kann sie in Ruhe durchprobieren.',
  errWeakAcknowledge:
    '{warning} Führen Sie es mit --allow-weak-password erneut aus, um dieses Risiko zu bestätigen.',
  errWeakCancelled: 'abgebrochen: das schwache Passwort wurde nicht bestätigt',
  errEntropyFile: '--entropy-file: „{path}“ kann nicht gelesen werden',
  errEntropyPromptTty:
    '--entropy-prompt braucht ein Terminal; verwenden Sie --entropy-file oder STEGOSHARD_ENTROPY',
  errEntropyPromptEmpty: '--entropy-prompt: nichts eingegeben',
  errEntropyEmpty:
    'die zusätzliche Entropie war leer (lassen Sie sie weg, wenn Sie diese Schicht nicht wollen)',

  errWrongPassword: 'falsches Passwort',
  errNoGallery:
    'keine wiederherstellbare Galerie gefunden (falsches Passwort, oder das sind keine Galeriefotos)',
  errNeedsKey: 'dieser Bildsatz braucht einen separaten Schlüssel (--key <Datei|Bild>)',
  errDuressTooSimilar:
    'das Zwangspasswort ist dem echten zu ähnlich ({reason}); ' +
    'wählen Sie ein unabhängiges Zwangspasswort',
  errOverwrite: 'vorhandene Datei wird nicht überschrieben: {path} (mit --force überschreiben)',
  errStegoNeedsCover: 'der stego-Modus erfordert ein --cover-Bild',
  errDuressNeedsPassword: 'save: --mode duress erfordert ein Zwangspasswort',
  errNoInputFiles: 'save: keine Eingabedateien gefunden',
  errModeNeedsDisguise: 'save: --mode {mode} wird nur mit --binary --disguise unterstützt',
  errNoReadableImages: 'keine lesbaren StegoShard-Bilder in den Eingaben',
  errNoCoversFound: 'Galerie: keine Titelbilder in den angegebenen Pfaden gefunden',
  errNoGalleryImages: 'Galerie: keine Bilder in den Eingaben gefunden',

  warnPasswordFlag:
    'Warnung: --password ist in der Shell-Historie und der Prozessliste sichtbar; ' +
    'bevorzugen Sie STEGOSHARD_PASSWORD, --password-file oder die interaktive Eingabe.',
  warnEntropyFlag:
    'Warnung: --entropy ist in der Shell-Historie und der Prozessliste sichtbar; ' +
    'bevorzugen Sie STEGOSHARD_ENTROPY, --entropy-file oder --entropy-prompt.',
  warnWeakPassword:
    'Warnung: das {label} ist schwach (geschätzt {bits} Bit). ' +
    'Offline-Tresore lassen sich erraten, ohne Sie zu kontaktieren.',
  warnPrefix: 'Warnung: {message}',
  labelPassword: 'Passwort',
  promptPassword: 'Passwort: ',
  promptDuressPassword: 'Zwangspasswort: ',
  promptEntropy: 'Zusätzliche Entropie (zufällig tippen oder Würfelwürfe einfügen): ',
  promptAllow: 'Tippen Sie ALLOW, um fortzufahren: ',

  phaseCompress: 'Komprimieren',
  phaseEncrypt: 'Verschlüsseln',
  phaseDecrypt: 'Entschlüsseln',
  phaseVerify: 'Prüfen',
  phaseUnlock: 'Entsperren',
  phaseRender: 'Rendern',

  purposeVault: 'der Tresor: enthält Ihre Datei',
  purposeArchive: 'alle Bilder in einer .zip gebündelt',
  purposeDocument: 'druckbares Blatt',
  purposePhotos: 'Fragment-Fotos: den ganzen Satz aufbewahren',
  purposeKeyfile: 'separater Schlüssel: zusammen mit dem Passwort nötig',
  purposeStegoCover: 'Foto mit dem versteckten Schlüssel',
  purposeShare: 'Wiederherstellungsanteil, für eine Person',

  outSaved: 'Gespeichert: {what}.',
  outSavedBinary: 'binärer Tresor ({variant}) [{keyMode}]',
  outSavedImages: '{count} Bild(er) [{keyMode}]',
  outFilesCreated: 'Erstellte Dateien:',
  outKeepKeyArtifact:
    'Bewahren Sie den separaten Schlüssel UND Ihr Passwort auf, um wiederherstellen zu können.',
  outSavedGallery:
    'Galerie über {files} Datei(en) gespeichert ({k} Daten + {m} Parität + {decoys} Täuschung) [{keyMode}].',
  outGalleryKeep:
    'Bewahren Sie Ihr Passwort auf; beliebige {k} der Fragment-Fotos stellen es wieder her.',
  outGalleryKeepKey: 'Bewahren Sie auch den separaten Schlüssel auf (Wiederherstellung mit --key).',
  outRestoredOne: 'Wiederhergestellt {name} -> {path}',
  outRestoredMany: '{count} Dateien wiederhergestellt:',
  outDecoded: '{decoded} von {seen} Bild(ern) dekodiert',
  outScanned: '{seen} Foto(s) durchsucht',
  outEstimate: '{images} Bild(er)  (k={k} Daten + m={m} Parität)',

  helpTagline:
    'StegoShard: Verschlüsseln Sie eine Datei in widerstandsfähige Bilder, eine undurchsichtige Datei oder eine Köder-Datenbank, und stellen Sie sie wieder her.',
  helpUsageHeading: 'Aufruf:',
  helpUiHeading: 'Lokale Web-Oberfläche:',
  helpUi:
    'Dieselbe App wie die Browser-Version, nur auf diesem Rechner bereitgestellt. Nicht in den eigenständigen Binaries, die ohne Netzwerkzugriff kompiliert sind.',
  helpSaveHeading: 'save-Optionen:',
  helpSaveIntro:
    'Mehrere Eingaben (oder ein Verzeichnis) werden im Tresor zu einem Archiv gebündelt; beim Wiederherstellen entstehen die Originaldateien erneut. Eine einzelne Eingabe wird unverändert gespeichert.',
  helpRestoreHeading: 'restore-Optionen:',
  helpCommonHeading: 'Allgemein:',
  helpPasswordHeading: 'Passwort (für jeden Befehl, der eines braucht), nach Vorrang:',
  helpEntropyHeading:
    'Zusätzliche Entropie für save / gallery-save (optional, für Fortgeschrittene; betrifft nur die Erzeugung, beim Wiederherstellen ist nichts erneut einzugeben, und der CSPRNG des Systems wird ohnehin immer verwendet), nach Vorrang:',
  helpEntropyNote:
    'Ihr Text wird als zweite Quelle per XOR eingemischt: er kann nur Unsicherheit hinzufügen, den CSPRNG niemals ersetzen, also kann eine schwache Zeichenfolge den Tresor nicht schwächen.',
  helpGalleryHeading:
    'Galerie-Modus (ein Geheimnis, fragmentiert in vielen gewöhnlichen Fotos versteckt):',
  helpGalleryNoDuress:
    '(duress gibt es für die Galerie nicht; verwenden Sie --binary --disguise --mode duress)',
  helpGalleryNote:
    'Jedes Foto wird verändert; die besten K+M tragen Reed-Solomon-Fragmente, der Rest wird zur Täuschung (mindestens 5 Fotos, davon mindestens 2 Täuschungen). Die Wiederherstellung ist blind: alle Fotos, die sich authentifizieren, werden genutzt, und K Fragmente genügen.',
  helpExamplesHeading: 'Beispiele:',

  helpOut: 'Ausgabeverzeichnis (Standard: aktuelles Verzeichnis)',
  helpPaper: 'Ein druckbares PDF (hohe ECC) statt PNGs erzeugen',
  helpZip: 'Die PNGs in einer einzigen .zip bündeln (Disk-Modus)',
  helpBinary: 'Eine einzelne undurchsichtige Datei statt Bildern (bis 1 GiB)',
  helpDisguise: 'Mit --binary: einen SQLite-Datenbank-Header geben (.db)',
  helpMode: 'plain | duress | nonpossession   (nur .db; Standard: plain)',
  helpModeDuress: 'duress: eine Täuschung, die ein 2. Passwort öffnet',
  helpModeNonpossession: 'nonpossession: den Tresor an Anteile binden, die Sie nicht haben',
  helpDecoy: '--mode duress: die plausible Köderdatei',
  helpDuressPasswordFile: '--mode duress: das 2. (Zwangs-)Passwort',
  helpThreshold: '--mode nonpossession: z. B. 2-of-3 (schreibt n Anteilsdateien)',
  helpCodec: 'color | qr   (Standard: color; nur Bilder, nicht --paper)',
  helpCodecColor: 'color: 8-Farben-Raster, ~3x Bytes pro Bild',
  helpCodecQr: 'qr: einfacher QR, von jedem Telefon lesbar',
  helpKeyMode: 'embedded | keyfile | stego   (Standard: embedded)',
  helpCover: 'Titelfoto für --key-mode stego (der Schlüssel steckt darin)',
  helpTitle: 'Lesbare Beschriftung / PDF-Titel',
  helpDate: 'Datum auf den Seiten (Standard: heute)',
  helpLocale: 'Sprache des Anleitungsblatts, z. B. fr, ja, zh_TW',
  helpInstructions: 'Das Anleitungsblatt beilegen (Papier)',
  helpPasswordHint: 'Passwort-Hinweis, auf das Blatt gedruckt',
  helpKeyLocation: 'Wo der Schlüssel liegt, auf das Blatt gedruckt',
  helpFont: 'Eine .ttf/.otf für CJK-Anleitungstext (Papier)',
  helpAllowWeakPassword:
    'Ein schwaches (aber >= 12 Zeichen langes) Passwort für einen neuen Tresor bestätigen. Das Minimum von 12 Zeichen selbst lässt sich damit nicht aufheben, und auch mit keiner anderen Option.',
  helpKey: 'Eine .key-Datei, ein Stego-Bild oder ein binärer Schlüsselcontainer',
  helpShare: 'Eine Anteilsdatei (wiederholbar) für einen nonpossession-Tresor',
  helpForce: 'Vorhandene Ausgabedateien überschreiben (Standard: verweigern)',
  helpQuiet: 'Die Fortschrittsanzeige auf stderr unterdrücken',
  helpPasswordFlag: 'Nicht empfohlen: in Shell-Historie / Prozessliste sichtbar',
  helpPasswordFile: 'Das Passwort aus einer Datei lesen (erste Zeile)',
  helpPasswordEnv: 'Umgebungsvariable',
  helpPasswordPrompt: 'Wird (verdeckt) gefragt, wenn nichts davon gesetzt ist',
  helpEntropyFlag: 'Nicht empfohlen: in Shell-Historie / Prozessliste sichtbar',
  helpEntropyFile: 'Aus einer Datei lesen (ganzer Inhalt, z. B. Würfelwürfe)',
  helpEntropyPrompt: 'Danach (verdeckt) am Terminal fragen (braucht ein TTY)',
  helpEntropyEnv: 'Umgebungsvariable',
  helpGalleryOut: 'Ausgabeverzeichnis für die veränderten Fotos',
  helpGalleryKeyMode: 'embedded (Standard) | keyfile | stego   (gallery-save)',
  helpGalleryCover: 'Titelfoto für --key-mode stego (gallery-save)',
  helpGalleryKey: 'Externer Schlüssel für eine keyfile/stego-Galerie (gallery-restore)',
  helpGalleryMode: 'Die Galerie an Anteile binden (mit --threshold k-of-n)',
  helpGalleryShare: 'Eine Anteilsdatei (wiederholbar) für gallery-restore',
  helpUiPort: 'Auf diesem Port bereitstellen statt auf einem freien',
  helpUiOpen: 'Die Adresse zusätzlich im Browser öffnen',
};
