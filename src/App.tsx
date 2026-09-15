import { useRef } from "react";
import { DockviewReact, DockviewApi, DockviewReadyEvent, IDockviewPanelProps, IDockviewHeaderActionsProps, themeDark } from "dockview-react";
import { SessionPane, SessionParams } from "./SessionPane";

let counter = 0;

export function openSession(api: DockviewApi, params: SessionParams, referencePanel?: string) {
  const id = crypto.randomUUID();
  api.addPanel<SessionParams>({
    id,
    component: "session",
    title: params.title ?? `claude ${++counter}`,
    params,
    position: referencePanel ? { referencePanel, direction: "right" } : undefined,
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
  return (
    <DockviewReact
      theme={themeDark}
      components={components}
      rightHeaderActionsComponent={HeaderActions}
      onReady={onReady}
    />
  );
}
