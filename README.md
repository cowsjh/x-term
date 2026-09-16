[한국어](README_KO.md)

# x-term

Linux desktop terminal that runs several Claude Code sessions side by side. Every pane holds a real shell (pty) and a Claude chat: `Ctrl+A` in the shell opens the chat in that directory, `Ctrl+C` in an idle chat returns to the shell.

## Summary

- **Parallel sessions**: split the window; each pane is an independent Claude Code session with number, title, directory and state in its header.
- **Orchestration**: ask for something big and Claude proposes splitting it into sibling panes, one git worktree each; merge / remove worktrees from the sidebar.
- **Permission cards**: tool approvals as cards, answerable from the keyboard; desktop notification when the pane is not focused.
- **Chat**: streaming markdown + KaTeX, tool cards with diffs, image paste, `@file` completion, threads from selected text, git changes view, search / resume past sessions.
- **Terminal**: xterm.js + pty; run `claude`, `codex`, anything.
- **Settings**: `⌨ keys` in the title bar edits shortcuts, `⚙ config` opens `~/.config/x-term/config.json`; changes apply on save. `F1` lists every shortcut.

Stack: Tauri 2 (Rust + WebKitGTK), React, dockview, xterm.js. Claude runs as a `claude -p` stream-json process; nothing calls the API directly (your Claude Code login is used as is).

## Install

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

## Usage

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
