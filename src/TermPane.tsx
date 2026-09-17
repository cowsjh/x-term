import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { onEvent, warn } from "./events";
import { pushContext } from "./util";
import "@xterm/xterm/css/xterm.css";
import { Menu } from "./Menu";
import { cfg, cssVar, themeBase } from "./config";
import { is, isAppKey } from "./keys";

const termTheme = () => ({ background: cssVar("--bg"), foreground: cssVar("--fg"), cursor: cssVar("--fg"), selectionBackground: cssVar(themeBase(cfg.theme) === "light" ? "--user-border" : "--accent") });

/** A real shell in a pty (xterm.js). Run `claude`, `codex`, anything. Ctrl+A / right-click -> agent mode; `onExit` when the shell ends. */
const OUTPUT_LINES = 50; // ponytail: "last output" = the last 50 non-empty scrollback lines; shell integration (OSC 133) would give the exact last command
export function TermPane({ id, cwd, onSwitch, onExit, onReady, onTitle, onClose }: { id: string; cwd?: string; onSwitch: () => void; onExit: () => void; onReady?: () => void; onTitle?: (t: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const cb = useRef({ onSwitch, onExit, onReady, onTitle });
  cb.current = { onSwitch, onExit, onReady, onTitle };
  const [search, setSearch] = useState<string | null>(null); // Ctrl+Shift+F scrollback search
  const searchRef = useRef<SearchAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const q = e.currentTarget.value;
    if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? searchRef.current?.findPrevious(q) : searchRef.current?.findNext(q); }
    if (e.key === "Escape") { setSearch(null); searchRef.current?.clearDecorations(); termRef.current?.focus(); }
  };
  /** Selected text, else the tail of the scrollback: what the shell context menu hands to the chat. */
  const grab = () => {
    const term = termRef.current; if (!term) return null;
    const sel = term.getSelection().trim();
    if (sel) return { text: sel, label: "shell selection" };
    const b = term.buffer.active, lines: string[] = [];
    for (let i = b.length - 1; i >= 0 && lines.length < OUTPUT_LINES; i--) { const l = b.getLine(i)?.translateToString(true) ?? ""; if (l || lines.length) lines.unshift(l); }
    return lines.length ? { text: lines.join("\n"), label: "shell output" } : null;
  };
  /** The shell stays a shell: the question goes to an open agent pane (first in layout order), or a new chat pane opens next to this one. */
  const askAI = async () => {
    const g = grab(); if (!g) return;
    const target = document.querySelector<HTMLElement>(`.pane-root[data-mode="agent"]`)?.dataset.id;
    if (target) pushContext(target, { ...g, ask: true });
    else window.dispatchEvent(new CustomEvent("x-term-open", { detail: { quote: g.text, cwd: (await invoke<string>("pty_cwd", { id }).catch(() => "")) || cwd } }));
  };
  useEffect(() => {
    const term = new Terminal({ fontFamily: cfg.fontFamily, fontSize: cfg.fontSize, scrollback: cfg.scrollback, theme: termTheme() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => { openUrl(uri).catch(warn); })); // click URLs -> system browser
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    termRef.current = term;
    term.open(ref.current!);
    fit.fit();
    term.attachCustomKeyEventHandler((e) => {
      if (isAppKey(e)) return false; // window-level shortcuts (split, focus, sidebar …) never reach the shell
      if (is(e, "agentMode")) { if (e.type === "keydown") cb.current.onSwitch(); return false; }
      if (is(e, "termCopy")) { if (e.type === "keydown") navigator.clipboard.writeText(term.getSelection()); return false; }
      if (is(e, "termPaste")) { if (e.type === "keydown") navigator.clipboard.readText().then((t) => term.paste(t)).catch(warn); return false; }
      if (is(e, "termSearch")) { if (e.type === "keydown") { setSearch((s) => s ?? ""); setTimeout(() => (document.querySelector(`#tsearch-${id}`) as HTMLInputElement)?.select(), 0); } return false; }
      return true;
    });
    const offData = onEvent<{ id: string; line: string }>("pty-data", id, (p) => term.write(p.line));
    const offExit = onEvent<{ id: string }>("pty-exit", id, () => cb.current.onExit());
    invoke("pty_open", { id, cwd: cwd ?? null, cols: term.cols, rows: term.rows }).then(() => setTimeout(() => cb.current.onReady?.(), 300)).catch((e) => term.write(`\r\n${e}\r\n`));
    term.onData((data) => invoke("pty_write", { id, data }).catch(warn));
    term.onResize(({ cols, rows }) => invoke("pty_resize", { id, cols, rows }).catch(warn));
    term.onTitleChange((t) => cb.current.onTitle?.(t)); // shell OSC title (e.g. `user@host: ~/dir`)
    let fitRaf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(() => { if (ref.current?.offsetHeight) fit.fit(); }); }); // one fit per frame; also refits when the slot becomes visible again
    ro.observe(ref.current!);
    // theme toggle / config reload: restyle the live terminal
    const onCfg = () => { term.options.theme = termTheme(); term.options.fontFamily = cfg.fontFamily; term.options.fontSize = cfg.fontSize; term.options.scrollback = cfg.scrollback; fit.fit(); };
    window.addEventListener("x-term-config", onCfg);
    term.focus();
    return () => { window.removeEventListener("x-term-config", onCfg); ro.disconnect(); cancelAnimationFrame(fitRaf); offData(); offExit(); term.dispose(); invoke("pty_close", { id }); };
  }, []);
  return (
    <>
      {search !== null && <input id={`tsearch-${id}`} className="findbar" placeholder="search scrollback (Enter next, Shift+Enter prev, Esc)" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={onSearchKey} autoFocus />}
      <div className="term" ref={ref} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }} />
      {menu && <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
        { label: `Ask AI about ${termRef.current?.getSelection().trim() ? "selection" : "last output"}`, key: "s", run: askAI },
        { label: "Agent mode", key: "a", run: onSwitch }, { label: "Close", key: "c", run: onClose },
      ]} />}
    </>
  );
}
