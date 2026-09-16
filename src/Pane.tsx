import { useEffect, useRef, useState } from "react";
import { IDockviewPanelProps } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";
import { warn } from "./events";
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
    // every hop into the chat carries the shell's current directory; the chat applies it until its first message
    if (m === "agent" && seen.term) { const d = await invoke<string>("pty_cwd", { id: api.id }).catch(() => ""); if (d) setAgentCwd(d); }
    setSeen((s) => ({ ...s, [m]: true }));
    setMode(m);
    api.updateParameters({ ...params, mode: m });
    localStorage.setItem("x-term.layout", JSON.stringify(containerApi.toJSON()));
  };
  useEffect(() => { const t = setTimeout(() => root.current?.querySelector<HTMLTextAreaElement>(`.slot.${mode} textarea`)?.focus(), 0); return () => clearTimeout(t); }, [mode]);
  // interactive-only slash commands (/plugin, /skills, /status …) are not available in -p mode: run the real CLI in the shell
  const pending = useRef<string | null>(null);
  const flush = () => { if (pending.current) { invoke("pty_write", { id: api.id, data: pending.current + "\n" }).catch(warn); pending.current = null; } };
  const runInTerm = (cmd: string) => { pending.current = cmd; if (seen.term) { switchTo("term"); flush(); } else switchTo("term"); };
  const onExit = () => { if (seen.agent) { setSeen((s) => ({ ...s, term: false })); switchTo("agent"); } else api.close(); };
  return (
    <div className="pane-root" ref={root}>
      {seen.term && <div className={`slot term ${mode === "term" ? "" : "hidden"}`}><TermPane id={api.id} cwd={params.cwd} onSwitch={() => switchTo("agent")} onExit={onExit} onReady={flush} /></div>}
      {seen.agent && <div className={`slot agent ${mode === "agent" ? "" : "hidden"}`}><SessionPane {...props} params={{ ...params, cwd: agentCwd }} onSwitch={() => switchTo("term")} onTerminal={runInTerm} /></div>}
    </div>
  );
}
