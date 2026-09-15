import { useEffect, useRef } from "react";
import { DockviewReact, DockviewApi, DockviewReadyEvent, IDockviewPanelProps, IDockviewHeaderActionsProps, themeDark } from "dockview-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { SessionPane, SessionParams } from "./SessionPane";

let counter = 0;
const LAYOUT_KEY = "x-term.layout"; // dockview layout incl. per-pane params (cwd, session id, title) -> restored on launch

export function openSession(api: DockviewApi, params: SessionParams, referencePanel?: string, direction: "right" | "below" = "right") {
  const id = crypto.randomUUID();
  api.addPanel<SessionParams>({
    id,
    component: "session",
    title: params.title ?? `claude ${++counter}`,
    params,
    position: referencePanel ? { referencePanel, direction } : undefined,
  });
}

const components = {
  session: (props: IDockviewPanelProps<SessionParams>) => <SessionPane {...props} />,
};

function HeaderActions({ containerApi, activePanel }: IDockviewHeaderActionsProps) {
  return (
    <button className="hdr-btn" title="New session" onClick={() => openSession(containerApi, {}, activePanel?.id)}>
      +
    </button>
  );
}

export default function App() {
  const apiRef = useRef<DockviewApi>(null);
  const onReady = (e: DockviewReadyEvent) => {
    apiRef.current = e.api;
    const saved = localStorage.getItem(LAYOUT_KEY);
    try { if (saved) e.api.fromJSON(JSON.parse(saved)); } catch { localStorage.removeItem(LAYOUT_KEY); }
    if (!e.api.panels.length) openSession(e.api, {});
    e.api.onDidLayoutChange(() => localStorage.setItem(LAYOUT_KEY, JSON.stringify(e.api.toJSON())));
  };
  useEffect(() => {
    // Alt+[ : split vertically (new pane to the right), Alt+] : split horizontally (new pane below), Alt+W : close pane
    const onKey = (e: KeyboardEvent) => {
      const api = apiRef.current;
      if (!e.altKey || !api) return;
      if (e.key === "[" || e.key === "]") { e.preventDefault(); openSession(api, {}, api.activePanel?.id, e.key === "[" ? "right" : "below"); }
      else if (e.key === "w") { e.preventDefault(); api.activePanel?.api.close(); }
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
  return (
    <DockviewReact
      theme={themeDark}
      components={components}
      rightHeaderActionsComponent={HeaderActions}
      onReady={onReady}
    />
  );
}
