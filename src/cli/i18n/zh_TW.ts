/**
 * Traditional Chinese. Flag names, environment variables and file extensions stay
 * verbatim. Like the app's zh_TW catalog, this needs a native review before 1.0
 * (docs/LOCALIZATION.md).
 */
import type { CliCatalog } from './index';

export const zhTW: CliCatalog = {
  errThresholdShape: '--threshold 必須是「2-of-3」的格式（收到「{spec}」）',
  errThresholdRange: '--threshold 超出範圍：{spec}（需要 1 ≤ k ≤ n ≤ 255）',
  errEntropyWrongCommand: '{command}：--entropy 選項只適用於 save 與 gallery-save',
  errUnknownCommand: '未知的指令「{command}」（請試 stegoshard --help）',
  errSaveMissingInputs: 'save：缺少 <檔案|資料夾 ...>',
  errSaveKeyMode: 'save：--key-mode「{value}」無效',
  errSaveStegoCover: 'save：--key-mode stego 需要 --cover <圖片>',
  errSaveBinaryPaper: 'save：--binary 與 --paper 不能同時使用',
  errSaveDisguise: 'save：--disguise 需要 --binary',
  errSaveMode: 'save：--mode「{value}」無效',
  errSaveModeNeedsDisguise: 'save：--mode {mode} 需要 --binary --disguise',
  errSaveDuressDecoy: 'save：--mode duress 需要 --decoy <檔案>',
  errSaveThreshold: 'save：--mode nonpossession 需要 --threshold k-of-n',
  errRestoreMissing: 'restore：缺少輸入的圖片/資料夾/zip/pdf',
  errGalleryMissingFile: 'gallery-save：缺少 <檔案>',
  errGalleryNoCovers: 'gallery-save：請提供封面照片或一個資料夾',
  errGalleryKeyMode: 'gallery-save：--key-mode「{value}」無效',
  errGalleryStegoCover: 'gallery-save：--key-mode stego 需要 --cover <圖片>',
  errGalleryDuress:
    'gallery-save：相簿不支援 --mode duress；請使用 --binary --disguise --mode duress',
  errGalleryMode: 'gallery-save：--mode「{value}」無效',
  errGalleryThreshold: 'gallery-save：--mode nonpossession 需要 --threshold k-of-n',
  errGalleryRestoreMissing: 'gallery-restore：缺少照片/資料夾',
  errCodecInvalid: '--codec「{value}」無效',
  errCodecColorPaper: '--codec color 不能與 --paper 並用（列印頁面使用 QR）',
  errEntropyExclusive: '{flags} 不能同時指定（亂度來源只能選一個）',
  errEntropyFlagEmpty: '--entropy 是空的（若不需要額外亂度，請不要加這個選項）',
  errEstimateMissing: 'estimate：缺少 <檔案>',
  errUiPort: 'ui：--port 必須是通訊埠號（收到「{value}」）',
  errUiNoWebApp:
    'ui：這個組建不含網頁應用程式。\n' +
    '獨立執行檔在編譯時沒有網路存取權，因此無法提供服務。請使用\n' +
    '「npx stegoshard ui」，或從發行頁面下載離線網頁套件，\n' +
    '並執行其中的 serve 指令檔。',

  errNoPassword: '未提供密碼（不允許空白密碼）',
  errNoDuressPassword: '未提供脅迫密碼（不允許空白密碼）',
  errPasswordShort:
    '{label}太短：{length} 個字元，至少需要 {min} 個。' +
    '這個下限無法略過；離線的攻擊者一旦拿到保險庫，就能慢慢地嘗試。',
  errWeakAcknowledge: '{warning} 若已了解風險，請加上 --allow-weak-password 重新執行。',
  errWeakCancelled: '已取消：未確認使用弱密碼',
  errEntropyFile: '--entropy-file：無法讀取「{path}」',
  errEntropyPromptTty: '--entropy-prompt 需要終端機；請改用 --entropy-file 或 STEGOSHARD_ENTROPY',
  errEntropyPromptEmpty: '--entropy-prompt：沒有輸入任何內容',
  errEntropyEmpty: '額外亂度是空的（若不需要這一層，請不要指定）',

  errWrongPassword: '密碼錯誤',
  errNoGallery: '找不到可還原的相簿（密碼錯誤，或這些照片不是相簿）',
  errNeedsKey: '這組圖片需要獨立的金鑰（請使用 --key <檔案|圖片>）',
  errDuressTooSimilar: '脅迫密碼與真正的密碼太相似（{reason}）；請另選一個毫無關聯的脅迫密碼',
  errOverwrite: '不覆寫既有檔案：{path}（要覆寫請加 --force）',
  errStegoNeedsCover: 'stego 模式需要一張 --cover 圖片',
  errDuressNeedsPassword: 'save：--mode duress 需要一個脅迫密碼',
  errNoInputFiles: 'save：找不到輸入檔案',
  errModeNeedsDisguise: 'save：--mode {mode} 只能與 --binary --disguise 一起使用',
  errNoReadableImages: '輸入中沒有可讀取的 StegoShard 圖片',
  errNoCoversFound: '相簿：在指定的路徑中找不到封面圖片',
  errNoGalleryImages: '相簿：輸入中找不到圖片',

  warnPasswordFlag:
    '警告：--password 會出現在 shell 歷史與處理程序清單中；' +
    '建議改用 STEGOSHARD_PASSWORD、--password-file 或互動式輸入。',
  warnEntropyFlag:
    '警告：--entropy 會出現在 shell 歷史與處理程序清單中；' +
    '建議改用 STEGOSHARD_ENTROPY、--entropy-file 或 --entropy-prompt。',
  warnWeakPassword:
    '警告：{label}偏弱（估計 {bits} 位元）。離線的保險庫可以在不聯絡您的情況下被猜測。',
  warnPrefix: '警告：{message}',
  labelPassword: '密碼',
  promptPassword: '密碼：',
  promptDuressPassword: '脅迫密碼：',
  promptEntropy: '額外亂度（隨意輸入，或貼上骰子結果）：',
  promptAllow: '請輸入 ALLOW 以繼續：',

  phaseCompress: '壓縮中',
  phaseEncrypt: '加密中',
  phaseDecrypt: '解密中',
  phaseVerify: '驗證中',
  phaseUnlock: '解鎖中',
  phaseRender: '產生中',

  purposeVault: '保險庫：存放您的檔案',
  purposeArchive: '所有圖片打包成一個 .zip',
  purposeDocument: '可列印的頁面',
  purposePhotos: '碎片照片：請保留整組',
  purposeKeyfile: '獨立金鑰：需與密碼一起使用',
  purposeStegoCover: '藏有金鑰的照片',
  purposeShare: '復原分片，供一位持有者保管',

  outSaved: '已儲存：{what}。',
  outSavedBinary: '二進位保險庫（{variant}）[{keyMode}]',
  outSavedImages: '{count} 張圖片 [{keyMode}]',
  outFilesCreated: '已建立的檔案：',
  outKeepKeyArtifact: '請同時保留獨立金鑰與您的密碼，才能還原。',
  outSavedGallery:
    '相簿已儲存於 {files} 個檔案（{k} 個資料 + {m} 個同位 + {decoys} 個誘餌）[{keyMode}]。',
  outGalleryKeep: '請保管好密碼；碎片照片中任意 {k} 張即可還原。',
  outGalleryKeepKey: '也請保留獨立金鑰（還原時用 --key）。',
  outRestoredOne: '已還原 {name} -> {path}',
  outRestoredMany: '已還原 {count} 個檔案：',
  outDecoded: '已解碼 {seen} 張中的 {decoded} 張',
  outScanned: '已掃描 {seen} 張照片',
  outEstimate: '{images} 張圖片  （k={k} 資料 + m={m} 同位）',

  helpTagline: 'StegoShard：把檔案加密成具韌性的圖片、不透明的單一檔案，或誘餌資料庫，並可還原。',
  helpUsageHeading: '用法：',
  helpUiHeading: '本機網頁介面：',
  helpUi:
    '與瀏覽器版本相同的應用程式，只在這台電腦上提供服務。獨立執行檔在編譯時沒有網路存取權，因此不含此功能。',
  helpSaveHeading: 'save 的選項：',
  helpSaveIntro:
    '多個輸入（或一個資料夾）會在保險庫內打包成一個封存檔；還原時會回復成原本的檔案。單一輸入則原樣存放。',
  helpRestoreHeading: 'restore 的選項：',
  helpCommonHeading: '通用：',
  helpPasswordHeading: '密碼（任何需要密碼的指令），依優先順序：',
  helpEntropyHeading:
    'save / gallery-save 的額外亂度（選用，進階；只影響產生階段，還原時無需重新輸入，而且系統的 CSPRNG 一律會使用），依優先順序：',
  helpEntropyNote:
    '您輸入的文字會作為第二個來源以 XOR 混入：它只能增加不確定性，永遠不會取代 CSPRNG，因此弱字串不會讓保險庫變弱。',
  helpGalleryHeading: '相簿模式（把祕密切成碎片，藏在許多普通照片中）：',
  helpGalleryNoDuress: '（相簿不支援 duress；請使用 --binary --disguise --mode duress）',
  helpGalleryNote:
    '所有照片都會被修改；最適合的 K+M 張帶有 Reed-Solomon 碎片，其餘成為誘餌（至少 5 張照片，其中至少 2 張誘餌）。還原是盲式的：所有能通過驗證的照片都會被使用，任意 K 個碎片即可重建。',
  helpExamplesHeading: '範例：',

  helpOut: '輸出資料夾（預設：目前資料夾）',
  helpPaper: '產生可列印的 PDF（高 ECC），而非 PNG',
  helpZip: '把整組 PNG 打包成單一 .zip（磁碟模式）',
  helpBinary: '輸出單一不透明檔案，而非圖片（最多 1 GiB）',
  helpDisguise: '與 --binary 並用：加上 SQLite 資料庫標頭（.db）',
  helpMode: 'plain | duress | nonpossession   （僅 .db；預設：plain）',
  helpModeDuress: 'duress： 用第 2 組密碼開啟的誘餌',
  helpModeNonpossession: 'nonpossession：以您手上沒有的分片鎖住保險庫',
  helpDecoy: '--mode duress：看起來合理的誘餌檔案',
  helpDuressPasswordFile: '--mode duress：第 2 組（脅迫）密碼',
  helpThreshold: '--mode nonpossession：例如 2-of-3（寫出 n 個分片檔）',
  helpCodec: 'color | qr   （預設：color；僅圖片，不適用 --paper）',
  helpCodecColor: 'color：8 色格點，每張圖約 3 倍位元組',
  helpCodecQr: 'qr： 普通 QR 碼，任何手機都能讀',
  helpKeyMode: 'embedded | keyfile | stego   （預設：embedded）',
  helpCover: '--key-mode stego 的封面照片（金鑰藏在其中）',
  helpTitle: '可讀的標籤 / PDF 標題',
  helpDate: '頁面上顯示的日期（預設：今天）',
  helpLocale: '說明頁的語言，例如 fr、ja、ko、zh_TW',
  helpInstructions: '附上還原說明頁（紙本）',
  helpPasswordHint: '印在說明頁上的密碼提示',
  helpKeyLocation: '金鑰存放位置，會印在說明頁上',
  helpFont: '說明文字 CJK 所需的 .ttf/.otf（紙本）',
  helpAllowWeakPassword:
    '為新的保險庫確認使用弱密碼（但仍須 >= 12 個字元）。12 個字元的下限本身，無法用這個或任何其他選項略過。',
  helpKey: '一個 .key 檔、隱寫圖片，或二進位金鑰容器',
  helpShare: 'nonpossession 保險庫的分片檔（可重複指定）',
  helpForce: '覆寫既有的輸出檔（預設：拒絕）',
  helpQuiet: '不在 stderr 顯示進度',
  helpPasswordFlag: '不建議：會出現在 shell 歷史／處理程序清單',
  helpPasswordFile: '從檔案讀取密碼（第一行）',
  helpPasswordEnv: '環境變數',
  helpPasswordPrompt: '以上皆未提供時，會（隱藏地）詢問',
  helpEntropyFlag: '不建議：會出現在 shell 歷史／處理程序清單',
  helpEntropyFile: '從檔案讀取（全部內容，例如骰子結果）',
  helpEntropyPrompt: '在終端機（隱藏地）詢問（需要 TTY）',
  helpEntropyEnv: '環境變數',
  helpGalleryOut: '修改後照片的輸出資料夾',
  helpGalleryKeyMode: 'embedded（預設）| keyfile | stego   （gallery-save）',
  helpGalleryCover: '--key-mode stego 的封面照片（gallery-save）',
  helpGalleryKey: 'keyfile/stego 相簿所需的外部金鑰（gallery-restore）',
  helpGalleryMode: '以分片鎖住相簿（搭配 --threshold k-of-n）',
  helpGalleryShare: 'gallery-restore 用的分片檔（可重複指定）',
  helpUiPort: '在這個通訊埠提供服務，而不是任意空閒的埠',
  helpUiOpen: '除了顯示網址，也在瀏覽器中開啟',
};
