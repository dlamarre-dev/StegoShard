/** Portuguese. Flag names, environment variables and file extensions stay verbatim. */
import type { CliCatalog } from './index';

export const pt: CliCatalog = {
  errThresholdShape: '--threshold deve ter a forma «2-of-3» (recebido «{spec}»)',
  errThresholdRange: '--threshold fora do intervalo: {spec} (é preciso 1 ≤ k ≤ n ≤ 255)',
  errEntropyWrongCommand: '{command}: as opções --entropy só se aplicam a save e gallery-save',
  errUnknownCommand: 'comando desconhecido «{command}» (tente: stegoshard --help)',
  errSaveMissingInputs: 'save: falta <ficheiro|pasta ...>',
  errSaveKeyMode: 'save: --key-mode «{value}» inválido',
  errSaveStegoCover: 'save: --key-mode stego exige --cover <imagem>',
  errSaveBinaryPaper: 'save: --binary e --paper são mutuamente exclusivos',
  errSaveDisguise: 'save: --disguise exige --binary',
  errSaveMode: 'save: --mode «{value}» inválido',
  errSaveModeNeedsDisguise: 'save: --mode {mode} exige --binary --disguise',
  errSaveDuressDecoy: 'save: --mode duress exige --decoy <ficheiro>',
  errSaveThreshold: 'save: --mode nonpossession exige --threshold k-of-n',
  errRestoreMissing: 'restore: faltam as imagens/pasta/zip/pdf de entrada',
  errGalleryMissingFile: 'gallery-save: falta <ficheiro>',
  errGalleryNoCovers: 'gallery-save: indique fotos de capa ou uma pasta',
  errGalleryKeyMode: 'gallery-save: --key-mode «{value}» inválido',
  errGalleryStegoCover: 'gallery-save: --key-mode stego exige --cover <imagem>',
  errGalleryDuress:
    'gallery-save: --mode duress não existe na galeria; use --binary --disguise --mode duress',
  errGalleryMode: 'gallery-save: --mode «{value}» inválido',
  errGalleryThreshold: 'gallery-save: --mode nonpossession exige --threshold k-of-n',
  errGalleryRestoreMissing: 'gallery-restore: faltam fotos/pasta',
  errCodecInvalid: '--codec «{value}» inválido',
  errCodecColorPaper: '--codec color não pode ser usado com --paper (as páginas impressas usam QR)',
  errEntropyExclusive: '{flags} são mutuamente exclusivos (escolha uma só fonte de entropia)',
  errEntropyFlagEmpty: '--entropy estava vazio (omita a opção se não quiser entropia adicional)',
  errEstimateMissing: 'estimate: falta <ficheiro>',
  errUiPort: 'ui: --port tem de ser um número de porta (recebido «{value}»)',
  errUiNoWebApp:
    'ui: esta versão não inclui a aplicação web.\n' +
    'Os binários autónomos são compilados sem acesso à rede, pelo que não a podem\n' +
    'servir. Use «npx stegoshard ui», ou descarregue o pacote web offline da página\n' +
    'de lançamentos e execute o respetivo script serve.',

  errNoPassword: 'nenhuma palavra-passe indicada (uma palavra-passe vazia não é aceite)',
  errNoDuressPassword:
    'nenhuma palavra-passe de coação indicada (uma palavra-passe vazia não é aceite)',
  errPasswordShort:
    'a {label} é demasiado curta: {length} carácter(es), mínimo {min}. ' +
    'Este mínimo não pode ser dispensado; um atacante offline com o cofre na mão pode tentá-lo à vontade.',
  errWeakAcknowledge:
    '{warning} Execute novamente com --allow-weak-password para aceitar este risco.',
  errWeakCancelled: 'cancelado: a palavra-passe fraca não foi aceite',
  errEntropyFile: '--entropy-file: não é possível ler «{path}»',
  errEntropyPromptTty:
    '--entropy-prompt precisa de um terminal; use --entropy-file ou STEGOSHARD_ENTROPY',
  errEntropyPromptEmpty: '--entropy-prompt: nada foi introduzido',
  errEntropyEmpty: 'a entropia adicional estava vazia (omita-a se não quiser esta camada extra)',

  errWrongPassword: 'palavra-passe incorreta',
  errNoGallery:
    'não foi encontrada nenhuma galeria restaurável (palavra-passe incorreta, ou estas fotos não são uma galeria)',
  errNeedsKey: 'este conjunto de imagens exige uma chave separada (use --key <ficheiro|imagem>)',
  errDuressTooSimilar:
    'a palavra-passe de coação é demasiado parecida com a verdadeira ({reason}); ' +
    'escolha uma palavra-passe de coação sem relação',
  errOverwrite: 'o ficheiro existente não será substituído: {path} (use --force para substituir)',
  errStegoNeedsCover: 'o modo stego exige uma imagem --cover',
  errDuressNeedsPassword: 'save: --mode duress exige uma palavra-passe de coação',
  errNoInputFiles: 'save: não foram encontrados ficheiros de entrada',
  errModeNeedsDisguise: 'save: --mode {mode} só é suportado com --binary --disguise',
  errNoReadableImages: 'não há imagens StegoShard legíveis nas entradas',
  errNoCoversFound: 'galeria: não foram encontradas imagens de capa nos caminhos indicados',
  errNoGalleryImages: 'galeria: não foram encontradas imagens nas entradas',

  warnPasswordFlag:
    'Aviso: --password fica visível no histórico da shell e na lista de processos; ' +
    'prefira STEGOSHARD_PASSWORD, --password-file ou a pergunta interativa.',
  warnEntropyFlag:
    'Aviso: --entropy fica visível no histórico da shell e na lista de processos; ' +
    'prefira STEGOSHARD_ENTROPY, --entropy-file ou --entropy-prompt.',
  warnWeakPassword:
    'Aviso: a {label} é fraca (cerca de {bits} bits). ' +
    'Um cofre offline pode ser adivinhado sem que ninguém o contacte.',
  warnPrefix: 'Aviso: {message}',
  labelPassword: 'palavra-passe',
  promptPassword: 'Palavra-passe: ',
  promptDuressPassword: 'Palavra-passe de coação: ',
  promptEntropy: 'Entropia adicional (escreva ao acaso ou cole lançamentos de dados): ',
  promptAllow: 'Escreva ALLOW para continuar: ',

  phaseCompress: 'A comprimir',
  phaseEncrypt: 'A cifrar',
  phaseDecrypt: 'A decifrar',
  phaseVerify: 'A verificar',
  phaseUnlock: 'A desbloquear',
  phaseRender: 'A gerar',

  purposeVault: 'o cofre: contém o seu ficheiro',
  purposeArchive: 'todas as imagens reunidas num .zip',
  purposeDocument: 'folha imprimível',
  purposePhotos: 'fotos fragmento: guarde o conjunto inteiro',
  purposeKeyfile: 'chave separada: necessária com a sua palavra-passe',
  purposeStegoCover: 'foto que leva a chave escondida',
  purposeShare: 'parte de recuperação, para um detentor',

  outSaved: 'Guardado: {what}.',
  outSavedBinary: 'cofre binário ({variant}) [{keyMode}]',
  outSavedImages: '{count} imagem(ns) [{keyMode}]',
  outFilesCreated: 'Ficheiros criados:',
  outKeepKeyArtifact: 'Guarde a chave separada E a sua palavra-passe para poder restaurar.',
  outSavedGallery:
    'Galeria guardada em {files} ficheiro(s) ({k} de dados + {m} de paridade + {decoys} isca) [{keyMode}].',
  outGalleryKeep: 'Guarde a sua palavra-passe; quaisquer {k} das fotos fragmento restauram-na.',
  outGalleryKeepKey: 'Guarde também a chave separada (restauro com --key).',
  outRestoredOne: 'Restaurado {name} -> {path}',
  outRestoredMany: '{count} ficheiros restaurados:',
  outDecoded: '{decoded} de {seen} imagem(ns) descodificada(s)',
  outScanned: '{seen} foto(s) analisada(s)',
  outEstimate: '{images} imagem(ns)  (k={k} dados + m={m} paridade)',

  helpTagline:
    'StegoShard: cifre um ficheiro em imagens resilientes, num ficheiro opaco ou numa base de dados isca, e restaure-o.',
  helpUsageHeading: 'Utilização:',
  helpUiHeading: 'Interface web local:',
  helpUi:
    'A mesma aplicação da versão para navegador, servida apenas nesta máquina. Não existe nos binários autónomos, compilados sem acesso à rede.',
  helpSaveHeading: 'Opções de save:',
  helpSaveIntro:
    'Várias entradas (ou uma pasta) são reunidas num arquivo dentro do cofre; o restauro devolve os ficheiros originais. Uma única entrada é guardada tal como está.',
  helpRestoreHeading: 'Opções de restore:',
  helpCommonHeading: 'Comuns:',
  helpPasswordHeading:
    'Palavra-passe (para qualquer comando que precise), por ordem de precedência:',
  helpEntropyHeading:
    'Entropia adicional para save / gallery-save (opcional, avançado; afeta apenas a geração, nada a reintroduzir no restauro, e o CSPRNG do sistema é sempre usado), por ordem de precedência:',
  helpEntropyNote:
    'O seu texto é misturado (XOR) como segunda fonte: só pode acrescentar incerteza, nunca substituir o CSPRNG, pelo que uma cadeia fraca não pode enfraquecer o cofre.',
  helpGalleryHeading:
    'Modo galeria (um segredo escondido, fragmentado, entre muitas fotos comuns):',
  helpGalleryNoDuress: '(duress não existe na galeria; use --binary --disguise --mode duress)',
  helpGalleryNote:
    'Todas as fotos são modificadas; as melhores K+M levam fragmentos Reed-Solomon e as restantes tornam-se iscas (mínimo 5 fotos, pelo menos 2 iscas). O restauro é cego: usam-se todas as fotos que se autenticam, e K fragmentos bastam para reconstruir.',
  helpExamplesHeading: 'Exemplos:',

  helpOut: 'Pasta de saída (por omissão: a pasta atual)',
  helpPaper: 'Produzir um PDF imprimível (ECC alto) em vez de PNG',
  helpZip: 'Reunir os PNG num único .zip (modo disco)',
  helpBinary: 'Um único ficheiro opaco em vez de imagens (até 1 GiB)',
  helpDisguise: 'Com --binary: dar-lhe um cabeçalho de base SQLite (.db)',
  helpMode: 'plain | duress | nonpossession   (só .db; por omissão: plain)',
  helpModeDuress: 'duress: uma isca que abre com uma 2.ª palavra-passe',
  helpModeNonpossession: 'nonpossession: liga o cofre a partes que não possui',
  helpDecoy: '--mode duress: o ficheiro isca plausível',
  helpDuressPasswordFile: '--mode duress: a 2.ª palavra-passe (de coação)',
  helpThreshold: '--mode nonpossession: ex. 2-of-3 (escreve n ficheiros)',
  helpCodec: 'color | qr   (por omissão: color; só imagens, não --paper)',
  helpCodecColor: 'color: grelha de 8 cores, ~3x bytes por imagem',
  helpCodecQr: 'qr: QR simples, legível por qualquer telefone',
  helpKeyMode: 'embedded | keyfile | stego   (por omissão: embedded)',
  helpCover: 'Foto de capa para --key-mode stego (a chave vai lá dentro)',
  helpTitle: 'Etiqueta legível / título do PDF',
  helpDate: 'Data mostrada nas páginas (por omissão: hoje)',
  helpLocale: 'Idioma da folha de instruções, ex. fr, ja, zh_TW',
  helpInstructions: 'Incluir a folha de instruções de restauro (papel)',
  helpPasswordHint: 'Pista da palavra-passe impressa na folha',
  helpKeyLocation: 'Onde a chave é guardada, impresso na folha',
  helpFont: 'Um .ttf/.otf para o texto CJK das instruções (papel)',
  helpAllowWeakPassword:
    'Aceitar uma palavra-passe fraca (mas com >= 12 caracteres) para um cofre novo. O mínimo de 12 caracteres não pode ser dispensado por esta nem por qualquer outra opção.',
  helpKey: 'Um ficheiro .key, uma imagem estego ou um contentor de chave binário',
  helpShare: 'Um ficheiro de parte (repetível) para um cofre nonpossession',
  helpForce: 'Substituir os ficheiros de saída existentes (por omissão: recusa)',
  helpQuiet: 'Ocultar o indicador de progresso no stderr',
  helpPasswordFlag: 'Não recomendado: visível no histórico / lista de processos',
  helpPasswordFile: 'Ler a palavra-passe de um ficheiro (primeira linha)',
  helpPasswordEnv: 'Variável de ambiente',
  helpPasswordPrompt: 'Pedida (oculta) se nada do anterior for indicado',
  helpEntropyFlag: 'Não recomendado: visível no histórico / lista de processos',
  helpEntropyFile: 'Lê-la de um ficheiro (todo o conteúdo, ex. lançamentos de dados)',
  helpEntropyPrompt: 'Pedi-la (oculta) no terminal (precisa de um TTY)',
  helpEntropyEnv: 'Variável de ambiente',
  helpGalleryOut: 'Pasta de saída para as fotos modificadas',
  helpGalleryKeyMode: 'embedded (por omissão) | keyfile | stego   (gallery-save)',
  helpGalleryCover: 'Foto de capa para --key-mode stego (gallery-save)',
  helpGalleryKey: 'Chave externa para uma galeria keyfile/stego (gallery-restore)',
  helpGalleryMode: 'Ligar a galeria a partes (com --threshold k-of-n)',
  helpGalleryShare: 'Um ficheiro de parte (repetível) para gallery-restore',
  helpUiPort: 'Servir nesta porta em vez de numa porta livre',
  helpUiOpen: 'Abrir também o endereço no navegador',
};
