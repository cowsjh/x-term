import { useEffect, useRef, useState } from "react";
import { DockviewApi, IDockviewPanelProps, LocalSelectionTransfer, PanelTransfer } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";
import { warn, agents } from "./events";
import { SessionPane, SessionParams } from "./SessionPane";
import { TermPane } from "./TermPane";

/** Foot of a pane that spawned agents: one row per child with live status colour + activity line. Click focuses its window (brings the floating pane to front); ✕ closes it.
 *  Once the parent's turn ends with every child finished, all child windows close together. */
function AgentBar({ api, parent }: { api: DockviewApi; parent: string }) {
  const [rows, setRows] = useState<{ id: string; title: string; cls: string; log: string }[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set()); // ids whose floating window is revealed
  useEffect(() => {
    const t = setInterval(() => {
      const kids = [...agents.entries()].filter(([, a]) => a.spawnedBy === parent);
      // parent's turn is over and every child has finished: the orchestrator has taken their answers, so tidy all the floating windows at once
      if (kids.length && !agents.get(parent)?.busy && kids.every(([, a]) => !a.busy && !a.perm && (a.turns > 0 || a.err))) { for (const [id] of kids) api.getPanel(id)?.api.close(); return; }
      setRows(kids.map(([id, a]) => ({
      id,
      title: api.getPanel(id)?.title ?? id.slice(0, 6),
      cls: a.err ? "err" : a.perm ? "perm" : a.busy ? "busy" : a.unread ? "unread" : "idle",
      log: a.busy ? a.activity : a.last?.split("\n")[0] ?? "",
    })));
    }, 500);
    return () => clearInterval(t);
  }, [parent]);
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s); const show = !n.has(id); show ? n.add(id) : n.delete(id);
    document.querySelector<HTMLElement>(`.pane-root[data-id="${id}"]`)?.classList.toggle("open", show);
    if (show) api.getPanel(id)?.api.setActive();
    return n;
  });
  if (!rows.length) return null;
  return (
    <div className="agent-bar">
      {rows.map((r) => (
        <div key={r.id} className={`agent-row ${r.cls} ${open.has(r.id) ? "shown" : ""}`} title={open.has(r.id) ? "click to hide window" : "click to open window"} onClick={() => toggle(r.id)}>
          <span className="dot" />
          <span className="t">↑ {r.title}</span>
          <span className="log">{r.log || "idle"}</span>
          <span className="eye">{open.has(r.id) ? "◱" : "▭"}</span>
          <button title="terminate agent" onClick={(e) => { e.stopPropagation(); api.getPanel(r.id)?.api.close(); }}>✕</button>
        </div>
      ))}
    </div>
  );
}

export type Mode = "term" | "agent";
export type PaneStatus = "idle" | "busy" | "perm" | "unread" | "err";
const STATUS_LABEL: Record<PaneStatus, string> = { idle: "claude", busy: "working", perm: "permission", unread: "done", err: "error" };
export type PaneParams = SessionParams & { mode?: Mode };
const LAYOUT_KEY = "x-term.layout";

/** One slot in the layout holding a shell and a claude chat; both stay alive, one is shown.
 *  Switch: Ctrl+A in the shell, Ctrl+C in the chat (nothing selected), or right-click. Mode is saved in the layout. */
export function Pane(props: IDockviewPanelProps<PaneParams> & { initial: Mode }) {
  const { api, containerApi, params, initial } = props;
  const [mode, setMode] = useState<Mode>(params.mode ?? initial);
  const [seen, setSeen] = useState({ term: mode === "term", agent: mode === "agent" }); // mount lazily, keep mounted
  const [agentCwd, setAgentCwd] = useState(params.cwd);
  const root = useRef<HTMLDivElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const [status, setStatus] = useState<PaneStatus>("idle");
  const [title, setTitle] = useState(api.title ?? "");
  const [editing, setEditing] = useState<string | null>(null); // F2: inline title editor
  const [n, setN] = useState(0); // 1-based position in the layout: Alt+N jumps here
  const [kids, setKids] = useState(""); // spawned children summary, e.g. "2 working · 1 done"
  const [termGen, setTermGen] = useState(0); // bump to remount the shell (respawn pty) when the last terminal exits
  const saveLayout = () => localStorage.setItem(LAYOUT_KEY, JSON.stringify(containerApi.toJSON()));
  useEffect(() => {
    const d1 = api.onDidTitleChange(({ title }) => setTitle(title));
    const idx = () => setN(containerApi.panels.findIndex((p) => p.id === api.id) + 1);
    idx();
    const d2 = containerApi.onDidLayoutChange(idx);
    // keyboard navigation lands here: put the caret in the visible slot (chat textarea or xterm's helper textarea)
    const d3 = api.onDidActiveChange(({ isActive }) => { if (isActive) setTimeout(() => root.current?.querySelector<HTMLElement>(`.slot.${modeRef.current} textarea`)?.focus(), 0); });
    const rename = () => setEditing((paramsRef.current.title ?? api.title ?? "").replace(/^● /, ""));
    root.current?.addEventListener("x-term-rename", rename);
    // the shell's live directory (after `cd`) goes into the layout params: splits inherit it and a restart reopens the shell there
    const poll = setInterval(async () => {
      if (modeRef.current !== "term") return;
      const d = await invoke<string>("pty_cwd", { id: api.id }).catch(() => "");
      if (d && d !== paramsRef.current.cwd) { api.updateParameters({ cwd: d }); saveLayout(); }
    }, 3000);
    // spawned children (spawn_agents): summarize their states in this pane's header
    const kidsTimer = setInterval(() => {
      const c = [...agents.entries()].filter(([, a]) => a.spawnedBy === api.id).map(([, a]) => a);
      if (!c.length) return setKids("");
      const n = (k: keyof typeof c[0]) => c.filter((a) => a[k]).length;
      setKids([n("perm") && `${n("perm")} ⚠`, n("busy") && `${n("busy")} working`, c.length - n("busy") - n("perm") > 0 && `${c.length - n("busy") - n("perm")} done`].filter(Boolean).join(" · "));
    }, 1000);
    return () => { d1.dispose(); d2.dispose(); d3.dispose(); root.current?.removeEventListener("x-term-rename", rename); clearInterval(poll); clearInterval(kidsTimer); };
  }, []);
  const cwdTail = (mode === "agent" ? agentCwd : params.cwd)?.replace(/\/$/, "").replace(/^.*\//, "") ?? "";
  const switchTo = async (m: Mode) => {
    // every hop into the chat carries the shell's current directory; the chat applies it until its first message
    if (m === "agent" && seen.term) { const d = await invoke<string>("pty_cwd", { id: api.id }).catch(() => ""); if (d) setAgentCwd(d); }
    setSeen((s) => ({ ...s, [m]: true }));
    setMode(m);
    api.updateParameters({ mode: m });
    saveLayout();
  };
  useEffect(() => { const t = setTimeout(() => root.current?.querySelector<HTMLTextAreaElement>(`.slot.${mode} textarea`)?.focus(), 0); return () => clearTimeout(t); }, [mode]);
  // interactive-only slash commands (/plugin, /skills, /status …) are not available in -p mode: run the real CLI in the shell
  const pending = useRef<string | null>(null);
  const flush = () => { if (pending.current) { invoke("pty_write", { id: api.id, data: pending.current + "\n" }).catch(warn); pending.current = null; } };
  const runInTerm = (cmd: string) => { pending.current = cmd; if (seen.term) { switchTo("term"); flush(); } else switchTo("term"); };
  /** Ctrl+C in the chat = end the claude session (like the CLI): drop the chat; the next Ctrl+A starts fresh where the shell is. */
  const endAgent = () => {
    setSeen({ term: true, agent: false }); // panes that began as a chat have no shell yet: mount one now
    setMode("term");
    api.updateParameters({ mode: "term", resume: undefined, title: undefined, fork: undefined, quote: undefined });
    saveLayout();
  };
  const lastPane = () => containerApi.panels.length <= 1;
  // shell ended: switch to a waiting chat if any, else close — but the last remaining terminal is the app's base, so respawn it instead of leaving an empty window
  const onExit = () => { if (seen.agent) { setSeen((s) => ({ ...s, term: false })); switchTo("agent"); } else if (lastPane()) setTermGen((g) => g + 1); else api.close(); };
  const commitTitle = () => {
    const t = (editing ?? "").trim().slice(0, 40);
    setEditing(null);
    if (t) { api.setTitle(t); api.updateParameters({ title: t }); saveLayout(); }
    setTimeout(() => root.current?.querySelector<HTMLElement>(`.slot.${modeRef.current} textarea`)?.focus(), 0);
  };
  return (
    <div className="pane-root" ref={root} data-id={api.id} data-mode={mode} data-spawned={params.spawnedBy ? "" : undefined}>
      <div className={`pane-hdr ${mode === "term" ? "term" : status}`} onMouseDown={() => api.setActive()}
        // drag the header onto another pane (terminator-style): dockview's own drop overlays / move logic take it from here,
        // it only needs the PanelTransfer that its (hidden) tab would have set
        draggable={editing === null}
        onDragStart={(e) => { LocalSelectionTransfer.getInstance().setData([new PanelTransfer(containerApi.id, api.group.id, api.id)], PanelTransfer.prototype); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", ""); }}
        onDragEnd={() => LocalSelectionTransfer.getInstance().clearData(PanelTransfer.prototype)} onDoubleClick={() => setEditing((params.title ?? api.title ?? "").replace(/^● /, ""))} title={mode === "agent" ? agentCwd : params.cwd}>
        <span className="n">{n}</span>
        {editing !== null
          ? <input className="t" autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={commitTitle} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commitTitle(); if (e.key === "Escape") setEditing(null); }} />
          : <span className="t">{params.spawnedBy ? "↑ " : ""}{title}</span>}
        {kids && <span className="kids" title="spawned agents">↓ {kids}</span>}
        <span className="cwd">{cwdTail}</span>
        <span className="st">{mode === "term" ? "sh" : STATUS_LABEL[status]}</span>
      </div>
      {seen.term && <div className={`slot term ${mode === "term" ? "" : "hidden"}`}><TermPane key={termGen} id={api.id} cwd={params.cwd} onSwitch={() => switchTo("agent")} onExit={onExit} onReady={flush} onTitle={(t) => { if (mode === "term" && !params.title) api.setTitle(t); }} onClose={() => { if (!lastPane()) api.close(); }} /></div>}
      {seen.agent && <div className={`slot agent ${mode === "agent" ? "" : "hidden"}`}><SessionPane {...props} params={{ ...params, cwd: agentCwd }} onSwitch={() => switchTo("term")} onEnd={endAgent} onTerminal={runInTerm} onStatus={setStatus} /></div>}
      {!params.spawnedBy && <AgentBar api={containerApi} parent={api.id} />}
    </div>
  );
}
