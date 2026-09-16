import { useEffect, useRef } from "react";
import { DockviewReact, DockviewApi, DockviewReadyEvent, IDockviewPanelProps, themeDark } from "dockview-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SessionParams } from "./SessionPane";
import { Pane, PaneParams } from "./Pane";

let counter = 0;
const LAYOUT_KEY = "x-term.layout"; // dockview layout incl. per-pane params (cwd, session id, title) -> restored on launch

/** `term` = shell in a pty (default pane), `session` = claude stream-json chat. Alt+[ / Alt+] split into a terminal, Alt+Shift+[ / ] into a chat. */
export function openPane(api: DockviewApi, component: "term" | "session", params: PaneParams, referencePanel?: string, direction: "right" | "below" = "right") {
  api.addPanel({
    id: crypto.randomUUID(),
    component,
    title: (params as SessionParams).title ?? `${component === "term" ? "sh" : "claude"} ${++counter}`,
    params,
    position: referencePanel ? { referencePanel, direction } : undefined,
  });
}

// both component names map to the same two-mode pane; the name only picks the initial mode (kept for saved layouts)
const components = {
  session: (props: IDockviewPanelProps<PaneParams>) => <Pane {...props} initial="agent" />,
  term: (props: IDockviewPanelProps<PaneParams>) => <Pane {...props} initial="term" />,
};

export default function App() {
  const apiRef = useRef<DockviewApi>(null);
  const onReady = (e: DockviewReadyEvent) => {
    apiRef.current = e.api;
    const saved = localStorage.getItem(LAYOUT_KEY);
    try { if (saved) e.api.fromJSON(JSON.parse(saved)); } catch { localStorage.removeItem(LAYOUT_KEY); }
    if (!e.api.panels.length) openPane(e.api, "term", {});
    e.api.onDidLayoutChange(() => localStorage.setItem(LAYOUT_KEY, JSON.stringify(e.api.toJSON())));
  };
  useEffect(() => {
    // Alt+[ right / Alt+] below: new terminal; with Shift: new claude chat; Alt+W: close pane.
    // New panes inherit the active pane's cwd.
    const onKey = (e: KeyboardEvent) => {
      const api = apiRef.current;
      if (!e.altKey || !api) return;
      const active = api.activePanel;
      if (e.code === "BracketLeft" || e.code === "BracketRight") {
        e.preventDefault();
        openPane(api, e.shiftKey ? "session" : "term", { cwd: (active?.params as PaneParams | undefined)?.cwd }, active?.id, e.code === "BracketLeft" ? "right" : "below");
      } else if (e.code === "KeyW") { e.preventDefault(); active?.api.close(); }
    };
    window.addEventListener("keydown", onKey);
    // OS file drop: hand the paths to the pane under the cursor (Chat listens for "x-term-drop")
    const drop = getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type !== "drop") return;
      const { x, y } = ev.payload.position;
      const s = window.devicePixelRatio || 1;
      document.elementFromPoint(x / s, y / s)?.closest(".pane")?.dispatchEvent(new CustomEvent("x-term-drop", { detail: ev.payload.paths }));
    });
    return () => { window.removeEventListener("keydown", onKey); drop.then((f) => f()); };
  }, []);
  const win = getCurrentWindow();
  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <span data-tauri-drag-region>x-term</span>
        <button onClick={() => win.minimize()}>–</button>
        <button onClick={() => win.toggleMaximize()}>▢</button>
        <button onClick={() => win.close()}>×</button>
      </div>
      <div className="dock">
        <DockviewReact theme={themeDark} components={components} onReady={onReady} />
      </div>
    </div>
  );
}
