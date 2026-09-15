import { useEffect, useRef, useState } from "react";
import { IDockviewPanelProps } from "dockview-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { Menu } from "./Menu";

export type TermParams = { cwd?: string };
const APP_KEYS = new Set(["BracketLeft", "BracketRight", "KeyW"]); // Alt+[ Alt+] Alt+W belong to the app, not the shell

/** A real shell in a pty (xterm.js). Run `claude`, `codex`, anything. Pane closes when the shell exits. */
export function TermPane({ api, containerApi, params }: IDockviewPanelProps<TermParams>) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** Swap this pane for a claude chat in the same spot, starting where the shell currently is. */
  const toAgent = async () => {
    const cwd = (await invoke<string>("pty_cwd", { id: api.id }).catch(() => "")) || params.cwd;
    containerApi.addPanel({ id: crypto.randomUUID(), component: "session", title: "claude", params: { cwd }, position: { referencePanel: api.id, direction: "within" } });
    api.close();
  };
  useEffect(() => {
    const id = api.id;
    const term = new Terminal({ fontFamily: "ui-monospace, monospace", fontSize: 13, scrollback: 5000, theme: { background: "#1e1e1e" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    fit.fit();
    term.attachCustomKeyEventHandler((e) => {
      if (e.altKey && APP_KEYS.has(e.code)) return false;
      if (e.ctrlKey && e.shiftKey && e.code === "KeyC" && e.type === "keydown") { navigator.clipboard.writeText(term.getSelection()); return false; }
      return true;
    });
    const unData = listen<{ id: string; line: string }>("pty-data", ({ payload }) => { if (payload.id === id) term.write(payload.line); });
    const unExit = listen<string>("pty-exit", ({ payload }) => { if (payload === id) api.close(); });
    invoke("pty_open", { id, cwd: params.cwd ?? null, cols: term.cols, rows: term.rows }).catch((e) => term.write(`\r\n${e}\r\n`));
    term.onData((data) => invoke("pty_write", { id, data }).catch(() => {}));
    term.onResize(({ cols, rows }) => invoke("pty_resize", { id, cols, rows }).catch(() => {}));
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(ref.current!);
    const act = api.onDidActiveChange(({ isActive }) => { if (isActive) term.focus(); });
    term.focus();
    return () => { ro.disconnect(); act.dispose(); unData.then((f) => f()); unExit.then((f) => f()); term.dispose(); invoke("pty_close", { id }); };
  }, []);
  return (
    <>
      <div className="term" ref={ref} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }} />
      {menu && <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[{ label: "Agent mode", key: "a", run: toAgent }, { label: "Close", key: "c", run: () => api.close() }]} />}
    </>
  );
}
