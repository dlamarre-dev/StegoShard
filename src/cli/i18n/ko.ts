/**
 * Korean. Flag names, environment variables and file extensions stay verbatim.
 * Like the app's ko catalog, this needs a native review before 1.0
 * (docs/LOCALIZATION.md).
 */
import type { CliCatalog } from './index';

export const ko: CliCatalog = {
  errThresholdShape: '--threshold 은 "2-of-3" 형식이어야 합니다(받은 값: "{spec}")',
  errThresholdRange: '--threshold 범위를 벗어났습니다: {spec}(1 ≤ k ≤ n ≤ 255 이어야 합니다)',
  errEntropyWrongCommand: '{command}: --entropy 옵션은 save 와 gallery-save 에서만 쓸 수 있습니다',
  errUnknownCommand: '알 수 없는 명령 "{command}"(stegoshard --help 를 참고하세요)',
  errSaveMissingInputs: 'save: <파일|디렉터리 ...> 가 없습니다',
  errSaveKeyMode: 'save: --key-mode "{value}" 는 올바르지 않습니다',
  errSaveStegoCover: 'save: --key-mode stego 에는 --cover <이미지> 가 필요합니다',
  errSaveBinaryPaper: 'save: --binary 와 --paper 는 함께 쓸 수 없습니다',
  errSaveDisguise: 'save: --disguise 에는 --binary 가 필요합니다',
  errSaveMode: 'save: --mode "{value}" 는 올바르지 않습니다',
  errSaveModeNeedsDisguise: 'save: --mode {mode} 에는 --binary --disguise 가 필요합니다',
  errSaveDuressDecoy: 'save: --mode duress 에는 --decoy <파일> 이 필요합니다',
  errSaveThreshold: 'save: --mode nonpossession 에는 --threshold k-of-n 이 필요합니다',
  errRestoreMissing: 'restore: 입력 이미지/폴더/zip/pdf 가 없습니다',
  errGalleryMissingFile: 'gallery-save: <파일> 이 없습니다',
  errGalleryNoCovers: 'gallery-save: 커버 사진 또는 폴더를 지정하세요',
  errGalleryKeyMode: 'gallery-save: --key-mode "{value}" 는 올바르지 않습니다',
  errGalleryStegoCover: 'gallery-save: --key-mode stego 에는 --cover <이미지> 가 필요합니다',
  errGalleryDuress:
    'gallery-save: --mode duress 는 갤러리에서 쓸 수 없습니다. --binary --disguise --mode duress 를 사용하세요',
  errGalleryMode: 'gallery-save: --mode "{value}" 는 올바르지 않습니다',
  errGalleryThreshold: 'gallery-save: --mode nonpossession 에는 --threshold k-of-n 이 필요합니다',
  errGalleryRestoreMissing: 'gallery-restore: 사진/폴더가 없습니다',
  errCodecInvalid: '--codec "{value}" 는 올바르지 않습니다',
  errCodecColorPaper: '--codec color 는 --paper 와 함께 쓸 수 없습니다(인쇄 페이지는 QR 을 씁니다)',
  errEntropyExclusive: '{flags} 는 함께 쓸 수 없습니다(엔트로피 원본을 하나만 고르세요)',
  errEntropyFlagEmpty:
    '--entropy 가 비어 있습니다(추가 엔트로피를 원하지 않으면 이 플래그를 빼세요)',
  errEstimateMissing: 'estimate: <파일> 이 없습니다',
  errUiPort: 'ui: --port 는 포트 번호여야 합니다(받은 값: "{value}")',
  errUiNoWebApp:
    'ui: 이 빌드에는 웹 앱이 들어 있지 않습니다.\n' +
    '단독 실행 파일은 네트워크 접근 없이 컴파일되므로 웹 앱을 제공할 수 없습니다.\n' +
    '`npx stegoshard ui` 를 쓰거나, 릴리스 페이지에서 오프라인 웹 번들을 내려받아\n' +
    '그 안의 serve 스크립트를 실행하세요.',
  errNoPassword: '비밀번호가 없습니다(빈 비밀번호는 허용되지 않습니다)',
  errNoDuressPassword: '강요용 비밀번호가 없습니다(빈 비밀번호는 허용되지 않습니다)',
  errPasswordShort:
    '{label}이(가) 너무 짧습니다: {length}자, 최소 {min}자. ' +
    '이 하한은 면제할 수 없습니다. 금고를 손에 넣은 공격자는 오프라인에서 얼마든지 대입해 볼 수 있습니다.',
  errWeakAcknowledge:
    '{warning} 이 위험을 감수하려면 --allow-weak-password 를 붙여 다시 실행하세요.',
  errWeakCancelled: '취소됨: 약한 비밀번호를 확인하지 않았습니다',
  errEntropyFile: '--entropy-file: "{path}" 를 읽을 수 없습니다',
  errEntropyPromptTty:
    '--entropy-prompt 에는 터미널이 필요합니다. --entropy-file 이나 STEGOSHARD_ENTROPY 를 쓰세요',
  errEntropyPromptEmpty: '--entropy-prompt: 아무것도 입력하지 않았습니다',
  errEntropyEmpty: '추가 엔트로피가 비어 있습니다(추가 계층을 원하지 않으면 빼세요)',
  errWrongPassword: '비밀번호가 틀렸습니다',
  errNoGallery:
    '복원할 수 있는 갤러리를 찾지 못했습니다(비밀번호가 틀렸거나 갤러리 사진이 아닙니다)',
  errNeedsKey: '이 이미지 세트에는 별도의 키가 필요합니다(--key <파일|이미지> 를 쓰세요)',
  errDuressTooSimilar:
    '강요용 비밀번호가 진짜 비밀번호와 너무 비슷합니다({reason}). ' +
    '서로 관련 없는 강요용 비밀번호를 고르세요',
  errOverwrite: '기존 파일을 덮어쓰지 않습니다: {path}(덮어쓰려면 --force 를 쓰세요)',
  errStegoNeedsCover: 'stego 모드에는 --cover 이미지가 필요합니다',
  errDuressNeedsPassword: 'save: --mode duress 에는 강요용 비밀번호가 필요합니다',
  errNoInputFiles: 'save: 입력 파일을 찾지 못했습니다',
  errModeNeedsDisguise: 'save: --mode {mode} 는 --binary --disguise 와 함께만 지원됩니다',
  errNoReadableImages: '입력에서 읽을 수 있는 StegoShard 이미지를 찾지 못했습니다',
  errNoCoversFound: 'gallery: 지정한 경로에서 커버 이미지를 찾지 못했습니다',
  errNoGalleryImages: 'gallery: 입력에서 이미지를 찾지 못했습니다',
  warnPasswordFlag:
    '경고: --password 는 셸 기록과 프로세스 목록에 드러납니다. ' +
    'STEGOSHARD_PASSWORD, --password-file, 또는 대화형 입력을 쓰세요.',
  warnEntropyFlag:
    '경고: --entropy 는 셸 기록과 프로세스 목록에 드러납니다. ' +
    'STEGOSHARD_ENTROPY, --entropy-file, 또는 --entropy-prompt 를 쓰세요.',
  warnWeakPassword:
    '경고: {label}이(가) 약합니다(추정 {bits}비트). ' +
    '오프라인 금고는 사용자에게 연락하지 않고도 추측될 수 있습니다.',
  warnPrefix: '경고: {message}',
  labelPassword: '비밀번호',
  promptPassword: '비밀번호: ',
  promptDuressPassword: '강요용 비밀번호: ',
  promptEntropy: '추가 엔트로피(아무렇게나 입력하거나 주사위 눈을 붙여 넣으세요): ',
  promptAllow: '계속하려면 ALLOW 를 입력하세요: ',
  phaseCompress: '압축 중',
  phaseEncrypt: '암호화 중',
  phaseDecrypt: '복호화 중',
  phaseVerify: '검증 중',
  phaseUnlock: '잠금 해제 중',
  phaseRender: '생성 중',
  purposeVault: '금고: 파일을 담고 있습니다',
  purposeArchive: '모든 이미지를 하나의 .zip 에 묶음',
  purposeDocument: '인쇄용 시트',
  purposePhotos: '조각 사진: 세트 전체를 보관하세요',
  purposeKeyfile: '별도의 키: 비밀번호와 함께 필요합니다',
  purposeStegoCover: '숨겨진 키를 담은 사진',
  purposeShare: '복구용 공유본, 보관자 한 명 몫',
  outSaved: '{what} 저장 완료.',
  outSavedBinary: '바이너리 금고({variant}) [{keyMode}]',
  outSavedImages: '이미지 {count}개 [{keyMode}]',
  outFilesCreated: '생성된 파일:',
  outKeepKeyArtifact: '복원하려면 별도의 키 파일과 비밀번호를 모두 보관하세요.',
  outSavedGallery:
    '파일 {files}개에 갤러리를 저장했습니다(데이터 {k} + 패리티 {m} + 미끼 {decoys}) [{keyMode}].',
  outGalleryKeep: '비밀번호를 보관하세요. 조각 사진 중 아무 {k}장이면 복원됩니다.',
  outGalleryKeepKey: '별도의 키 파일도 보관하세요(--key 로 복원합니다).',
  outRestoredOne: '{name} 복원됨 -> {path}',
  outRestoredMany: '파일 {count}개를 복원했습니다:',
  outDecoded: '이미지 {seen}개 중 {decoded}개 해독',
  outScanned: '사진 {seen}장 확인',
  outEstimate: '이미지 {images}개  (k={k} 데이터 + m={m} 패리티)',
  helpTagline:
    'StegoShard: 파일을 복원력 높은 이미지, 내용이 드러나지 않는 바이너리 파일, 또는 위장 데이터베이스로 암호화하고 다시 복원합니다.',
  helpUsageHeading: '사용법:',
  helpUi:
    '브라우저 버전과 같은 앱을 이 컴퓨터에서만 제공합니다. 네트워크 접근 없이 컴파일된 단독 실행 파일에서는 쓸 수 없습니다.',
  helpUiHeading: '로컬 웹 UI:',
  helpSaveHeading: 'save 옵션:',
  helpSaveIntro:
    '여러 입력(또는 디렉터리)은 금고 안에서 하나의 번들로 압축되며, 복원하면 원래 파일로 다시 풀립니다. 입력이 하나면 그대로 저장됩니다.',
  helpRestoreHeading: 'restore 옵션:',
  helpCommonHeading: '공통:',
  helpPasswordHeading: '비밀번호(필요한 모든 명령에서), 우선순위 순:',
  helpEntropyHeading:
    'save / gallery-save 를 위한 추가 엔트로피(선택, 전문가용. 생성에만 영향을 주며 복원 시 다시 입력할 것은 없고, OS 의 CSPRNG 는 언제나 함께 쓰입니다), 우선순위 순:',
  helpEntropyNote:
    '입력한 문자열은 두 번째 원본으로 XOR 되어 섞입니다. 불확실성을 더할 뿐 CSPRNG 를 대체하지 않으므로, 약한 문자열이 금고를 약하게 만들 수는 없습니다.',
  helpGalleryHeading: '갤러리 모드(비밀을 여러 평범한 사진에 조각내어 숨깁니다):',
  helpGalleryNoDuress:
    '(강요 모드는 갤러리에서 쓸 수 없습니다. --binary --disguise --mode duress 를 쓰세요)',
  helpGalleryNote:
    '모든 사진이 수정됩니다. 가장 알맞은 K+M 장이 리드-솔로몬 조각을 담고 나머지는 미끼가 됩니다(사진 최소 5장, 미끼 최소 2장). 복원은 블라인드로 이루어집니다. 인증되는 사진은 모두 쓰이며, 조각 K개면 재구성됩니다.',
  helpExamplesHeading: '예시:',
  helpOut: '출력 디렉터리(기본값: 현재 디렉터리)',
  helpPaper: 'PNG 대신 인쇄용 PDF 생성(높은 ECC)',
  helpZip: 'PNG 세트를 하나의 .zip 으로 묶기(disk 모드)',
  helpBinary: '이미지 대신 내용이 드러나지 않는 파일 하나로 출력(최대 1 GiB)',
  helpDisguise: '--binary 와 함께: SQLite 데이터베이스 헤더 붙이기(.db)',
  helpMode: 'plain | duress | nonpossession   (.db 전용, 기본값: plain)',
  helpModeDuress: 'duress: 두 번째 비밀번호로 열리는 미끼',
  helpModeNonpossession: 'nonpossession: 손댈 수 없는 임계값 공유본으로 금고를 잠금',
  helpDecoy: '--mode duress: 그럴듯한 미끼 파일',
  helpDuressPasswordFile: '--mode duress: 두 번째(강요용) 비밀번호',
  helpThreshold: '--mode nonpossession: 예 2-of-3(공유 파일 n개 생성)',
  helpCodec: 'color | qr   (기본값: color. 이미지 전용, --paper 에는 쓸 수 없음)',
  helpCodecColor: 'color: 8색 그리드, 이미지당 바이트 약 3배',
  helpCodecQr: 'qr: 평범한 QR, 어떤 휴대폰으로도 읽힘',
  helpKeyMode: 'embedded | keyfile | stego   (기본값: embedded)',
  helpCover: '--key-mode stego 용 커버 사진(그 안에 키를 숨깁니다)',
  helpTitle: '사람이 읽을 라벨 / PDF 제목',
  helpDate: '페이지에 표시할 날짜(기본값: 오늘)',
  helpLocale: '안내문 언어, 예: fr, ja, ko, zh_TW',
  helpInstructions: '복원 안내문 포함(paper)',
  helpPasswordHint: '안내문에 인쇄할 비밀번호 힌트',
  helpKeyLocation: '키를 보관한 곳, 안내문에 인쇄됨',
  helpFont: 'CJK 안내문용 .ttf/.otf(paper)',
  helpAllowWeakPassword:
    '새 금고에 약한(그래도 12자 이상) 비밀번호를 쓰겠다고 확인합니다. 12자라는 최소 길이 자체는 이 플래그로도 다른 어떤 플래그로도 면제할 수 없습니다.',
  helpKey: '.key 파일, 스테고 이미지, 또는 바이너리 키 컨테이너',
  helpShare: 'nonpossession 금고용 임계값 공유 파일(여러 번 지정 가능)',
  helpForce: '기존 출력 파일 덮어쓰기(기본값: 덮어쓰지 않음)',
  helpQuiet: 'stderr 의 진행 표시 숨기기',
  helpPasswordFlag: '권장하지 않음: 셸 기록과 프로세스 목록에 드러남',
  helpPasswordFile: '파일에서 비밀번호 읽기(첫 줄)',
  helpPasswordEnv: '환경 변수',
  helpPasswordPrompt: '위의 어느 것도 없으면 (가려진 채로) 물어봄',
  helpEntropyFlag: '권장하지 않음: 셸 기록과 프로세스 목록에 드러남',
  helpEntropyFile: '파일에서 읽기(내용 전체, 예: 주사위 눈)',
  helpEntropyPrompt: '터미널에서 (가려진 채로) 물어보기(TTY 필요)',
  helpEntropyEnv: '환경 변수',
  helpGalleryOut: '수정된 사진을 저장할 출력 디렉터리',
  helpGalleryKeyMode: 'embedded(기본값) | keyfile | stego   (gallery-save)',
  helpGalleryCover: '--key-mode stego 용 커버 사진(gallery-save)',
  helpGalleryKey: 'keyfile/stego 갤러리용 외부 키(gallery-restore)',
  helpGalleryMode: '임계값 공유본으로 갤러리 잠그기(--threshold k-of-n 과 함께)',
  helpGalleryShare: 'gallery-restore 용 임계값 공유 파일(여러 번 지정 가능)',
  helpUiPort: '빈 포트 대신 이 포트에서 제공',
  helpUiOpen: '주소를 출력할 뿐 아니라 브라우저에서 열기',
};
