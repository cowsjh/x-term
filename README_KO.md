<h1 align="center">x-term</h1>

<p align="center">Claude Code 세션 여러 개를 한 창에 나란히 띄워요.<br>pane마다 진짜 셸 + Claude 채팅. 큰 일은 에이전트 여러 개로 쪼개서 각자 git worktree에서 돌려요.</p>

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

<!-- 스크린샷: docs/screenshot.png 넣고 주석 풀기
<p align="center"><img src="docs/screenshot.png" width="900" alt="pane 세 개 열린 x-term"></p>
-->

## 뭐가 좋아요?

- **pane마다 세션 하나** — 셸이랑 Claude Code 세션이 pane마다 따로 있어요. 셸에서 `Ctrl+A` 누르면 그 자리에서 채팅, `Ctrl+C`면 다시 셸.
- **에이전트 병렬 실행** — 큰 작업 시키면 Claude가 "나눠서 할까요?" 하고 물어요. 승인하면 pane이 여러 개 열리고 각자 git worktree에서 작업해요. worktree 합치고 지우는 건 사이드바에서.
- **권한 카드** — 도구 실행 허가를 카드로 보여주고 키보드로 답해요. 안 보고 있는 pane이면 알림 오고, `Alt+P`로 바로 가요.
- **채팅 UI** — 마크다운 스트리밍, 수식, diff 달린 도구 카드, 이미지 붙여넣기, `@파일` 자동완성, 드래그한 텍스트로 스레드, git 변경사항 보기, 옛날 세션 검색·이어하기.
- **진짜 터미널** — xterm.js + pty. `claude`, `codex`, `vim` 다 돼요.
- **로그인 그대로** — `claude -p` 프로세스를 띄우는 거라 API 키도, 추가 요금도 없어요.

## 설치

Linux x86_64 (Ubuntu 22.04+에서 확인). [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)가 `claude`로 깔려 있고 로그인돼 있어야 해요.

**패키지** — [최신 릴리스](https://github.com/cowsjh/x-term/releases/latest)에서 받아서:

```sh
sudo dpkg -i x-term_*_amd64.deb                              # Debian / Ubuntu
sudo rpm -i x-term-*.x86_64.rpm                              # Fedora / RHEL
chmod +x x-term_*_amd64.AppImage && ./x-term_*_amd64.AppImage   # 아무 배포판, 설치 없이
```

**직접 빌드** — Node 20+, Rust stable 필요:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
git clone https://github.com/cowsjh/x-term.git && cd x-term
npm install
npm run tauri build        # -> src-tauri/target/release/x-term, bundle/{deb,rpm,appimage}
```

## 빠른 시작

```sh
x-term                     # 지금 디렉토리에서
x-term ~/some/project      # 이 디렉토리에서
x-term --fresh             # 저장된 레이아웃 무시
```

1. 셸에서 프로젝트로 `cd` 하고 `Ctrl+A` — 거기서 Claude 채팅이 열려요.
2. `Alt+[` / `Alt+]` 로 오른쪽 / 아래 분할 (`Shift` 붙이면 채팅 pane). 새 pane은 셸이 있던 자리에서 시작해요.
3. 채팅에선 `Enter` 전송, `Shift+Enter` 줄바꿈, `/` 명령, `@` 파일, 이미지는 붙여넣기. `Esc` 중단, `Ctrl+C` 세션 끝.
4. 권한 카드 뜨면 `Enter` 허용, `Ctrl+Enter` 항상 허용, `Esc` 거부.
5. "나눠서 할까요?" 카드 뜨면 Allow — 에이전트 pane들이 열리고 끝나면 부모가 합쳐요. `Ctrl+Shift+B` 사이드바에 pane, worktree, 옛날 세션 다 있어요.

단축키 전체는 `F1`. 레이아웃, 세션, 창 크기는 다음에 켤 때 그대로 돌아와요.

## 설정

- 타이틀바 `⌨ keys` — 단축키 바꾸기. 조합 클릭하고 새 키 누르고 저장.
- `⚙ config` — `~/.config/x-term/config.json` 열기. 테마, 모델, effort, 폰트, 알림, 셸, `claude` 추가 플래그. 저장하면 바로 적용돼요.
- `<repo>/.x-term.json` — 프로젝트별 모델 / effort / 권한 모드.

## 어떻게 돌아가요?

Tauri 2 (Rust + WebKitGTK) 위에 React UI (dockview pane + xterm.js). 채팅 pane마다 `claude -p --input-format stream-json --output-format stream-json` 프로세스를 하나씩 띄우고 이벤트를 그려요. 앱 자체가 세션마다 MCP 서버(`x-term --mcp`, unix socket)로 붙어서, 세션이 형제 pane을 열고 기다릴 수 있어요.

## 개발

```sh
npm run tauri dev          # UI는 HMR, Rust는 바뀌면 재빌드
npx tsc && npm test && cargo test --manifest-path src-tauri/Cargo.toml
```

이슈, PR 환영해요.
