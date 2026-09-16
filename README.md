# x-term

여러 개의 Claude Code 세션을 한 창에서 나란히 돌리는 Linux 데스크톱 터미널. 각 pane은 진짜 셸(pty)과 Claude 채팅을 함께 가진다. 셸에서 `Ctrl+A`를 누르면 그 디렉토리에서 채팅이 열리고, 채팅에서 `Ctrl+C`를 누르면 다시 셸로 돌아온다.

## 요약

- **병렬 세션**: 화면을 나눠(`Alt+[` / `Alt+]`) pane마다 독립된 Claude Code 세션. 각 pane 헤더에 번호·제목·디렉토리·상태(`working` / `permission` / `done`).
- **오케스트레이션**: 한 세션이 큰 작업을 여러 하위 작업으로 나눠 새 pane들에 위임(`spawn_agents` MCP 도구). 각 에이전트는 자기 git worktree에서 일하고, 부모가 결과를 기다려 합친다. 사이드바에서 worktree를 열고 merge하고 지운다.
- **권한 프롬프트**: 도구 실행 허가를 카드로 표시. 키보드로 응답(`Enter` 허용 / `Ctrl+Enter` 항상 허용 / `Esc` 거부), 포커스 없는 pane은 데스크톱 알림. `Alt+P`로 대기 중인 pane으로 점프.
- **채팅 UI**: 스트리밍 마크다운 + KaTeX, 코드 하이라이트, 도구 카드(diff 포함), 이미지 붙여넣기/드롭, `@파일` 자동완성, 슬래시 명령, 선택한 텍스트로 스레드(`Ctrl+Shift+T`), git 변경사항 뷰(`Ctrl+Shift+D`), 과거 세션 검색/재개.
- **터미널**: xterm.js + pty. `claude`, `codex`, 뭐든 그대로 실행. 스크롤백 검색, URL 클릭.
- **설정**: `~/.config/x-term/config.json` (테마, 모델, 폰트, 단축키, 알림, 셸 …). 저장하면 즉시 반영. 저장소별 `.x-term.json`. 타이틀바 `⌨ keys` 버튼으로 단축키 GUI 편집.

스택: Tauri 2 (Rust + WebKitGTK), React, dockview, xterm.js. Claude는 `claude -p --input-format stream-json --output-format stream-json` 프로세스로 실행되며, API를 직접 호출하지 않는다 (Claude Code 구독/로그인 그대로 사용).

## 설치

요구사항: Linux (Ubuntu 22.04+ 확인), [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) 2.1.27x 이상이 `claude`로 PATH에 있고 로그인된 상태.

**1. 릴리스 패키지 (권장)** — [Releases](https://github.com/cowsjh/x-term/releases)에서 `.deb` 또는 `.AppImage` 다운로드:

```sh
sudo dpkg -i x-term_0.1.0_amd64.deb      # `x-term` 명령 + 앱 메뉴 항목
# 또는
chmod +x x-term_0.1.0_amd64.AppImage && ./x-term_0.1.0_amd64.AppImage
```

**2. 소스 빌드**

```sh
# 빌드 의존성 (Ubuntu/Debian)
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
# Node 20+ 와 Rust stable 필요 (https://rustup.rs)

git clone git@github.com:cowsjh/x-term.git && cd x-term
npm install
npm run tauri build
# -> src-tauri/target/release/x-term (바이너리)
# -> src-tauri/target/release/bundle/{deb,rpm,appimage}/
sudo dpkg -i src-tauri/target/release/bundle/deb/x-term_0.1.0_amd64.deb
```

개발 모드 (HMR, Rust 변경 시 자동 재빌드): `npm run tauri dev`

NVIDIA + Wayland에서 필요한 `WEBKIT_DISABLE_DMABUF_RENDERER=1`은 앱이 스스로 설정한다.

## 사용법

```sh
x-term                    # 현재 디렉토리에서 시작
x-term ~/some/project     # 시작 디렉토리 지정
x-term --fresh            # 저장된 레이아웃 무시하고 빈 터미널 하나로 시작
```

1. 앱을 열면 셸 pane 하나. `cd`로 프로젝트에 가서 `Ctrl+A` → 그 디렉토리에서 Claude 채팅 시작.
2. `Alt+[` (오른쪽) / `Alt+]` (아래)로 터미널 분할, `Shift`를 더하면 채팅 pane. 새 pane은 현재 셸 위치를 물려받는다.
3. 채팅에서 `Enter` 전송, `Shift+Enter` 줄바꿈, `/`로 슬래시 명령, `@`로 파일 자동완성, 이미지는 붙여넣기/드롭. `Esc`로 중단, `Ctrl+C`로 세션 종료 후 셸 복귀.
4. 권한 카드가 뜨면 `Enter` / `Ctrl+Enter` / `Esc`. 다른 pane이 기다리면 헤더가 노랗게 바뀌고 알림이 온다. `Alt+P`로 이동.
5. 큰 작업은 그냥 요청하면 Claude가 병렬 분할을 제안한다. 카드에서 에이전트 목록을 보고 Allow → pane들이 열려 각자 worktree에서 작업, 끝나면 부모가 합친다. `Ctrl+Shift+B` 사이드바에서 worktree merge / remove.
6. `Ctrl+Shift+D` 변경사항(git diff), `Ctrl+F` 대화 검색, `/resume` 과거 세션, `/search 텍스트` 전체 기록 검색, 우클릭 → 마크다운 내보내기.
7. `F1`로 전체 단축키. 타이틀바 `⌨ keys`에서 바꾸고, `⚙ config`에서 설정 파일 편집 (저장하면 바로 반영).

레이아웃, 세션, 창 크기는 다음 실행 때 복원된다. 종료 시 작업 중인 세션이 있으면 한 번 묻는다.

---

# Reference

## Run

```sh
export PATH=$HOME/.local/bin:$HOME/.cargo/bin:$PATH
npm install
npm run tauri dev                    # development: HMR, Rust rebuilds on change
x-term ~/some/project                # optional first arg = start directory
```

Daily use: build once, then run the binary (or install the .deb):

```sh
npm run tauri build                                  # -> src-tauri/target/release/x-term + bundle/{deb,rpm,appimage}
sudo dpkg -i src-tauri/target/release/bundle/deb/x-term_0.1.0_amd64.deb   # optional: `x-term` on PATH + app menu entry
```

`WEBKIT_DISABLE_DMABUF_RENDERER=1` (NVIDIA + Wayland) is set by the app itself.

Checks: `npx tsc`, `npm test` (node --test on `src/util.ts`, `src/keymatch.ts`), `cargo test --manifest-path src-tauri/Cargo.toml`.

`x-term --fresh` ignores the saved layout once. Window size and position are restored on the next start.

## Shortcuts

Press `F1` (or `Ctrl+/`) in the app for the full list. The `⌨ keys` button in the title bar opens an editor: click a combo, press the new keys, Save writes `keys` into the config (action names in `src/keys.ts`; conflicts are shown in red). `⚙ config` opens the file itself. Letters match by physical key, so a Korean layout does not change them. Main ones:

| key | action |
|---|---|
| `Alt+[` / `Alt+]` | split: new terminal right / below (`Shift` = new chat); the new pane starts in the shell's current directory |
| `Alt+W` | close pane |
| `Alt+← ↑ → ↓` | focus pane in that direction (`+Shift` moves the pane there, `Ctrl+Alt+arrow` resizes) |
| `Alt+1` … `Alt+9` | focus pane by its header number (the one shortcut `keys` cannot remap) |
| `Alt+P` / `Alt+U` | next pane waiting for permission / with an unread answer |
| `Alt+Z` | maximize / restore pane |
| `F2` (or double-click the header) | rename pane (in a shell pane F1/F2 go to the program running there; use `Ctrl+/` for help) |
| `Ctrl+Shift+B` | sidebar: open panes, worktrees of the active repo (open / merge / remove), every project's sessions |
| `Ctrl+Shift+D` (chat) | changes view: `git status` + diff of the pane's repo, files this session edited first, `↗` opens in editor |
| `/worktree name` | `git worktree add` at `<repo>-wt/name` (branch `name`) and a new chat pane there |
| `Ctrl+A` (shell) | agent mode in the shell's cwd |
| `Ctrl+C` (chat) | interrupt turn / end session |
| `Enter` / `Ctrl+Enter` / `Esc` (permission card, empty composer) | allow / always allow / deny; plan card: accept / accept + auto-edit / keep planning; question card: `1`-`9` pick, `Enter` submit. With `sendKey: ctrl+enter` the chords are `Ctrl+Enter` / `Ctrl+Shift+Enter` |
| `Shift+Tab` | cycle permission mode |
| `Ctrl+F`, `Ctrl+Shift+F` (shell) | find in chat / search scrollback |
| `Ctrl+Shift+T` | thread from selected text |
| `Ctrl+Shift+K` / `Ctrl+Shift+R` | `/clear` / run `runCommand` in the pane's shell |
| `Shift+PgUp` / `Shift+PgDn`, `Alt+PgUp` / `Alt+PgDn` | scroll conversation / previous / next user message |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | zoom |
| `Ctrl+Shift+L` | toggle dark / light |
| `Ctrl+,` or `/config` | open `config.json` in the editor (the app reloads it on save) |
| `! cmd` | run in the pane's shell |
| `/resume`, `/search text`, `/title name` | pick a session, search all transcripts, rename the pane |

Drop files onto a chat to reference them (`@path`); image files and pasted images are attached as images. Korean/Japanese IME: Enter while composing never sends.

## Orchestration

Every session sees x-term itself as an MCP server (`x-term --mcp`, the same binary, over a unix socket at `$XDG_RUNTIME_DIR/x-term.sock`, or `x-term-<pid>.sock` when another instance already owns it). Its tools: `spawn_agents`, `wait_agents`, `agent_status`, `send_to_agent`, `close_agent`. The appended system prompt tells Claude to propose a split when a request has two or more independent multi-file subtasks. The proposal arrives as a permission card listing every agent (title, worktree, prompt); Allow opens the panes (one git worktree each by default), starts them, and the parent waits with `wait_agents` and integrates the results. Spawned panes are ordinary panes (`↑` in the header): you can watch, type into, or close them.

## Config

`~/.config/x-term/config.json` (all keys optional):

```json
{
  "theme": "dark",
  "model": "claude-opus-5[1m]",
  "effort": "high",
  "permissionMode": "acceptEdits",
  "scrollback": 5000,
  "fontFamily": "ui-monospace, monospace",
  "fontSize": 13,
  "sendKey": "enter",
  "notify": "all",
  "confirmQuit": true,
  "restoreLayout": true,
  "runCommand": "npm test",
  "shell": "/usr/bin/fish",
  "exportDir": "~/Downloads",
  "worktreeDir": "{repo}-wt/{name}",
  "autocompact": "auto",
  "editor": "code -g {path}:{line}",
  "keys": { "sidebar": "ctrl+b", "splitRight": "ctrl+shift+e" },
  "agentModels": {
    "light": { "model": "claude-haiku-4-5", "effort": "low" },
    "standard": { "model": "claude-sonnet-5", "effort": "medium" },
    "heavy": { "model": "claude-opus-5[1m]", "effort": "high" }
  },
  "claudeArgs": ["--max-budget-usd", "5", "--fallback-model", "claude-sonnet-5", "--add-dir", "/srv/shared"]
}
```

The file is re-read whenever it changes (theme, fonts and shortcuts apply live; model / effort / permissionMode apply to new sessions). `Ctrl+Shift+L` toggles the theme for this machine until you delete the `x-term.theme` entry in the app's localStorage or set `theme` again.

- `fontFamily` / `fontSize`: terminal, code blocks and tool cards. `sendKey`: `"enter"` (Shift+Enter = newline) or `"ctrl+enter"` (Enter = newline).
- `notify`: `"all"` (turn finished + permission prompt), `"permission"`, `"none"`. `confirmQuit`: ask before quitting while a session is working. `restoreLayout`: `false` starts with one empty terminal.
- `runCommand`: `Ctrl+Shift+R` in a chat runs it in the pane's shell. `shell`: overrides `$SHELL`. `exportDir`: where the right-click "Export markdown" writes. `worktreeDir`: template for `/worktree` and spawned agents (`{repo}` = repository root, `{name}` = branch). `autocompact`: passed to `claude --autocompact` (`auto` or a token count).
- `keys`: shortcut overrides, `action: "mod+key"` (`ctrl`, `alt`, `shift`; keys like `b`, `[`, `arrowleft`, `pageup`, `f2`). Action names are in `src/keys.ts`.

A `.x-term.json` in a repository (any directory under it) overrides `model`, `effort`, `permissionMode`, `autocompact`, `agentModels` and `runCommand` per project when a chat starts there. Keys that run programs (`shell`, `claudeArgs`, `editor`, `worktreeDir`, `exportDir`) are read from the global file only, since a cloned repo is untrusted. `runCommand` only runs when you press `Ctrl+Shift+R`.

`agentModels` maps a spawned agent's `weight` to its model and effort. The spawning session sets `weight` per agent (`light` for a lookup or mechanical edit, `standard` for normal work, `heavy` for architecture or long multi-file work); when it omits `weight`, x-term infers one from the task (its own worktree or a long brief means `heavy`, a short prompt means `light`). An agent can also pass `model` / `effort` directly, which wins over `weight`. One call opens at most 8 panes.

`claudeArgs` is appended verbatim to every `claude` spawn: `--mcp-config`, `--allowedTools`, `--disallowedTools`, `--add-dir`, `--max-budget-usd`, `--fallback-model`, anything from `claude --help`.

Every pane has a one-line header: number (for `Alt+N`), title, directory, and state (`working`, `permission`, `done`); a pane that spawned agents also shows their states (`↓ 1 ⚠ · 2 working`). A pane waiting on a permission prompt also sends a desktop notification when it is not focused. Quitting with sessions still working asks first. Errors that end a turn (budget, rate limit, API) show as a red row; `/compact` and auto-compaction leave a grey divider.

`editor` opens file paths from tool cards and the changes view; `{path}` and `{line}` are substituted.

The status bar runs your Claude Code `statusLine` command from `~/.claude/settings.json` when one is set; otherwise it shows model · effort · context % · cost.
