# x-term

[한국어](#한국어) · [English](#english)

---

## 한국어

여러 개의 Claude Code 세션을 한 창에서 나란히 돌리는 Linux 데스크톱 터미널. 각 pane은 진짜 셸(pty)과 Claude 채팅을 함께 가진다. 셸에서 `Ctrl+A`면 그 디렉토리에서 채팅, 채팅에서 `Ctrl+C`면 다시 셸.

### 요약

- **병렬 세션**: 화면을 나눠 pane마다 독립된 Claude Code 세션. 헤더에 번호·제목·디렉토리·상태.
- **오케스트레이션**: 큰 작업을 요청하면 Claude가 하위 작업별로 새 pane을 열어 병렬로 진행(각자 git worktree). 사이드바에서 worktree merge / remove.
- **권한 카드**: 도구 실행 허가를 카드로 표시, 키보드로 응답. 포커스 없는 pane은 데스크톱 알림.
- **채팅**: 스트리밍 마크다운 + KaTeX, 도구 카드(diff), 이미지 붙여넣기, `@파일` 자동완성, 선택 텍스트로 스레드, git 변경사항 뷰, 과거 세션 검색/재개.
- **터미널**: xterm.js + pty. `claude`, `codex` 등 그대로 실행.
- **설정**: 타이틀바 `⌨ keys`로 단축키 편집, `⚙ config`로 설정 파일(`~/.config/x-term/config.json`) 편집. 저장 즉시 반영. `F1`에 전체 단축키.

스택: Tauri 2 (Rust + WebKitGTK), React, dockview, xterm.js. Claude는 `claude -p` stream-json 프로세스로 실행. API 직접 호출 없음(Claude Code 로그인 그대로 사용).

### 설치

요구사항: Linux x86_64 (Ubuntu 22.04+ 확인), [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)가 `claude`로 PATH에 있고 로그인된 상태.

[Releases](https://github.com/cowsjh/x-term/releases)에서 받기:

```sh
sudo dpkg -i x-term_0.1.0_amd64.deb                                     # Debian / Ubuntu
chmod +x x-term_0.1.0_amd64.AppImage && ./x-term_0.1.0_amd64.AppImage   # 어느 배포판이든
```

소스 빌드 (Node 20+, Rust stable):

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
git clone git@github.com:cowsjh/x-term.git && cd x-term
npm install
npm run tauri build      # -> src-tauri/target/release/x-term, bundle/{deb,rpm,appimage}
npm run tauri dev        # 개발 모드
```

### 사용법

```sh
x-term                    # 현재 디렉토리
x-term ~/some/project     # 시작 디렉토리 지정
x-term --fresh            # 저장된 레이아웃 무시
```

1. 셸에서 프로젝트로 `cd` 후 `Ctrl+A` → 그 자리에서 Claude 채팅.
2. `Alt+[` / `Alt+]` 로 분할 (`Shift` 추가 = 채팅 pane). 새 pane은 셸 현재 위치를 물려받음.
3. 채팅: `Enter` 전송, `Shift+Enter` 줄바꿈, `/` 명령, `@` 파일, 이미지 붙여넣기. `Esc` 중단, `Ctrl+C` 세션 종료.
4. 권한 카드: `Enter` 허용 / `Ctrl+Enter` 항상 허용 / `Esc` 거부. `Alt+P` 로 대기 중인 pane 이동.
5. 병렬 분할 제안이 오면 Allow → 에이전트 pane들이 열리고 끝나면 부모가 합침. `Ctrl+Shift+B` 사이드바에서 worktree 정리.
6. 나머지 단축키는 `F1`, 변경은 `⌨ keys`, 설정은 `⚙ config`. 저장소별 설정은 `<repo>/.x-term.json`.

레이아웃·세션·창 크기는 다음 실행 때 복원.

---

## English

Linux desktop terminal that runs several Claude Code sessions side by side. Every pane holds a real shell (pty) and a Claude chat: `Ctrl+A` in the shell opens the chat in that directory, `Ctrl+C` in an idle chat returns to the shell.

### Summary

- **Parallel sessions**: split the window; each pane is an independent Claude Code session with number, title, directory and state in its header.
- **Orchestration**: ask for something big and Claude proposes splitting it into sibling panes, one git worktree each; merge / remove worktrees from the sidebar.
- **Permission cards**: tool approvals as cards, answerable from the keyboard; desktop notification when the pane is not focused.
- **Chat**: streaming markdown + KaTeX, tool cards with diffs, image paste, `@file` completion, threads from selected text, git changes view, search / resume past sessions.
- **Terminal**: xterm.js + pty; run `claude`, `codex`, anything.
- **Settings**: `⌨ keys` in the title bar edits shortcuts, `⚙ config` opens `~/.config/x-term/config.json`; changes apply on save. `F1` lists every shortcut.

Stack: Tauri 2 (Rust + WebKitGTK), React, dockview, xterm.js. Claude runs as a `claude -p` stream-json process; nothing calls the API directly (your Claude Code login is used as is).

### Install

Requirements: Linux x86_64 (tested on Ubuntu 22.04+), the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) on PATH as `claude` and logged in.

From [Releases](https://github.com/cowsjh/x-term/releases):

```sh
sudo dpkg -i x-term_0.1.0_amd64.deb                                     # Debian / Ubuntu
chmod +x x-term_0.1.0_amd64.AppImage && ./x-term_0.1.0_amd64.AppImage   # any distro
```

From source (Node 20+, Rust stable):

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
git clone git@github.com:cowsjh/x-term.git && cd x-term
npm install
npm run tauri build      # -> src-tauri/target/release/x-term, bundle/{deb,rpm,appimage}
npm run tauri dev        # development
```

### Usage

```sh
x-term                    # current directory
x-term ~/some/project     # start directory
x-term --fresh            # ignore the saved layout
```

1. `cd` to a project in the shell, press `Ctrl+A`: a Claude chat opens there.
2. `Alt+[` / `Alt+]` split (add `Shift` for a chat pane). New panes inherit the shell's current directory.
3. Chat: `Enter` sends, `Shift+Enter` newline, `/` commands, `@` files, paste images. `Esc` interrupts, `Ctrl+C` ends the session.
4. Permission card: `Enter` allow / `Ctrl+Enter` always allow / `Esc` deny. `Alt+P` jumps to a waiting pane.
5. When a parallel split is proposed, Allow: agent panes open and the parent integrates the results. Tidy worktrees in the `Ctrl+Shift+B` sidebar.
6. Everything else: `F1` for shortcuts, `⌨ keys` to change them, `⚙ config` for settings. Per-repo overrides go in `<repo>/.x-term.json`.

Layout, sessions and window geometry are restored on the next start.

Checks for contributors: `npx tsc`, `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml`.
