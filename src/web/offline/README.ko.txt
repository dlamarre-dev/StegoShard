StegoShard 오프라인 웹 앱
=========================

English: README.txt | Français: README.fr.txt | Deutsch: README.de.txt
Español: README.es.txt | Italiano: README.it.txt | Português: README.pt.txt
日本語: README.ja.txt | 繁體中文: README.zh_TW.txt

index.html 을 그냥 열 수 없는 이유
----------------------------------

index.html 을 더블클릭해도 어떤 브라우저에서도 동작하지 않습니다. 이 앱은 ES
모듈로 만들어졌고 암호 연산을 모듈 워커에서 실행하는데, 브라우저는 보안상의
이유로 둘 다 file:// 로 불러오기를 거부합니다. StegoShard 의 한계가 아니며,
설정으로 바꿀 수 있는 것도 아닙니다.

그래서 파일을 HTTP 로 제공해야 합니다. 그렇다고 인터넷에 올린다는 뜻은
아닙니다. 아래의 서버는 이 컴퓨터에서만 대기하며, 앱 자체도
Content-Security-Policy 에 의해 모든 네트워크 요청이 금지되어 있습니다.
저장하거나 복원하는 내용은 이 컴퓨터를 벗어나지 않습니다.

실행 방법
---------

Node.js(버전 20 이상)가 설치되어 있다면:

    Windows    serve.cmd 더블클릭
    macOS      ./serve.sh          (또는: node serve.mjs --open)
    Linux      ./serve.sh          (또는: node serve.mjs --open)

http://127.0.0.1:… 형태의 주소가 표시됩니다. 그 주소를 여세요. 탭이 열려 있는
동안에는 창을 그대로 두고, 끝나면 Ctrl+C 로 멈추세요.

    node serve.mjs --port 8137     빈 포트 대신 지정한 포트 사용
    node serve.mjs                 브라우저를 열지 않고 주소만 표시

Node.js 가 없다면, 이 폴더의 정적 파일을 제공할 수 있는 것이면 무엇이든
괜찮습니다:

    python3 -m http.server 8137
    그런 다음 http://127.0.0.1:8137/ 를 여세요

공유 네트워크에서 제공하지 마세요. 표시되는 주소는 의도적으로 루프백 전용이며,
경로에는 임의의 토큰이 들어 있어 이 컴퓨터의 다른 프로그램이 추측할 수 없습니다.

유념할 점
---------

브라우저에서 앱을 쓰면 명령줄 버전에서는 남지 않는 흔적이 남습니다. 브라우저의
캐시와 기록, 다운로드 폴더, 그리고 선택한 언어와 이미지 형식에 대한 작은 설정
입니다. 저장하려는 내용에 그것이 문제가 된다면 명령줄 버전을 쓰고, 소스
저장소의 docs/THREAT-MODEL.md 를 읽어 보세요.

비밀번호는 복구할 수 없습니다. 잃어버리면 금고도 잃게 됩니다.

StegoShard 는 MIT 라이선스입니다. 이 파일과 같은 위치에 있는 LICENSE 와
THIRD_PARTY_NOTICES.txt 를 참고하세요. 소스:
https://github.com/dlamarre-dev/StegoShard
