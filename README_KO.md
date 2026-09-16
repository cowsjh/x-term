<h1 align="center">x-term</h1>

<p align="center">Claude Code 세션 여러 개를 Linux 창 하나에 나란히 띄운다.<br>pane마다 실제 셸과 Claude 채팅이 있고, 큰 작업은 에이전트 여러 개로 나뉘어 각자 git worktree에서 진행된다.</p>

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

- **pane마다 독립 세션** — 셸(pty)과 Claude Code 세션이 pane 단위로 분리된다. 셸에서 `Ctrl+A`를 누르면 그 디렉토리에서 채팅이 열리고, `Ctrl+C`로 돌아온다.
- **에이전트 병렬 실행** — 큰 작업을 요청하면 Claude가 분할을 제안한다. 승인하면 pane이 여러 개 열리고 각자 git worktree에서 작업한다. worktree 병합과 삭제는 사이드바에서 한다.
- **권한 카드** — 도구 실행 허가를 카드로 표시하고 키보드로 응답한다. 보고 있지 않은 pane이면 데스크톱 알림이 오고 `Alt+P`로 이동한다.
- **채팅 UI** — 마크다운 스트리밍, 수식, diff가 달린 도구 카드, 이미지 붙여넣기, `@파일` 자동완성, 선택한 텍스트로 스레드, git 변경사항 보기, 이전 세션 검색과 이어하기.
- **실제 터미널** — xterm.js + pty. `claude`, `codex`, `vim` 모두 그대로 실행된다.
- **기존 로그인 사용** — `claude -p` 프로세스를 실행하므로 API 키와 추가 요금이 없다.

## 설치

Linux x86_64 (Ubuntu 22.04+에서 확인). [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)가 `claude`로 설치되어 있고 로그인된 상태여야 한다.

**패키지** — [최신 릴리스](https://github.com/cowsjh/x-term/releases/latest)에서 내려받는다:

```sh
sudo dpkg -i x-term_*_amd64.deb                              # Debian / Ubuntu
sudo rpm -i x-term-*.x86_64.rpm                              # Fedora / RHEL
chmod +x x-term_*_amd64.AppImage && ./x-term_*_amd64.AppImage   # 배포판 무관, 설치 불필요
```

**소스 빌드** — Node 20+, Rust stable 필요:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
git clone https://github.com/cowsjh/x-term.git && cd x-term
npm install
npm run tauri build        # -> src-tauri/target/release/x-term, bundle/{deb,rpm,appimage}
```

## 빠른 시작

```sh
x-term                     # 현재 디렉토리에서 시작
x-term ~/some/project      # 지정한 디렉토리에서 시작
x-term --fresh             # 저장된 레이아웃 무시
```

1. 셸에서 프로젝트로 `cd`한 뒤 `Ctrl+A` — 그 디렉토리에서 Claude 채팅이 열린다.
2. `Alt+[` / `Alt+]`로 오른쪽 / 아래 분할 (`Shift`를 더하면 채팅 pane). 새 pane은 셸의 현재 위치에서 시작한다.
3. 채팅에서 `Enter` 전송, `Shift+Enter` 줄바꿈, `/` 명령, `@` 파일, 이미지는 붙여넣기. `Esc` 중단, `Ctrl+C` 세션 종료.
4. 권한 카드가 뜨면 `Enter` 허용, `Ctrl+Enter` 항상 허용, `Esc` 거부.
5. 분할 제안 카드에서 Allow — 에이전트 pane들이 열리고 완료되면 부모가 결과를 합친다. `Ctrl+Shift+B` 사이드바에 pane, worktree, 이전 세션이 모여 있다.

전체 단축키는 `F1`. 레이아웃, 세션, 창 크기는 다음 실행 시 복원된다.

## 설정

- 타이틀바 `⌨ keys` — 단축키 편집. 조합을 클릭하고 새 키를 누른 뒤 저장.
- `⚙ config` — `~/.config/x-term/config.json` 열기. 테마, 모델, effort, 폰트, 알림, 셸, `claude` 추가 플래그. 저장 즉시 적용된다.
- `<repo>/.x-term.json` — 프로젝트별 모델 / effort / 권한 모드.

## 동작 방식

Tauri 2 (Rust + WebKitGTK) 위에 React UI (dockview pane + xterm.js)를 띄운다. 채팅 pane마다 `claude -p --input-format stream-json --output-format stream-json` 프로세스를 하나씩 실행하고 이벤트 스트림을 렌더링한다. 앱은 모든 세션에 MCP 서버(`x-term --mcp`, unix socket)로 노출되며, 세션은 이를 통해 형제 pane을 열고 완료를 기다린다.

## 개발

```sh
npm run tauri dev          # UI는 HMR, Rust는 변경 시 재빌드
npx tsc && npm test && cargo test --manifest-path src-tauri/Cargo.toml
```

이슈와 PR을 환영한다.
