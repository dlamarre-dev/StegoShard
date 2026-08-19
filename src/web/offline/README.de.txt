StegoShard, Offline-Web-App
===========================

English: README.txt | Français: README.fr.txt | Español: README.es.txt
Italiano: README.it.txt | Português: README.pt.txt | 日本語: README.ja.txt
한국어: README.ko.txt | 繁體中文: README.zh_TW.txt

Warum sich index.html nicht direkt öffnen lässt
-----------------------------------------------

Ein Doppelklick auf index.html funktioniert in keinem Browser. Die App besteht aus
ES-Modulen und führt ihre Kryptografie in einem Modul-Worker aus; Browser
verweigern aus Sicherheitsgründen, beides über file:// zu laden. Das ist keine
Einschränkung von StegoShard, und keine Einstellung ändert es.

Die Dateien müssen also über HTTP bereitgestellt werden. Das heißt nicht, online zu
gehen: der Server unten lauscht nur auf Ihrem eigenen Rechner, und der App selbst
verbietet ihre Content-Security-Policy jede Netzwerkanfrage. Nichts, was Sie
speichern oder wiederherstellen, verlässt diesen Computer.

Starten
-------

Mit installiertem Node.js (Version 20 oder neuer):

    Windows    serve.cmd doppelklicken
    macOS      ./serve.sh          (oder: node serve.mjs --open)
    Linux      ./serve.sh          (oder: node serve.mjs --open)

Es wird eine Adresse http://127.0.0.1:… ausgegeben; öffnen Sie diese. Lassen Sie
das Fenster laufen, solange der Tab offen ist, und beenden Sie es am Ende mit
Ctrl+C.

    node serve.mjs --port 8137     Port festlegen statt einen freien zu nehmen
    node serve.mjs                 Adresse ausgeben, ohne den Browser zu öffnen

Ohne Node.js genügt alles, was statische Dateien aus diesem Verzeichnis
bereitstellt:

    python3 -m http.server 8137
    dann http://127.0.0.1:8137/ öffnen

Stellen Sie dies nicht in einem gemeinsam genutzten Netzwerk bereit. Die
ausgegebene Adresse ist absichtlich nur über die Loopback-Schnittstelle
erreichbar, und der Pfad darin ist ein zufälliges Token, damit nichts anderes auf
dem Rechner ihn erraten kann.

Was zu bedenken ist
-------------------

Die App im Browser zu benutzen hinterlässt Spuren, die das Kommandozeilen-Werkzeug
nicht hinterlässt: Cache und Verlauf des Browsers, sein Download-Ordner und ein
kleiner Eintrag für die gewählte Sprache und das Bildformat. Wenn das für das
zählt, was Sie speichern, nutzen Sie stattdessen das Kommandozeilen-Werkzeug und
lesen Sie docs/THREAT-MODEL.md im Quell-Repository.

Ihr Passwort ist nicht wiederherstellbar. Wenn Sie es verlieren, ist der Tresor
verloren.

StegoShard steht unter der MIT-Lizenz; siehe LICENSE und THIRD_PARTY_NOTICES.txt
neben dieser Datei. Quelle: https://github.com/dlamarre-dev/StegoShard
