/**
 * Japanese. Flag names, environment variables and file extensions stay verbatim.
 * Like the app's ja catalog, this needs a native review before 1.0
 * (docs/LOCALIZATION.md).
 */
import type { CliCatalog } from './index';

export const ja: CliCatalog = {
  errThresholdShape: '--threshold は「2-of-3」の形式で指定してください（受け取った値: {spec}）',
  errThresholdRange: '--threshold が範囲外です: {spec}（1 ≤ k ≤ n ≤ 255 が必要）',
  errEntropyWrongCommand: '{command}: --entropy オプションは save と gallery-save でのみ使えます',
  errUnknownCommand: '不明なコマンド「{command}」（stegoshard --help をお試しください）',
  errSaveMissingInputs: 'save: <ファイル|ディレクトリ ...> がありません',
  errSaveKeyMode: 'save: --key-mode「{value}」は無効です',
  errSaveStegoCover: 'save: --key-mode stego には --cover <画像> が必要です',
  errSaveBinaryPaper: 'save: --binary と --paper は同時に使えません',
  errSaveDisguise: 'save: --disguise には --binary が必要です',
  errSaveMode: 'save: --mode「{value}」は無効です',
  errSaveModeNeedsDisguise: 'save: --mode {mode} には --binary --disguise が必要です',
  errSaveDuressDecoy: 'save: --mode duress には --decoy <ファイル> が必要です',
  errSaveThreshold: 'save: --mode nonpossession には --threshold k-of-n が必要です',
  errRestoreMissing: 'restore: 入力の画像/フォルダー/zip/pdf がありません',
  errGalleryMissingFile: 'gallery-save: <ファイル> がありません',
  errGalleryNoCovers: 'gallery-save: カバー写真かフォルダーを指定してください',
  errGalleryKeyMode: 'gallery-save: --key-mode「{value}」は無効です',
  errGalleryStegoCover: 'gallery-save: --key-mode stego には --cover <画像> が必要です',
  errGalleryDuress:
    'gallery-save: ギャラリーでは --mode duress を使えません。--binary --disguise --mode duress をお使いください',
  errGalleryMode: 'gallery-save: --mode「{value}」は無効です',
  errGalleryThreshold: 'gallery-save: --mode nonpossession には --threshold k-of-n が必要です',
  errGalleryRestoreMissing: 'gallery-restore: 写真/フォルダーがありません',
  errCodecInvalid: '--codec「{value}」は無効です',
  errCodecColorPaper: '--codec color は --paper と併用できません（印刷ページは QR を使います）',
  errEntropyExclusive: '{flags} は同時に指定できません（エントロピー源は 1 つだけ）',
  errEntropyFlagEmpty:
    '--entropy が空でした（追加エントロピーが不要ならオプションを外してください）',
  errEstimateMissing: 'estimate: <ファイル> がありません',
  errUiPort: 'ui: --port はポート番号で指定してください（受け取った値: {value}）',
  errUiNoWebApp:
    'ui: このビルドにはウェブアプリが含まれていません。\n' +
    'スタンドアロンのバイナリはネットワークアクセスなしでコンパイルされているため、\n' +
    '配信できません。「npx stegoshard ui」を使うか、リリースページからオフライン版の\n' +
    'ウェブ一式をダウンロードして、その serve スクリプトを実行してください。',

  errNoPassword: 'パスワードが指定されていません（空のパスワードは使えません）',
  errNoDuressPassword: '強要用パスワードが指定されていません（空のパスワードは使えません）',
  errPasswordShort:
    '{label}が短すぎます: {length} 文字、最低 {min} 文字必要です。' +
    'この下限は解除できません。保管庫を手にしたオフラインの攻撃者は、いくらでも試行できます。',
  errWeakAcknowledge:
    '{warning} このリスクを承知の上で続けるには --allow-weak-password を付けて再実行してください。',
  errWeakCancelled: '中止しました: 弱いパスワードは承認されませんでした',
  errEntropyFile: '--entropy-file:「{path}」を読み取れません',
  errEntropyPromptTty:
    '--entropy-prompt には端末が必要です。--entropy-file か STEGOSHARD_ENTROPY をお使いください',
  errEntropyPromptEmpty: '--entropy-prompt: 何も入力されませんでした',
  errEntropyEmpty: '追加エントロピーが空でした（この層が不要なら指定しないでください）',

  errWrongPassword: 'パスワードが違います',
  errNoGallery:
    '復元できるギャラリーが見つかりません（パスワードが違う、またはこれらはギャラリーの写真ではありません）',
  errNeedsKey: 'この画像セットには別の鍵が必要です（--key <ファイル|画像> を使ってください）',
  errDuressTooSimilar:
    '強要用パスワードが本物と似すぎています（{reason}）。' +
    '無関係な強要用パスワードを選んでください',
  errOverwrite: '既存のファイルを上書きしません: {path}（上書きするには --force）',
  errStegoNeedsCover: 'stego モードには --cover 画像が必要です',
  errDuressNeedsPassword: 'save: --mode duress には強要用パスワードが必要です',
  errNoInputFiles: 'save: 入力ファイルが見つかりません',
  errModeNeedsDisguise: 'save: --mode {mode} は --binary --disguise でのみ使えます',
  errNoReadableImages: '入力の中に読み取れる StegoShard の画像がありません',
  errNoCoversFound: 'ギャラリー: 指定されたパスにカバー画像が見つかりません',
  errNoGalleryImages: 'ギャラリー: 入力の中に画像が見つかりません',

  warnPasswordFlag:
    '警告: --password はシェルの履歴やプロセス一覧に見えてしまいます。' +
    'STEGOSHARD_PASSWORD、--password-file、または対話入力をお使いください。',
  warnEntropyFlag:
    '警告: --entropy はシェルの履歴やプロセス一覧に見えてしまいます。' +
    'STEGOSHARD_ENTROPY、--entropy-file、または --entropy-prompt をお使いください。',
  warnWeakPassword:
    '警告: {label}が弱いです（推定 {bits} ビット）。' +
    'オフラインの保管庫は、あなたに連絡せずに推測を試せます。',
  warnPrefix: '警告: {message}',
  labelPassword: 'パスワード',
  promptPassword: 'パスワード: ',
  promptDuressPassword: '強要用パスワード: ',
  promptEntropy: '追加エントロピー（ランダムに入力、またはサイコロの結果を貼り付け）: ',
  promptAllow: '続けるには ALLOW と入力してください: ',

  phaseCompress: '圧縮中',
  phaseEncrypt: '暗号化中',
  phaseDecrypt: '復号中',
  phaseVerify: '検証中',
  phaseUnlock: 'ロック解除中',
  phaseRender: '生成中',

  purposeVault: '保管庫: ファイル本体が入っています',
  purposeArchive: 'すべての画像を 1 つの .zip にまとめたもの',
  purposeDocument: '印刷用シート',
  purposePhotos: '断片の写真: セット全体を保管してください',
  purposeKeyfile: '別鍵: パスワードと併せて必要です',
  purposeStegoCover: '鍵を隠した写真',
  purposeShare: '復元シェア、保有者 1 名分',

  outSaved: '保存しました: {what}。',
  outSavedBinary: 'バイナリ保管庫（{variant}）[{keyMode}]',
  outSavedImages: '{count} 枚の画像 [{keyMode}]',
  outFilesCreated: '作成したファイル:',
  outKeepKeyArtifact: '復元するには、別鍵とパスワードの両方を保管してください。',
  outSavedGallery:
    'ギャラリーを {files} 個のファイルに保存しました（データ {k} + パリティ {m} + おとり {decoys}）[{keyMode}]。',
  outGalleryKeep: 'パスワードを保管してください。断片写真のうち任意の {k} 枚で復元できます。',
  outGalleryKeepKey: '別鍵も保管してください（復元時は --key）。',
  outRestoredOne: '復元しました {name} -> {path}',
  outRestoredMany: '{count} 個のファイルを復元しました:',
  outDecoded: '{seen} 枚のうち {decoded} 枚を復号しました',
  outScanned: '{seen} 枚の写真を走査しました',
  outEstimate: '{images} 枚の画像  （k={k} データ + m={m} パリティ）',

  helpTagline:
    'StegoShard: ファイルを、復元性の高い画像・中身の見えない単一ファイル・囮データベースのいずれかに暗号化し、元に戻します。',
  helpUsageHeading: '使い方:',
  helpUiHeading: 'ローカルのウェブ画面:',
  helpUi:
    'ブラウザー版と同じアプリを、このマシン上だけで配信します。ネットワークアクセスなしでコンパイルされたスタンドアロンのバイナリには含まれません。',
  helpSaveHeading: 'save のオプション:',
  helpSaveIntro:
    '複数の入力（またはディレクトリ）は保管庫の中で 1 つのアーカイブにまとめられ、復元時に元のファイルに戻ります。入力が 1 つのときはそのまま格納されます。',
  helpRestoreHeading: 'restore のオプション:',
  helpCommonHeading: '共通:',
  helpPasswordHeading: 'パスワード（必要なすべてのコマンド）、優先順:',
  helpEntropyHeading:
    'save / gallery-save 用の追加エントロピー（任意、上級者向け。生成時のみに影響し、復元時に再入力は不要。OS の CSPRNG は常に使われます）、優先順:',
  helpEntropyNote:
    '入力した文字列は 2 番目の源として XOR で混ぜられます。不確実性を足すことしかできず、CSPRNG を置き換えることはないため、弱い文字列で保管庫が弱くなることはありません。',
  helpGalleryHeading: 'ギャラリーモード（多数のふつうの写真に、秘密を断片化して隠します）:',
  helpGalleryNoDuress:
    '（ギャラリーに duress はありません。--binary --disguise --mode duress をお使いください）',
  helpGalleryNote:
    'すべての写真が変更されます。最良の K+M 枚が Reed-Solomon の断片を持ち、残りはおとりになります（合計 5 枚以上、うちおとり 2 枚以上）。復元は手探りで行われ、認証できた写真がすべて使われ、K 個の断片があれば再構成できます。',
  helpExamplesHeading: '例:',

  helpOut: '出力ディレクトリ（既定: カレントディレクトリ）',
  helpPaper: 'PNG ではなく印刷用 PDF（高 ECC）を作る',
  helpZip: 'PNG 一式を 1 つの .zip にまとめる（ディスクモード）',
  helpBinary: '画像ではなく中身の見えない単一ファイルを出力（最大 1 GiB）',
  helpDisguise: '--binary と併用: SQLite データベースのヘッダーを付ける（.db）',
  helpMode: 'plain | duress | nonpossession   （.db のみ、既定: plain）',
  helpModeDuress: 'duress: 2 つ目のパスワードで開くおとり',
  helpModeNonpossession: 'nonpossession: 手元にないシェアで保管庫を封じる',
  helpDecoy: '--mode duress: もっともらしいおとりファイル',
  helpDuressPasswordFile: '--mode duress: 2 つ目（強要用）のパスワード',
  helpThreshold: '--mode nonpossession: 例 2-of-3（n 個のシェアを書き出す）',
  helpCodec: 'color | qr   （既定: color、画像のみ。--paper には不可）',
  helpCodecColor: 'color: 8 色グリッド、1 枚あたり約 3 倍のバイト数',
  helpCodecQr: 'qr: ふつうの QR、どの携帯でも読める',
  helpKeyMode: 'embedded | keyfile | stego   （既定: embedded）',
  helpCover: '--key-mode stego 用のカバー写真（この中に鍵を隠す）',
  helpTitle: '人が読めるラベル / PDF のタイトル',
  helpDate: 'ページに表示する日付（既定: 今日）',
  helpLocale: '説明シートの言語。例: fr, ja, ko, zh_TW',
  helpInstructions: '復元手順のシートを同梱する（紙）',
  helpPasswordHint: 'シートに印刷するパスワードのヒント',
  helpKeyLocation: '鍵の保管場所。シートに印刷されます',
  helpFont: '説明文の CJK 用 .ttf/.otf（紙）',
  helpAllowWeakPassword:
    '新しい保管庫に、弱い（ただし 12 文字以上の）パスワードを承知の上で使う。12 文字という下限そのものは、この指定でも他のどの指定でも解除できません。',
  helpKey: '.key ファイル、ステゴ画像、またはバイナリの鍵コンテナ',
  helpShare: 'nonpossession の保管庫用のシェアファイル（繰り返し指定可）',
  helpForce: '既存の出力ファイルを上書きする（既定: 拒否）',
  helpQuiet: 'stderr の進捗表示を出さない',
  helpPasswordFlag: '非推奨: シェル履歴やプロセス一覧に見えます',
  helpPasswordFile: 'ファイルからパスワードを読む（1 行目）',
  helpPasswordEnv: '環境変数',
  helpPasswordPrompt: '上記がどれも無いときに（非表示で）尋ねます',
  helpEntropyFlag: '非推奨: シェル履歴やプロセス一覧に見えます',
  helpEntropyFile: 'ファイルから読む（全内容。例: サイコロの結果）',
  helpEntropyPrompt: '端末で（非表示で）尋ねる（TTY が必要）',
  helpEntropyEnv: '環境変数',
  helpGalleryOut: '変更後の写真の出力ディレクトリ',
  helpGalleryKeyMode: 'embedded（既定）| keyfile | stego   （gallery-save）',
  helpGalleryCover: '--key-mode stego 用のカバー写真（gallery-save）',
  helpGalleryKey: 'keyfile/stego のギャラリー用の外部鍵（gallery-restore）',
  helpGalleryMode: 'ギャラリーをシェアで封じる（--threshold k-of-n と併用）',
  helpGalleryShare: 'gallery-restore 用のシェアファイル（繰り返し指定可）',
  helpUiPort: '空きポートではなく、このポートで配信する',
  helpUiOpen: 'アドレスを表示するだけでなく、ブラウザーでも開く',
};
