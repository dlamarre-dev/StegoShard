<!-- lang: de · review: translated + light copy-edit · optional native check before 1.0 · target ≤2500 chars · store long description -->

**Sperren Sie eine kleine, wertvolle Datei mit einem Passwort — und bewahren Sie sie dort auf, wo sie wirklich erhalten bleibt, oder dort, wo niemand sie findet.**

StegoShard verwandelt eine sensible Datei — einen Export aus dem Passwort-Manager, die Wiederherstellungsphrase einer Krypto-Wallet, Backup-Codes, private Schlüssel, eine geheime Notiz — in etwas, das Sie jahrelang sicher aufbewahren können. Verschlüsseln Sie sie und wählen Sie dann: als robuste, fehlerkorrigierte Bilder speichern (oder als druckbare Seite oder als einzelne Datei), die das Drucken, Kopieren und erneute Herunterladen überstehen — oder unsichtbar in einem ganz normal aussehenden Foto verstecken, sodass niemand von ihrer Existenz weiß. Oder beides zugleich.

Alles geschieht auf Ihrem eigenen Gerät. Nichts wird hochgeladen, kein Konto nötig, und es funktioniert offline.

**Was Sie damit tun können**
- Den Export Ihres Passwort-Managers sichern und jahrelang aufbewahren, ohne einem Cloud-Anbieter zu vertrauen — und ihn ausdrucken, damit die Daten nicht verloren gehen, wenn der Laptop ausfällt.
- Eine Krypto-Wallet-Wiederherstellungsphrase schützen — winzig, unersetzlich und ohne „Passwort vergessen“-Funktion.
- Ein verschlüsseltes Backup als QR-Code-PDF drucken und später durch Abscannen der Seiten mit der Handykamera wiederherstellen — selbst wenn eine Seite verloren geht oder Flecken bekommt.
- Ein Passwort- oder Schlüssel-Backup in einem Familienfoto verstecken, das in Ihrem Album liegt, sodass schon seine Existenz unauffällig bleibt.
- Ein Geheimnis über mehrere gewöhnliche Fotos und Köder verteilen — einige zu verlieren ist kein Problem.
- Konto-Wiederherstellungscodes aufbewahren und die Originaldatei Byte für Byte zurückbekommen, selbst wenn einige Kopien beschädigt sind.

**Funktionen**
- Passwortbasierte Verschlüsselung; Ihr Schlüssel verlässt nie das Gerät (Argon2id + AES-256-GCM)
- Geheimnisse in gewöhnlichen Fotos verstecken — ein JPEG bleibt ein JPEG, ein PNG bleibt ein PNG
- Fehlerkorrektur über mehrere Bilder: Verlieren Sie eine Seite oder ein Foto und stellen Sie trotzdem wieder her
- Druckbarer Papier-/QR-Export, wiederherstellbar per Scan oder Handyfoto
- Auf Datenträger als Bilder oder als einzelne .zip speichern, oder als eine einzelne Datei, deren Inhalt nicht erkennbar ist
- Köder-Datenbank (.db) als Ausgabe und Galerie-Modus (verteilt über Alltagsfotos)
- Drei Wege für den Schlüssel: eingebettet, separate Schlüsseldatei oder in einem Foto versteckt
- Passwortstärke-Anzeige und Passphrasen-Generator, mit Hilfe beim ersten Start
- Läuft in Chrome, Edge und Firefox, dazu eine passende Web-App ohne Installation

**Auf Privatsphäre ausgelegt**
Kostenlos und Open Source (MIT). Kein Konto, kein Tracking, nichts verlässt Ihr Gerät. Ihre Daten überleben die App: Eine kostenlose Web-App und ein unabhängiger Decoder können Ihren Tresor immer wiederherstellen, und das Dateiformat ist eingefroren und versioniert.

**Bitte beachten**
StegoShard ist für kleine Geheimnisse gedacht, nicht für Backups ganzer Festplatten. Es gibt keine Wiederherstellung, wenn Sie Ihr Passwort verlieren — bewahren Sie es sicher auf. Ein verstecktes Geheimnis bleibt vor einem beiläufigen Blick unauffällig; es ist keine Garantie gegen eine professionelle digitale Forensik. Dies ist Beta-Software.

Quellcode, Dokumentation und Web-App: https://github.com/dlamarre-dev/StegoShard
