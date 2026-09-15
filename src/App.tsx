import { useEffect, useRef } from "react";
import { DockviewReact, DockviewApi, DockviewReadyEvent, IDockviewPanelProps, IDockviewHeaderActionsProps, themeDark } from "dockview-react";
import { SessionPane, SessionParams } from "./SessionPane";

let counter = 0;

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
    openSession(e.api, {});
  };
  useEffect(() => {
    // Alt+[ : split vertically (new pane to the right), Alt+] : split horizontally (new pane below)
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== "[" && e.key !== "]")) return;
      const api = apiRef.current;
      if (!api) return;
      e.preventDefault();
      openSession(api, {}, api.activePanel?.id, e.key === "[" ? "right" : "below");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
