<h1 align="center">x-term</h1>

<p align="center">Run several Claude Code sessions side by side, in one Linux window.<br>Each pane is a real shell plus a Claude chat; big tasks fan out into parallel agents, one git worktree each.</p>

<p align="center">
  <a href="https://github.com/cowsjh/x-term/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/cowsjh/x-term/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/cowsjh/x-term/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/cowsjh/x-term"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-linux-blue">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="README_KO.md">한국어</a>
</p>

<!-- screenshot: put docs/screenshot.png in the repo and uncomment
<p align="center"><img src="docs/screenshot.png" width="900" alt="x-term with three panes"></p>
-->

## Highlights

- **Split panes, independent sessions** — every pane has its own shell (pty) and its own Claude Code session; `Ctrl+A` in the shell opens the chat there, `Ctrl+C` returns.
- **Parallel agents** — ask for something big and Claude proposes a split; approve once and sibling panes open, each on its own git worktree. Merge or remove worktrees from the sidebar.
- **Permission cards** — tool approvals as cards, answered from the keyboard; desktop notification when the pane is not in front, `Alt+P` jumps to it.
- **Real chat UI** — streaming markdown + KaTeX, tool cards with diffs, image paste, `@file` completion, threads from selected text, git changes view, search and resume past sessions.
- **Real terminal** — xterm.js on a pty; run `claude`, `codex`, `vim`, anything.
- **Uses your login** — Claude runs as a `claude -p` process; no API keys, no extra billing.

## Install

Requires Linux x86_64 (tested on Ubuntu 22.04+) and the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) on PATH as `claude`, logged in.

**Packages** — from the [latest release](https://github.com/cowsjh/x-term/releases/latest):

```sh
sudo dpkg -i x-term_*_amd64.deb                              # Debian / Ubuntu
sudo rpm -i x-term-*.x86_64.rpm                              # Fedora / RHEL
chmod +x x-term_*_amd64.AppImage && ./x-term_*_amd64.AppImage   # any distro, no install
```

**From source** — Node 20+ and Rust stable:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
git clone https://github.com/cowsjh/x-term.git && cd x-term
npm install
npm run tauri build        # -> src-tauri/target/release/x-term and bundle/{deb,rpm,appimage}
```

## Quick start

```sh
x-term                     # open in the current directory
x-term ~/some/project      # open in a directory
x-term --fresh             # ignore the saved layout
```

1. `cd` to a project in the shell and press `Ctrl+A` — a Claude chat opens in that directory.
2. `Alt+[` / `Alt+]` split right / below (add `Shift` for a chat pane). New panes inherit the shell's current directory.
3. In the chat: `Enter` sends, `Shift+Enter` newline, `/` commands, `@` files, paste images. `Esc` interrupts, `Ctrl+C` ends the session.
4. On a permission card: `Enter` allow, `Ctrl+Enter` always allow, `Esc` deny.
5. When Claude proposes a parallel split, Allow — agent panes open and the parent integrates their results. `Ctrl+Shift+B` opens the sidebar with panes, worktrees and past sessions.

`F1` lists every shortcut. Layout, sessions and window geometry come back on the next start.

## Configuration

- `⌨ keys` in the title bar — edit shortcuts (click a combo, press new keys, save).
- `⚙ config` — opens `~/.config/x-term/config.json`: theme, model, effort, fonts, notifications, shell, extra `claude` flags. Changes apply on save.
- `<repo>/.x-term.json` — per-project model / effort / permission mode.

## How it works

Tauri 2 (Rust + WebKitGTK) hosts a React UI with dockview panes and xterm.js terminals. Each chat pane spawns `claude -p --input-format stream-json --output-format stream-json` and renders the event stream. The app also exposes itself to every session as an MCP server (`x-term --mcp`, unix socket), which is how a session opens and waits for sibling agent panes.

## Development

```sh
npm run tauri dev          # HMR for the UI, Rust rebuilds on change
npx tsc && npm test && cargo test --manifest-path src-tauri/Cargo.toml
```

Issues and pull requests welcome.
