<h1 align="center">x-term</h1>

<p align="center">여러 개의 Claude Code 세션을 Linux 창 하나에서 나란히.<br>pane마다 진짜 셸 + Claude 채팅. 큰 작업은 병렬 에이전트로 분할, 각자 git worktree.</p>

<p align="center">
  <a href="https://github.com/cowsjh/x-term/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/cowsjh/x-term/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/cowsjh/x-term/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/cowsjh/x-term"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-linux-blue">
</p>

<p align="center">
  <a href="#설치">설치</a> ·
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="#설정">설정</a> ·
  <a href="README.md">English</a>
</p>

<!-- 스크린샷: docs/screenshot.png 추가 후 주석 해제
<p align="center"><img src="docs/screenshot.png" width="900" alt="pane 세 개가 열린 x-term"></p>
-->

## 특징

- **분할 pane, 독립 세션** — pane마다 자기 셸(pty)과 자기 Claude Code 세션. 셸에서 `Ctrl+A`면 그 자리에서 채팅, `Ctrl+C`면 복귀.
- **병렬 에이전트** — 큰 작업을 요청하면 Claude가 분할을 제안. 한 번 승인하면 형제 pane들이 각자 git worktree에서 진행. 사이드바에서 worktree merge / remove.
- **권한 카드** — 도구 실행 허가를 카드로, 키보드로 응답. 앞에 없는 pane은 데스크톱 알림, `Alt+P`로 이동.
- **제대로 된 채팅 UI** — 스트리밍 마크다운 + KaTeX, diff 있는 도구 카드, 이미지 붙여넣기, `@파일` 자동완성, 선택 텍스트 스레드, git 변경사항 뷰, 과거 세션 검색/재개.
- **진짜 터미널** — pty 위의 xterm.js. `claude`, `codex`, `vim` 뭐든 실행.
- **기존 로그인 사용** — Claude는 `claude -p` 프로세스로 실행. API 키 없음, 추가 과금 없음.

## 설치

Linux x86_64 (Ubuntu 22.04+ 확인), [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)가 `claude`로 PATH에 있고 로그인된 상태 필요.

**패키지** — [최신 릴리스](https://github.com/cowsjh/x-term/releases/latest)에서:

```sh
sudo dpkg -i x-term_*_amd64.deb                              # Debian / Ubuntu
sudo rpm -i x-term-*.x86_64.rpm                              # Fedora / RHEL
chmod +x x-term_*_amd64.AppImage && ./x-term_*_amd64.AppImage   # 어느 배포판이든, 설치 없이
```

**소스 빌드** — Node 20+, Rust stable:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
git clone https://github.com/cowsjh/x-term.git && cd x-term
npm install
npm run tauri build        # -> src-tauri/target/release/x-term, bundle/{deb,rpm,appimage}
```

## 빠른 시작

```sh
x-term                     # 현재 디렉토리
x-term ~/some/project      # 디렉토리 지정
x-term --fresh             # 저장된 레이아웃 무시
```

1. 셸에서 프로젝트로 `cd` 후 `Ctrl+A` — 그 디렉토리에서 Claude 채팅이 열림.
2. `Alt+[` / `Alt+]` 오른쪽 / 아래 분할 (`Shift` 추가 = 채팅 pane). 새 pane은 셸의 현재 위치를 물려받음.
3. 채팅: `Enter` 전송, `Shift+Enter` 줄바꿈, `/` 명령, `@` 파일, 이미지 붙여넣기. `Esc` 중단, `Ctrl+C` 세션 종료.
4. 권한 카드: `Enter` 허용, `Ctrl+Enter` 항상 허용, `Esc` 거부.
5. 병렬 분할 제안이 오면 Allow — 에이전트 pane들이 열리고 부모가 결과를 합침. `Ctrl+Shift+B` 사이드바에 pane, worktree, 과거 세션.

`F1`에 전체 단축키. 레이아웃·세션·창 크기는 다음 실행 때 복원.

## 설정

- 타이틀바 `⌨ keys` — 단축키 편집 (조합 클릭, 새 키 입력, 저장).
- `⚙ config` — `~/.config/x-term/config.json` 열기: 테마, 모델, effort, 폰트, 알림, 셸, 추가 `claude` 플래그. 저장 즉시 반영.
- `<repo>/.x-term.json` — 저장소별 모델 / effort / 권한 모드.

## 동작 방식

Tauri 2 (Rust + WebKitGTK)가 React UI(dockview pane + xterm.js)를 띄운다. 채팅 pane마다 `claude -p --input-format stream-json --output-format stream-json` 프로세스를 띄우고 이벤트 스트림을 렌더링한다. 앱은 모든 세션에 MCP 서버(`x-term --mcp`, unix socket)로 노출되며, 세션이 형제 에이전트 pane을 열고 기다리는 통로가 된다.

## 개발

```sh
npm run tauri dev          # UI HMR, Rust 변경 시 재빌드
npx tsc && npm test && cargo test --manifest-path src-tauri/Cargo.toml
```

이슈와 PR 환영.
