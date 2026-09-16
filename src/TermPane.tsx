import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { Menu } from "./Menu";

const APP_KEYS = new Set(["BracketLeft", "BracketRight", "KeyW"]); // Alt+[ Alt+] Alt+W belong to the app, not the shell

/** A real shell in a pty (xterm.js). Run `claude`, `codex`, anything. Ctrl+A / right-click -> agent mode; `onExit` when the shell ends. */
export function TermPane({ id, cwd, onSwitch, onExit, onReady }: { id: string; cwd?: string; onSwitch: () => void; onExit: () => void; onReady?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const cb = useRef({ onSwitch, onExit, onReady });
  cb.current = { onSwitch, onExit, onReady };
  const [search, setSearch] = useState<string | null>(null); // Ctrl+Shift+F scrollback search
  const searchRef = useRef<SearchAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const q = e.currentTarget.value;
    if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? searchRef.current?.findPrevious(q) : searchRef.current?.findNext(q); }
    if (e.key === "Escape") { setSearch(null); searchRef.current?.clearDecorations(); termRef.current?.focus(); }
  };
  useEffect(() => {
    const term = new Terminal({ fontFamily: "ui-monospace, monospace", fontSize: 13, scrollback: 5000, theme: { background: "#1e1e1e" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => { openUrl(uri).catch(() => {}); })); // click URLs -> system browser
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    termRef.current = term;
    term.open(ref.current!);
    fit.fit();
    term.attachCustomKeyEventHandler((e) => {
      if (e.altKey && APP_KEYS.has(e.code)) return false;
      if (e.ctrlKey && !e.shiftKey && e.code === "KeyA") { if (e.type === "keydown") cb.current.onSwitch(); return false; }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyC" && e.type === "keydown") { navigator.clipboard.writeText(term.getSelection()); return false; }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyF") { if (e.type === "keydown") { setSearch((s) => s ?? ""); setTimeout(() => (document.querySelector(`#tsearch-${id}`) as HTMLInputElement)?.select(), 0); } return false; }
      return true;
    });
    const unData = listen<{ id: string; line: string }>("pty-data", ({ payload }) => { if (payload.id === id) term.write(payload.line); });
    const unExit = listen<string>("pty-exit", ({ payload }) => { if (payload === id) cb.current.onExit(); });
    invoke("pty_open", { id, cwd: cwd ?? null, cols: term.cols, rows: term.rows }).then(() => setTimeout(() => cb.current.onReady?.(), 300)).catch((e) => term.write(`\r\n${e}\r\n`));
    term.onData((data) => invoke("pty_write", { id, data }).catch(() => {}));
    term.onResize(({ cols, rows }) => invoke("pty_resize", { id, cols, rows }).catch(() => {}));
    const ro = new ResizeObserver(() => { if (ref.current?.offsetHeight) fit.fit(); }); // also refits when the slot becomes visible again
    ro.observe(ref.current!);
    term.focus();
    return () => { ro.disconnect(); unData.then((f) => f()); unExit.then((f) => f()); term.dispose(); invoke("pty_close", { id }); };
  }, []);
  return (
    <>
      {search !== null && <input id={`tsearch-${id}`} className="findbar" placeholder="search scrollback (Enter next, Shift+Enter prev, Esc)" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={onSearchKey} autoFocus />}
      <div className="term" ref={ref} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }} />
      {menu && <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[{ label: "Agent mode", key: "a", run: onSwitch }]} />}
    </>
  );
}
