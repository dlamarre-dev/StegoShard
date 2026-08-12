StegoShard, applicazione web offline
===================================

English: README.txt | Français: README.fr.txt | Deutsch: README.de.txt
Español: README.es.txt | Português: README.pt.txt | 日本語: README.ja.txt
繁體中文: README.zh_TW.txt

Perché index.html non si apre direttamente
------------------------------------------

Fare doppio clic su index.html non funzionerà in nessun browser. L'applicazione è
costruita con moduli ES ed esegue la crittografia in un module worker, e per motivi
di sicurezza i browser rifiutano di caricare entrambi via file://. Non è un limite
di StegoShard, e non esiste un'impostazione che lo cambi.

I file devono quindi essere serviti via HTTP. Questo non significa andare online:
il server qui sotto ascolta solo sulla tua macchina, e all'applicazione stessa la
Content-Security-Policy vieta qualsiasi richiesta di rete. Nulla di ciò che salvi o
ripristini lascia questo computer.

Come avviarlo
-------------

Con Node.js installato (versione 20 o successiva):

    Windows    fai doppio clic su serve.cmd
    macOS      ./serve.sh          (oppure: node serve.mjs --open)
    Linux      ./serve.sh          (oppure: node serve.mjs --open)

Stampa un indirizzo http://127.0.0.1:…; aprilo. Lascia la finestra in esecuzione
mentre la scheda è aperta, e fermala con Ctrl+C quando hai finito.

    node serve.mjs --port 8137     fissare la porta invece di prenderne una libera
    node serve.mjs                 stampare l'indirizzo senza aprire il browser

Senza Node.js va bene qualsiasi cosa che serva file statici da questa cartella:

    python3 -m http.server 8137
    poi apri http://127.0.0.1:8137/

Non servire questo su una rete condivisa. L'indirizzo stampato è di proposito solo
locale, e il percorso che contiene è un token casuale, così nient'altro sulla
macchina può indovinarlo.

Da tenere presente
------------------

Usare l'applicazione in un browser lascia tracce che lo strumento a riga di comando
non lascia: la cache e la cronologia del browser, la sua cartella dei download e
una piccola preferenza con la lingua e il formato immagine scelti. Se questo conta
per ciò che stai conservando, usa piuttosto la riga di comando e leggi
docs/THREAT-MODEL.md nel repository del codice.

La tua password non è recuperabile. Se la perdi, il caveau è perso.

StegoShard è distribuito con licenza MIT; vedi LICENSE e THIRD_PARTY_NOTICES.txt
accanto a questo file. Codice: https://github.com/dlamarre-dev/StegoShard
