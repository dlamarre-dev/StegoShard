/** Italian. Flag names, environment variables and file extensions stay verbatim. */
import type { CliCatalog } from './index';

export const it: CliCatalog = {
  errThresholdShape: '--threshold deve avere la forma «2-of-3» (ricevuto «{spec}»)',
  errThresholdRange: '--threshold fuori intervallo: {spec} (serve 1 ≤ k ≤ n ≤ 255)',
  errEntropyWrongCommand: '{command}: le opzioni --entropy valgono solo per save e gallery-save',
  errUnknownCommand: 'comando sconosciuto «{command}» (prova: stegoshard --help)',
  errSaveMissingInputs: 'save: manca <file|cartella ...>',
  errSaveKeyMode: 'save: --key-mode «{value}» non valido',
  errSaveStegoCover: 'save: --key-mode stego richiede --cover <immagine>',
  errSaveBinaryPaper: 'save: --binary e --paper si escludono a vicenda',
  errSaveDisguise: 'save: --disguise richiede --binary',
  errSaveMode: 'save: --mode «{value}» non valido',
  errSaveModeNeedsDisguise: 'save: --mode {mode} richiede --binary --disguise',
  errSaveDuressDecoy: 'save: --mode duress richiede --decoy <file>',
  errSaveThreshold: 'save: --mode nonpossession richiede --threshold k-of-n',
  errRestoreMissing: 'restore: mancano immagini/cartella/zip/pdf in ingresso',
  errGalleryMissingFile: 'gallery-save: manca <file>',
  errGalleryNoCovers: 'gallery-save: indica delle foto di copertina o una cartella',
  errGalleryKeyMode: 'gallery-save: --key-mode «{value}» non valido',
  errGalleryStegoCover: 'gallery-save: --key-mode stego richiede --cover <immagine>',
  errGalleryDuress:
    'gallery-save: --mode duress non esiste per la galleria; usa --binary --disguise --mode duress',
  errGalleryMode: 'gallery-save: --mode «{value}» non valido',
  errGalleryThreshold: 'gallery-save: --mode nonpossession richiede --threshold k-of-n',
  errGalleryRestoreMissing: 'gallery-restore: mancano foto/cartella',
  errCodecInvalid: '--codec «{value}» non valido',
  errCodecColorPaper: '--codec color non si può usare con --paper (le pagine stampate usano il QR)',
  errEntropyExclusive: '{flags} si escludono a vicenda (scegli una sola fonte di entropia)',
  errEntropyFlagEmpty: '--entropy era vuoto (ometti l’opzione se non vuoi entropia aggiuntiva)',
  errEstimateMissing: 'estimate: manca <file>',
  errUiPort: 'ui: --port deve essere un numero di porta (ricevuto «{value}»)',
  errUiNoWebApp:
    'ui: questa build non contiene l’applicazione web.\n' +
    'I binari autonomi sono compilati senza accesso alla rete, quindi non possono\n' +
    'servirla. Usa «npx stegoshard ui», oppure scarica il pacchetto web offline dalla\n' +
    'pagina delle release ed esegui il suo script serve.',

  errNoPassword: 'nessuna password fornita (una password vuota non è ammessa)',
  errNoDuressPassword: 'nessuna password di coercizione fornita (una password vuota non è ammessa)',
  errPasswordShort:
    'la {label} è troppo corta: {length} carattere(i), minimo {min}. ' +
    'Questo minimo non è aggirabile; un attaccante offline che possiede il caveau può provarci con calma.',
  errWeakAcknowledge: '{warning} Rilancia con --allow-weak-password per accettare questo rischio.',
  errWeakCancelled: 'annullato: la password debole non è stata accettata',
  errEntropyFile: '--entropy-file: impossibile leggere «{path}»',
  errEntropyPromptTty:
    '--entropy-prompt richiede un terminale; usa --entropy-file o STEGOSHARD_ENTROPY',
  errEntropyPromptEmpty: '--entropy-prompt: non è stato inserito nulla',
  errEntropyEmpty: 'l’entropia aggiuntiva era vuota (omettila se non vuoi questo strato in più)',

  errWrongPassword: 'password errata',
  errNoGallery:
    'nessuna galleria ripristinabile trovata (password errata, o queste foto non sono una galleria)',
  errNeedsKey: 'questo set di immagini richiede una chiave separata (usa --key <file|immagine>)',
  errDuressTooSimilar:
    'la password di coercizione è troppo simile a quella reale ({reason}); ' +
    'scegli una password di coercizione senza relazione',
  errOverwrite: 'il file esistente non viene sovrascritto: {path} (usa --force per sovrascrivere)',
  errStegoNeedsCover: 'la modalità stego richiede un’immagine --cover',
  errDuressNeedsPassword: 'save: --mode duress richiede una password di coercizione',
  errNoInputFiles: 'save: nessun file di ingresso trovato',
  errModeNeedsDisguise: 'save: --mode {mode} è supportato solo con --binary --disguise',
  errNoReadableImages: 'nessuna immagine StegoShard leggibile negli ingressi',
  errNoCoversFound: 'galleria: nessuna immagine di copertina trovata nei percorsi indicati',
  errNoGalleryImages: 'galleria: nessuna immagine trovata negli ingressi',

  warnPasswordFlag:
    'Attenzione: --password è visibile nella cronologia della shell e nell’elenco dei processi; ' +
    'preferisci STEGOSHARD_PASSWORD, --password-file o la richiesta interattiva.',
  warnEntropyFlag:
    'Attenzione: --entropy è visibile nella cronologia della shell e nell’elenco dei processi; ' +
    'preferisci STEGOSHARD_ENTROPY, --entropy-file o --entropy-prompt.',
  warnWeakPassword:
    'Attenzione: la {label} è debole (circa {bits} bit). ' +
    'Un caveau offline può essere indovinato senza contattarti.',
  warnPrefix: 'Attenzione: {message}',
  labelPassword: 'password',
  promptPassword: 'Password: ',
  promptDuressPassword: 'Password di coercizione: ',
  promptEntropy: 'Entropia aggiuntiva (digita a caso o incolla lanci di dadi): ',
  promptAllow: 'Digita ALLOW per continuare: ',

  phaseCompress: 'Compressione',
  phaseEncrypt: 'Cifratura',
  phaseDecrypt: 'Decifratura',
  phaseVerify: 'Verifica',
  phaseUnlock: 'Sblocco',
  phaseRender: 'Generazione',

  purposeVault: 'il caveau: contiene il tuo file',
  purposeArchive: 'tutte le immagini raccolte in un .zip',
  purposeDocument: 'foglio stampabile',
  purposePhotos: 'foto frammento: conserva l’intero set',
  purposeKeyfile: 'chiave separata: serve con la tua password',
  purposeStegoCover: 'foto che contiene la chiave nascosta',
  purposeShare: 'quota di recupero, per un detentore',

  outSaved: 'Salvato: {what}.',
  outSavedBinary: 'caveau binario ({variant}) [{keyMode}]',
  outSavedImages: '{count} immagine/i [{keyMode}]',
  outFilesCreated: 'File creati:',
  outKeepKeyArtifact: 'Conserva la chiave separata E la tua password per poter ripristinare.',
  outSavedGallery:
    'Galleria salvata su {files} file ({k} dati + {m} parità + {decoys} esca) [{keyMode}].',
  outGalleryKeep: 'Conserva la password; {k} qualsiasi delle foto frammento la ripristinano.',
  outGalleryKeepKey: 'Conserva anche la chiave separata (ripristino con --key).',
  outRestoredOne: 'Ripristinato {name} -> {path}',
  outRestoredMany: '{count} file ripristinati:',
  outDecoded: '{decoded} immagine/i decodificate su {seen}',
  outScanned: '{seen} foto analizzate',
  outEstimate: '{images} immagine/i  (k={k} dati + m={m} parità)',

  helpTagline:
    'StegoShard: cifra un file in immagini resilienti, un file opaco o un database esca, e ripristinalo.',
  helpUsageHeading: 'Uso:',
  helpUiHeading: 'Interfaccia web locale:',
  helpUi:
    'La stessa applicazione della versione per browser, servita solo su questa macchina. Assente dai binari autonomi, compilati senza accesso alla rete.',
  helpSaveHeading: 'Opzioni di save:',
  helpSaveIntro:
    'Più ingressi (o una cartella) vengono raccolti in un archivio dentro il caveau; il ripristino li riporta ai file originali. Un solo ingresso viene salvato così com’è.',
  helpRestoreHeading: 'Opzioni di restore:',
  helpCommonHeading: 'Comuni:',
  helpPasswordHeading: 'Password (per ogni comando che ne ha bisogno), in ordine di precedenza:',
  helpEntropyHeading:
    'Entropia aggiuntiva per save / gallery-save (opzionale, avanzata; riguarda solo la generazione, non va reinserita al ripristino, e il CSPRNG del sistema è sempre usato), in ordine di precedenza:',
  helpEntropyNote:
    'Il tuo testo viene mescolato (XOR) come seconda fonte: può solo aggiungere incertezza, mai sostituire il CSPRNG, quindi una stringa debole non può indebolire il caveau.',
  helpGalleryHeading:
    'Modalità galleria (un segreto nascosto, frammentato, tra molte foto ordinarie):',
  helpGalleryNoDuress: '(duress non esiste per la galleria; usa --binary --disguise --mode duress)',
  helpGalleryNote:
    'Tutte le foto vengono modificate; le migliori K+M portano i frammenti Reed-Solomon e le altre diventano esche (minimo 5 foto, almeno 2 esche). Il ripristino è cieco: si usano tutte le foto che si autenticano, e K frammenti bastano a ricostruire.',
  helpExamplesHeading: 'Esempi:',

  helpOut: 'Cartella di uscita (predefinita: la cartella corrente)',
  helpPaper: 'Produrre un PDF stampabile (ECC alto) invece dei PNG',
  helpZip: 'Raccogliere i PNG in un solo .zip (modalità disco)',
  helpBinary: 'Un solo file opaco invece delle immagini (fino a 1 GiB)',
  helpDisguise: 'Con --binary: dargli un’intestazione di database SQLite (.db)',
  helpMode: 'plain | duress | nonpossession   (solo .db; predefinito: plain)',
  helpModeDuress: 'duress: un’esca che si apre con una 2ª password',
  helpModeNonpossession: 'nonpossession: lega il caveau a quote che non possiedi',
  helpDecoy: '--mode duress: il file esca plausibile',
  helpDuressPasswordFile: '--mode duress: la 2ª password (di coercizione)',
  helpThreshold: '--mode nonpossession: es. 2-of-3 (scrive n file di quote)',
  helpCodec: 'color | qr   (predefinito: color; solo immagini, non --paper)',
  helpCodecColor: 'color: griglia a 8 colori, ~3x byte per immagine',
  helpCodecQr: 'qr: QR semplice, leggibile da qualsiasi telefono',
  helpKeyMode: 'embedded | keyfile | stego   (predefinito: embedded)',
  helpCover: 'Foto di copertina per --key-mode stego (la chiave sta dentro)',
  helpTitle: 'Etichetta leggibile / titolo del PDF',
  helpDate: 'Data mostrata sulle pagine (predefinita: oggi)',
  helpLocale: 'Lingua del foglio di istruzioni, es. fr, ja, zh_TW',
  helpInstructions: 'Includere il foglio di istruzioni per il ripristino (carta)',
  helpPasswordHint: 'Suggerimento della password stampato sul foglio',
  helpKeyLocation: 'Dove è conservata la chiave, stampato sul foglio',
  helpFont: 'Un .ttf/.otf per il testo CJK delle istruzioni (carta)',
  helpAllowWeakPassword:
    'Accettare una password debole (ma di >= 12 caratteri) per un nuovo caveau. Il minimo di 12 caratteri non è aggirabile né con questa né con altre opzioni.',
  helpKey: 'Un file .key, un’immagine stego o un contenitore di chiave binario',
  helpShare: 'Un file di quota (ripetibile) per un caveau nonpossession',
  helpForce: 'Sovrascrivere i file di uscita esistenti (predefinito: rifiuta)',
  helpQuiet: 'Nascondere l’indicatore di avanzamento su stderr',
  helpPasswordFlag: 'Sconsigliato: visibile nella cronologia / elenco processi',
  helpPasswordFile: 'Leggere la password da un file (prima riga)',
  helpPasswordEnv: 'Variabile d’ambiente',
  helpPasswordPrompt: 'Richiesta (nascosta) se nessuna delle precedenti è data',
  helpEntropyFlag: 'Sconsigliato: visibile nella cronologia / elenco processi',
  helpEntropyFile: 'Leggerla da un file (tutto il contenuto, es. lanci di dadi)',
  helpEntropyPrompt: 'Chiederla (nascosta) al terminale (serve un TTY)',
  helpEntropyEnv: 'Variabile d’ambiente',
  helpGalleryOut: 'Cartella di uscita per le foto modificate',
  helpGalleryKeyMode: 'embedded (predefinito) | keyfile | stego   (gallery-save)',
  helpGalleryCover: 'Foto di copertina per --key-mode stego (gallery-save)',
  helpGalleryKey: 'Chiave esterna per una galleria keyfile/stego (gallery-restore)',
  helpGalleryMode: 'Legare la galleria a delle quote (con --threshold k-of-n)',
  helpGalleryShare: 'Un file di quota (ripetibile) per gallery-restore',
  helpUiPort: 'Servire su questa porta invece di una libera',
  helpUiOpen: 'Aprire anche l’indirizzo nel browser',
};
