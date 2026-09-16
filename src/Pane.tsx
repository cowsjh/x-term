import { useEffect, useRef, useState } from "react";
import { IDockviewPanelProps } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";
import { SessionPane, SessionParams } from "./SessionPane";
import { TermPane } from "./TermPane";

export type Mode = "term" | "agent";
export type PaneParams = SessionParams & { mode?: Mode };

/** One slot in the layout holding a shell and a claude chat; both stay alive, one is shown.
 *  Switch: Ctrl+A in the shell, Ctrl+C in the chat (nothing selected), or right-click. Mode is saved in the layout. */
export function Pane(props: IDockviewPanelProps<PaneParams> & { initial: Mode }) {
  const { api, containerApi, params, initial } = props;
  const [mode, setMode] = useState<Mode>(params.mode ?? initial);
  const [seen, setSeen] = useState({ term: mode === "term", agent: mode === "agent" }); // mount lazily, keep mounted
  const [agentCwd, setAgentCwd] = useState(params.cwd);
  const root = useRef<HTMLDivElement>(null);
  const switchTo = async (m: Mode) => {
    // first hop into the chat starts it where the shell currently is (tracks `cd`)
    if (m === "agent" && !seen.agent) setAgentCwd((await invoke<string>("pty_cwd", { id: api.id }).catch(() => "")) || params.cwd);
    setSeen((s) => ({ ...s, [m]: true }));
    setMode(m);
    api.updateParameters({ ...params, mode: m });
    localStorage.setItem("x-term.layout", JSON.stringify(containerApi.toJSON()));
  };
  useEffect(() => { const t = setTimeout(() => root.current?.querySelector<HTMLTextAreaElement>(`.slot.${mode} textarea`)?.focus(), 0); return () => clearTimeout(t); }, [mode]);
  const onExit = () => { if (seen.agent) { setSeen((s) => ({ ...s, term: false })); switchTo("agent"); } else api.close(); };
  return (
    <div className="pane-root" ref={root}>
      {seen.term && <div className={`slot term ${mode === "term" ? "" : "hidden"}`}><TermPane id={api.id} cwd={params.cwd} onSwitch={() => switchTo("agent")} onExit={onExit} /></div>}
      {seen.agent && <div className={`slot agent ${mode === "agent" ? "" : "hidden"}`}><SessionPane {...props} params={{ ...params, cwd: agentCwd }} onSwitch={() => switchTo("term")} /></div>}
    </div>
  );
}
