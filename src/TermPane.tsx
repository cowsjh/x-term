import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { Menu } from "./Menu";

const APP_KEYS = new Set(["BracketLeft", "BracketRight", "KeyW"]); // Alt+[ Alt+] Alt+W belong to the app, not the shell

/** A real shell in a pty (xterm.js). Run `claude`, `codex`, anything. Ctrl+A / right-click -> agent mode; `onExit` when the shell ends. */
export function TermPane({ id, cwd, onSwitch, onExit }: { id: string; cwd?: string; onSwitch: () => void; onExit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const cb = useRef({ onSwitch, onExit });
  cb.current = { onSwitch, onExit };
  useEffect(() => {
    const term = new Terminal({ fontFamily: "ui-monospace, monospace", fontSize: 13, scrollback: 5000, theme: { background: "#1e1e1e" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    fit.fit();
    term.attachCustomKeyEventHandler((e) => {
      if (e.altKey && APP_KEYS.has(e.code)) return false;
      if (e.ctrlKey && !e.shiftKey && e.code === "KeyA") { if (e.type === "keydown") cb.current.onSwitch(); return false; }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyC" && e.type === "keydown") { navigator.clipboard.writeText(term.getSelection()); return false; }
      return true;
    });
    const unData = listen<{ id: string; line: string }>("pty-data", ({ payload }) => { if (payload.id === id) term.write(payload.line); });
    const unExit = listen<string>("pty-exit", ({ payload }) => { if (payload === id) cb.current.onExit(); });
    invoke("pty_open", { id, cwd: cwd ?? null, cols: term.cols, rows: term.rows }).catch((e) => term.write(`\r\n${e}\r\n`));
    term.onData((data) => invoke("pty_write", { id, data }).catch(() => {}));
    term.onResize(({ cols, rows }) => invoke("pty_resize", { id, cols, rows }).catch(() => {}));
    const ro = new ResizeObserver(() => { if (ref.current?.offsetHeight) fit.fit(); }); // also refits when the slot becomes visible again
    ro.observe(ref.current!);
    term.focus();
    return () => { ro.disconnect(); unData.then((f) => f()); unExit.then((f) => f()); term.dispose(); invoke("pty_close", { id }); };
  }, []);
  return (
    <>
      <div className="term" ref={ref} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }} />
      {menu && <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[{ label: "Agent mode", key: "a", run: onSwitch }]} />}
    </>
  );
}
