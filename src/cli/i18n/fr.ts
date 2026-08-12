/** French. Flag names, environment variables and file extensions stay verbatim. */
import type { CliCatalog } from './index';

export const fr: CliCatalog = {
  errThresholdShape: '--threshold doit ressembler à « 2-of-3 » (reçu « {spec} »)',
  errThresholdRange: '--threshold hors limites : {spec} (il faut 1 ≤ k ≤ n ≤ 255)',
  errEntropyWrongCommand:
    '{command} : les options --entropy ne concernent que save et gallery-save',
  errUnknownCommand: 'commande inconnue « {command} » (essayez : stegoshard --help)',
  errSaveMissingInputs: 'save : <fichier|dossier ...> manquant',
  errSaveKeyMode: 'save : --key-mode « {value} » invalide',
  errSaveStegoCover: 'save : --key-mode stego exige --cover <image>',
  errSaveBinaryPaper: 'save : --binary et --paper sont mutuellement exclusifs',
  errSaveDisguise: 'save : --disguise exige --binary',
  errSaveMode: 'save : --mode « {value} » invalide',
  errSaveModeNeedsDisguise: 'save : --mode {mode} exige --binary --disguise',
  errSaveDuressDecoy: 'save : --mode duress exige --decoy <fichier>',
  errSaveThreshold: 'save : --mode nonpossession exige --threshold k-of-n',
  errRestoreMissing: 'restore : images/dossier/zip/pdf en entrée manquants',
  errGalleryMissingFile: 'gallery-save : <fichier> manquant',
  errGalleryNoCovers: 'gallery-save : indiquez des photos de couverture ou un dossier',
  errGalleryKeyMode: 'gallery-save : --key-mode « {value} » invalide',
  errGalleryStegoCover: 'gallery-save : --key-mode stego exige --cover <image>',
  errGalleryDuress:
    'gallery-save : --mode duress n’est pas disponible pour la galerie ; utilisez --binary --disguise --mode duress',
  errGalleryMode: 'gallery-save : --mode « {value} » invalide',
  errGalleryThreshold: 'gallery-save : --mode nonpossession exige --threshold k-of-n',
  errGalleryRestoreMissing: 'gallery-restore : photos/dossier manquants',
  errCodecInvalid: '--codec « {value} » invalide',
  errCodecColorPaper:
    '--codec color est incompatible avec --paper (les pages imprimées utilisent le QR)',
  errEntropyExclusive:
    '{flags} sont mutuellement exclusifs (choisissez une seule source d’entropie)',
  errEntropyFlagEmpty:
    '--entropy était vide (omettez l’option si vous ne voulez pas d’entropie supplémentaire)',
  errEstimateMissing: 'estimate : <fichier> manquant',
  errUiPort: 'ui : --port doit être un numéro de port (reçu « {value} »)',
  errUiNoWebApp:
    'ui : cette version ne contient pas l’application web.\n' +
    'Les binaires autonomes sont compilés sans accès réseau et ne peuvent donc pas\n' +
    'la servir. Utilisez « npx stegoshard ui », ou téléchargez le paquet web hors\n' +
    'ligne depuis la page des versions et lancez son script serve.',

  errNoPassword: 'aucun mot de passe fourni (un mot de passe vide est refusé)',
  errNoDuressPassword: 'aucun mot de passe de contrainte fourni (un mot de passe vide est refusé)',
  errPasswordShort:
    'le {label} est trop court : {length} caractère(s), minimum {min}. ' +
    'Ce plancher ne peut pas être levé ; un attaquant hors ligne qui détient le coffre peut le forcer à loisir.',
  errWeakAcknowledge: '{warning} Relancez avec --allow-weak-password pour accepter ce risque.',
  errWeakCancelled: 'annulé : le mot de passe faible n’a pas été accepté',
  errEntropyFile: '--entropy-file : lecture impossible de « {path} »',
  errEntropyPromptTty:
    '--entropy-prompt exige un terminal ; utilisez --entropy-file ou STEGOSHARD_ENTROPY',
  errEntropyPromptEmpty: '--entropy-prompt : rien n’a été saisi',
  errEntropyEmpty:
    'l’entropie supplémentaire était vide (omettez-la si vous ne voulez pas cette couche)',

  errWrongPassword: 'mot de passe incorrect',
  errNoGallery:
    'aucune galerie restaurable trouvée (mot de passe incorrect, ou ces photos ne sont pas une galerie)',
  errNeedsKey: 'ce jeu d’images exige une clé séparée (utilisez --key <fichier|image>)',
  errDuressTooSimilar:
    'le mot de passe de contrainte est trop proche du vrai ({reason}) ; ' +
    'choisissez un mot de passe de contrainte sans rapport',
  errOverwrite: 'refus d’écraser le fichier existant : {path} (utilisez --force pour écraser)',
  errStegoNeedsCover: 'le mode stego exige une image --cover',
  errDuressNeedsPassword: 'save : --mode duress exige un mot de passe de contrainte',
  errNoInputFiles: 'save : aucun fichier d’entrée trouvé',
  errModeNeedsDisguise: 'save : --mode {mode} n’est pris en charge qu’avec --binary --disguise',
  errNoReadableImages: 'aucune image StegoShard lisible dans les entrées',
  errNoCoversFound: 'galerie : aucune image de couverture trouvée dans les chemins indiqués',
  errNoGalleryImages: 'galerie : aucune image trouvée dans les entrées',

  warnPasswordFlag:
    'Attention : --password est visible dans l’historique du shell et la liste des processus ; ' +
    'préférez STEGOSHARD_PASSWORD, --password-file, ou la saisie interactive.',
  warnEntropyFlag:
    'Attention : --entropy est visible dans l’historique du shell et la liste des processus ; ' +
    'préférez STEGOSHARD_ENTROPY, --entropy-file, ou --entropy-prompt.',
  warnWeakPassword:
    'Attention : le {label} est faible (environ {bits} bits). ' +
    'Un coffre hors ligne peut être deviné sans vous contacter.',
  warnPrefix: 'Attention : {message}',
  labelPassword: 'mot de passe',
  promptPassword: 'Mot de passe : ',
  promptDuressPassword: 'Mot de passe de contrainte : ',
  promptEntropy: 'Entropie supplémentaire (tapez au hasard ou collez des jets de dés) : ',
  promptAllow: 'Tapez ALLOW pour continuer : ',

  phaseCompress: 'Compression',
  phaseEncrypt: 'Chiffrement',
  phaseDecrypt: 'Déchiffrement',
  phaseVerify: 'Vérification',
  phaseUnlock: 'Déverrouillage',
  phaseRender: 'Rendu',

  purposeVault: 'le coffre : contient votre fichier',
  purposeArchive: 'toutes les images réunies dans un .zip',
  purposeDocument: 'feuille imprimable',
  purposePhotos: 'photos fragments : conservez tout le lot',
  purposeKeyfile: 'clé séparée : requise avec votre mot de passe',
  purposeStegoCover: 'photo contenant la clé cachée',
  purposeShare: 'part de récupération, pour un détenteur',

  outSaved: 'Enregistré : {what}.',
  outSavedBinary: 'coffre binaire ({variant}) [{keyMode}]',
  outSavedImages: '{count} image(s) [{keyMode}]',
  outFilesCreated: 'Fichiers créés :',
  outKeepKeyArtifact: 'Conservez la clé séparée ET votre mot de passe pour pouvoir restaurer.',
  outSavedGallery:
    'Galerie enregistrée dans {files} fichier(s) ({k} de données + {m} de parité + {decoys} leurre) [{keyMode}].',
  outGalleryKeep: 'Conservez votre mot de passe ; {k} des photos fragments suffisent à restaurer.',
  outGalleryKeepKey: 'Conservez aussi la clé séparée (restauration avec --key).',
  outRestoredOne: 'Restauré {name} -> {path}',
  outRestoredMany: '{count} fichiers restaurés :',
  outDecoded: '{decoded} image(s) décodée(s) sur {seen}',
  outScanned: '{seen} photo(s) analysée(s)',
  outEstimate: '{images} image(s)  (k={k} données + m={m} parité)',

  helpTagline:
    'StegoShard : chiffrez un fichier en images résilientes, en fichier opaque ou en base de données leurre, et restaurez-le.',
  helpUsageHeading: 'Utilisation :',
  helpUiHeading: 'Interface web locale :',
  helpUi:
    'La même application que la version navigateur, servie sur cette machine uniquement. Absente des binaires autonomes, compilés sans accès réseau.',
  helpSaveHeading: 'Options de save :',
  helpSaveIntro:
    'Plusieurs entrées (ou un dossier) sont réunies dans une archive à l’intérieur du coffre ; la restauration les rétablit à l’identique. Une seule entrée est stockée telle quelle.',
  helpRestoreHeading: 'Options de restore :',
  helpCommonHeading: 'Communes :',
  helpPasswordHeading:
    'Mot de passe (pour toute commande qui en a besoin), par ordre de priorité :',
  helpEntropyHeading:
    'Entropie supplémentaire pour save / gallery-save (facultatif, expert ; n’affecte que la génération, rien à ressaisir à la restauration, et le CSPRNG du système est utilisé dans tous les cas), par ordre de priorité :',
  helpEntropyNote:
    'Votre texte est mélangé (XOR) comme seconde source : il ne peut qu’ajouter de l’incertitude, jamais remplacer le CSPRNG, donc une chaîne faible ne peut pas affaiblir le coffre.',
  helpGalleryHeading:
    'Mode galerie (un secret caché, fragmenté, dans de nombreuses photos ordinaires) :',
  helpGalleryNoDuress:
    '(le mode duress n’existe pas pour la galerie ; utilisez --binary --disguise --mode duress)',
  helpGalleryNote:
    'Toutes les photos sont modifiées ; les K+M meilleures portent les fragments Reed-Solomon et les autres deviennent des leurres (5 photos minimum, dont au moins 2 leurres). La restauration est aveugle : toutes les photos qui s’authentifient sont utilisées, et K fragments suffisent à reconstruire.',
  helpExamplesHeading: 'Exemples :',

  helpOut: 'Dossier de sortie (par défaut : dossier courant)',
  helpPaper: 'Produire un PDF imprimable (ECC élevé) au lieu de PNG',
  helpZip: 'Réunir les PNG dans un seul .zip (mode disque)',
  helpBinary: 'Produire un seul fichier opaque au lieu d’images (jusqu’à 1 Gio)',
  helpDisguise: 'Avec --binary : lui donner un en-tête de base SQLite (.db)',
  helpMode: 'plain | duress | nonpossession   (.db uniquement ; par défaut : plain)',
  helpModeDuress: 'duress : un leurre qui s’ouvre avec un 2e mot de passe',
  helpModeNonpossession: 'nonpossession : verrouille le coffre sur des parts que vous n’avez pas',
  helpDecoy: '--mode duress : le fichier leurre plausible',
  helpDuressPasswordFile: '--mode duress : le 2e mot de passe (de contrainte)',
  helpThreshold: '--mode nonpossession : ex. 2-of-3 (écrit n fichiers de parts)',
  helpCodec: 'color | qr   (par défaut : color ; images seulement, pas --paper)',
  helpCodecColor: 'color : grille 8 couleurs, ~3x d’octets par image',
  helpCodecQr: 'qr : QR simple, lisible par tout téléphone',
  helpKeyMode: 'embedded | keyfile | stego   (par défaut : embedded)',
  helpCover: 'Photo de couverture pour --key-mode stego (la clé y est cachée)',
  helpTitle: 'Étiquette lisible / titre du PDF',
  helpDate: 'Date affichée sur les pages (par défaut : aujourd’hui)',
  helpLocale: 'Langue de la feuille d’instructions, ex. fr, ja, zh_TW',
  helpInstructions: 'Inclure la feuille d’instructions de restauration (papier)',
  helpPasswordHint: 'Indice de mot de passe imprimé sur la feuille',
  helpKeyLocation: 'Où la clé est conservée, imprimé sur la feuille',
  helpFont: 'Un .ttf/.otf pour le texte CJK des instructions (papier)',
  helpAllowWeakPassword:
    'Accepter un mot de passe faible (mais >= 12 caractères) pour un nouveau coffre. Le minimum de 12 caractères, lui, ne peut être levé par aucune option.',
  helpKey: 'Un fichier .key, une image stégo, ou un conteneur de clé binaire',
  helpShare: 'Un fichier de part (répétable) pour un coffre nonpossession',
  helpForce: 'Écraser les fichiers de sortie existants (par défaut : refuser)',
  helpQuiet: 'Masquer l’indicateur de progression sur stderr',
  helpPasswordFlag: 'Déconseillé : visible dans l’historique / la liste des processus',
  helpPasswordFile: 'Lire le mot de passe dans un fichier (première ligne)',
  helpPasswordEnv: 'Variable d’environnement',
  helpPasswordPrompt: 'Demandé (masqué) si rien de ce qui précède n’est fourni',
  helpEntropyFlag: 'Déconseillé : visible dans l’historique / la liste des processus',
  helpEntropyFile: 'La lire dans un fichier (tout le contenu, ex. des jets de dés)',
  helpEntropyPrompt: 'La demander (masquée) au terminal (exige un TTY)',
  helpEntropyEnv: 'Variable d’environnement',
  helpGalleryOut: 'Dossier de sortie pour les photos modifiées',
  helpGalleryKeyMode: 'embedded (défaut) | keyfile | stego   (gallery-save)',
  helpGalleryCover: 'Photo de couverture pour --key-mode stego (gallery-save)',
  helpGalleryKey: 'Clé externe pour une galerie keyfile/stego (gallery-restore)',
  helpGalleryMode: 'Verrouiller la galerie sur des parts (avec --threshold k-of-n)',
  helpGalleryShare: 'Un fichier de part (répétable) pour gallery-restore',
  helpUiPort: 'Servir sur ce port au lieu d’un port libre',
  helpUiOpen: 'Ouvrir aussi l’adresse dans le navigateur, en plus de l’afficher',
};
