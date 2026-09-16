import { useEffect, useRef, useState } from "react";
import { DockviewReact, DockviewApi, DockviewReadyEvent, IDockviewPanelProps, themeDark, themeLight } from "dockview-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { SessionParams } from "./SessionPane";
import { Pane, PaneParams } from "./Pane";
import { cfg, applyConfig, toggleTheme, Config } from "./config";
import { invoke } from "@tauri-apps/api/core";
import { busyPanes, agents, warn } from "./events";
import { pickAgentModel } from "./util";
import { listen } from "@tauri-apps/api/event";
import { is, label, Action } from "./keys";
import { KeysDialog } from "./KeysDialog";

type SessionInfo = { id: string; mtime: number; summary: string; cwd: string };
type Worktree = { path: string; branch: string; head: string; main: boolean };
type Dir = "left" | "right" | "up" | "down";
const FOCUS: [Action, Dir][] = [["focusLeft", "left"], ["focusRight", "right"], ["focusUp", "up"], ["focusDown", "down"]];
const MOVE: [Action, Dir][] = [["moveLeft", "left"], ["moveRight", "right"], ["moveUp", "up"], ["moveDown", "down"]];
/** Nearest pane in `dir` from the active one, by on-screen geometry (panes carry data-id on .pane-root). */
function neighbor(api: DockviewApi, dir: Dir): string | undefined {
  const active = api.activePanel; if (!active) return;
  const rects = [...document.querySelectorAll<HTMLElement>(".pane-root[data-id]")].map((el) => { const r = el.getBoundingClientRect(); return { id: el.dataset.id!, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const c = rects.find((r) => r.id === active.id); if (!c) return;
  const ahead = (r: typeof c) => (dir === "left" ? c.x - r.x : dir === "right" ? r.x - c.x : dir === "up" ? c.y - r.y : r.y - c.y);
  const cross = (r: typeof c) => (dir === "left" || dir === "right" ? Math.abs(r.y - c.y) : Math.abs(r.x - c.x));
  return rects.filter((r) => r.id !== active.id && ahead(r) > 1).sort((a, b) => ahead(a) + 3 * cross(a) - (ahead(b) + 3 * cross(b)))[0]?.id;
}
/** Next pane after the active one (wrapping) whose registry entry passes `pred`; Alt+P / Alt+U. */
function nextWhere(api: DockviewApi, pred: (id: string) => boolean): string | undefined {
  const ids = api.panels.map((p) => p.id);
  const i = ids.indexOf(api.activePanel?.id ?? "");
  return [...ids.slice(i + 1), ...ids.slice(0, i + 1)].find(pred);
}

const ZOOM_KEY = "x-term.zoom";
const WIN_KEY = "x-term.window"; // size / position / maximized, restored on launch
applyConfig();

let counter = 0;
const zoom = () => Number(localStorage.getItem(ZOOM_KEY)) || 1;
const LAYOUT_KEY = "x-term.layout"; // dockview layout incl. per-pane params (cwd, session id, title) -> restored on launch

/** `term` = shell in a pty (default pane), `session` = claude stream-json chat. Alt+[ / Alt+] split into a terminal, Alt+Shift+[ / ] into a chat. */
export function openPane(api: DockviewApi, component: "term" | "session", params: PaneParams, referencePanel?: string, direction: "right" | "below" = "right", floating?: { x: number; y: number; width: number; height: number }) {
  const id = crypto.randomUUID();
  api.addPanel({
    id,
    component,
    title: (params as SessionParams).title ?? `${component === "term" ? "sh" : "claude"} ${++counter}`,
    params,
    ...(floating ? { floating } : { position: referencePanel ? { referencePanel, direction } : undefined }),
  });
  return id;
}

type McpReq = { id: string; pane: string; name: string; arguments: any };
const MAX_AGENTS = 8; // one spawn_agents call should not be able to open unbounded panes / claude processes
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agentStatus = (id: string) => {
  const a = agents.get(id);
  return { id, status: !a ? "closed" : a.perm ? "permission" : a.busy ? "working" : "idle", turns: a?.turns ?? 0, last: a?.last ?? "" };
};
/** Tool calls from a session's `x-term` MCP server (see src-tauri/src/mcp.rs): pane work happens here, answer via mcp_reply. */
async function handleMcp(api: DockviewApi, { id, pane, name, arguments: a }: McpReq) {
  const reply = (result: unknown, error?: string) => invoke("mcp_reply", { id, result: result ?? null, error: error ?? null }).catch(console.warn);
  try {
    const parent = api.getPanel(pane);
    const pcwd = (parent?.params as PaneParams | undefined)?.cwd;
    switch (name) {
      case "spawn_agents": {
        if (!parent) throw new Error("spawn_agents works only from a main pane");
        if ((parent.params as PaneParams | undefined)?.spawnedBy) throw new Error("a spawned agent cannot spawn more agents"); // structural guard: no nested spawning, so the prompt needs no "do not spawn" note
        const list: any[] = a.agents ?? [];
        if (list.length > MAX_AGENTS) throw new Error(`at most ${MAX_AGENTS} agents per call, got ${list.length}`);
        const out: { id: string; title: string; cwd: string; model: string; weight: string }[] = [];
        // spawned agents run autonomously (auto mode) in hidden floating panes; the bottom AgentBar is the UI
        const halfW = Math.floor((document.querySelector(".dock")?.clientWidth ?? window.innerWidth) / 2);
        let i = 0;
        for (const ag of list) {
          const cwd = ag.worktree ? await invoke<string>("git_worktree", { cwd: pcwd, name: ag.worktree }) : pcwd ?? "";
          const prompt = `${ag.prompt}\n\n(When done, end with a short summary of what changed.)`;
          const { weight, model, effort } = pickAgentModel(ag, cfg.agentModels);
          const off = i++ * 30; // cascade so stacked windows stay grabbable
          const nid = openPane(api, "session", { cwd, title: ag.title, mode: "agent", prompt, spawnedBy: pane, model, effort }, undefined, "right", { x: 60 + off, y: 60 + off, width: halfW, height: 440 });
          out.push({ id: nid, title: ag.title, cwd, model, weight });
        }
        parent.api.setActive();
        return reply({ agents: out });
      }
      case "agent_status": return reply(agentStatus(a.id));
      case "wait_agents": {
        const ids: string[] = a.ids ?? [];
        const deadline = Date.now() + Math.min(Math.max(a.timeout_s ?? 1800, 1), 7200) * 1000;
        const t0 = Date.now();
        // done = every pane finished at least one turn and is idle; a pane missing for >10s counts as closed
        const done = () => ids.every((i) => { const s = agentStatus(i); return s.status === "closed" ? Date.now() - t0 > 10_000 : s.status === "idle" && s.turns > 0; });
        while (!done() && Date.now() < deadline) await sleep(500);
        return reply({ timed_out: !done(), agents: ids.map(agentStatus) });
      }
      case "send_to_agent": {
        const el = document.querySelector(`.pane-root[data-id="${a.id}"]`);
        if (!el) throw new Error("no such pane");
        el.dispatchEvent(new CustomEvent("x-term-send", { detail: String(a.text ?? "") }));
        return reply({ ok: true });
      }
      case "close_agent": api.getPanel(a.id)?.api.close(); return reply({ ok: true });
      default: return reply(null, `unknown tool ${name}`);
    }
  } catch (e) { reply(null, String(e)); }
}

// both component names map to the same two-mode pane; the name only picks the initial mode (kept for saved layouts)
const components = {
  session: (props: IDockviewPanelProps<PaneParams>) => <Pane {...props} initial="agent" />,
  term: (props: IDockviewPanelProps<PaneParams>) => <Pane {...props} initial="term" />,
};

/** CLI-style footer: one row per spawned agent with live status colour + activity line. Click focuses its window (brings the floating pane to front); ✕ closes it. */
function AgentBar({ apiRef }: { apiRef: React.RefObject<DockviewApi | null> }) {
  const [rows, setRows] = useState<{ id: string; title: string; cls: string; log: string }[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set()); // ids whose floating window is revealed
  useEffect(() => {
    const t = setInterval(() => setRows([...agents.entries()].filter(([, a]) => a.spawnedBy).map(([id, a]) => ({
      id,
      title: apiRef.current?.getPanel(id)?.title ?? id.slice(0, 6),
      cls: a.err ? "err" : a.perm ? "perm" : a.busy ? "busy" : a.unread ? "unread" : "idle",
      log: a.busy ? a.activity : a.last?.split("\n")[0] ?? "",
    }))), 500);
    return () => clearInterval(t);
  }, []);
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s); const show = !n.has(id); show ? n.add(id) : n.delete(id);
    document.querySelector<HTMLElement>(`.pane-root[data-id="${id}"]`)?.classList.toggle("open", show);
    if (show) apiRef.current?.getPanel(id)?.api.setActive();
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
          <button title="terminate agent" onClick={(e) => { e.stopPropagation(); apiRef.current?.getPanel(r.id)?.api.close(); }}>✕</button>
        </div>
      ))}
    </div>
  );
}

/** Help overlay rows; combos come from src/keys.ts (and the user's `keys` overrides), so build them when the overlay opens. */
const shortcuts = (): [string, string][] => [
  [`${label("splitRight")} / ${label("splitBelow")}`, "split: new terminal right / below"],
  [`${label("chatRight")} / ${label("chatBelow")}`, "split: new claude chat right / below"],
  [label("close"), "close pane"],
  [`${label("focusLeft")} … ${label("focusDown")}`, "focus pane in that direction (+Shift: move pane there)"],
  [`${label("shrinkW")} … ${label("growH")}`, "resize pane"],
  ["Alt+1 … 9", "focus pane by number"],
  [label("maximize"), "maximize / restore pane"],
  [`${label("jumpPerm")} / ${label("jumpUnread")}`, "next pane waiting for permission / with an unread answer"],
  [label("rename"), "rename pane"],
  [label("sidebar"), "sidebar: open panes, worktrees, every project's sessions"],
  [`${label("changes")} (chat)`, "changes: git diff of the pane's repo"],
  ["/worktree name", "git worktree + new chat pane on that branch"],
  [`${label("agentMode")} (shell)`, "agent mode in the shell's cwd"],
  ["Ctrl+C (chat)", "interrupt turn / end session, back to shell"],
  ["Shift+Tab", "cycle permission mode"],
  ["Enter / Shift+Enter", "send / newline (config sendKey: ctrl+enter flips them)"],
  ["Enter / Ctrl+Enter / Esc (permission card, empty composer)", "allow / always allow / deny · plan: accept / accept+auto-edit / keep planning · question: 1-9 pick, Enter submit"],
  ["Esc", "interrupt (drops queued prompts)"],
  ["↑ / ↓", "prompt history (caret on first/last line)"],
  ["/ , @", "slash commands, file completion"],
  [label("find"), "find in conversation"],
  [label("focusComposer"), "focus composer"],
  [label("retry"), "retry last prompt"],
  [label("clear"), "/clear"],
  [label("run"), "run config `runCommand` in the pane's shell"],
  [label("thread"), "thread from selected text"],
  [`${label("scrollUp")} / ${label("scrollDown")}`, "scroll conversation"],
  [`${label("prevMsg")} / ${label("nextMsg")}`, "previous / next user message"],
  [`${label("termSearch")} (shell)`, "search scrollback"],
  [`${label("termCopy")} / ${label("termPaste")} (shell)`, "copy selection / paste"],
  ["right-click", "pane menu (agent/terminal mode, find, export, close)"],
  [`${label("zoomIn")} / ${label("zoomOut")} / ${label("zoomReset")}`, "zoom in / out / reset"],
  [label("theme"), "toggle dark / light"],
  [label("config"), "open config.json in the editor (reloads on save)"],
  ["! cmd", "run in the pane's shell"],
  ["/search, /title, /resume, /config", "find past sessions, rename pane, pick a session, open config"],
  [`${label("help")} / ${label("help2")}`, "this help"],
];

/** Save / restore the window geometry without the window-state plugin. */
async function saveWindow() {
  const w = getCurrentWindow();
  try {
    const [pos, size, max] = await Promise.all([w.outerPosition(), w.innerSize(), w.isMaximized()]);
    const prev = JSON.parse(localStorage.getItem(WIN_KEY) ?? "{}");
    // maximized: keep the last normal geometry, only remember the flag
    localStorage.setItem(WIN_KEY, JSON.stringify(max ? { ...prev, max } : { x: pos.x, y: pos.y, w: size.width, h: size.height, max }));
  } catch (e) { warn(e); }
}
async function restoreWindow() {
  const s = localStorage.getItem(WIN_KEY); if (!s) return;
  const w = getCurrentWindow();
  try {
    const g = JSON.parse(s);
    if (g.w > 200 && g.h > 200) await w.setSize(new PhysicalSize(g.w, g.h));
    if (Number.isFinite(g.x) && Number.isFinite(g.y)) await w.setPosition(new PhysicalPosition(g.x, g.y));
    if (g.max) await w.maximize();
  } catch (e) { warn(e); }
}

export default function App() {
  const apiRef = useRef<DockviewApi>(null);
  const [help, setHelp] = useState(false);
  const [side, setSide] = useState(false);
  const [all, setAll] = useState<SessionInfo[]>([]);
  const [wts, setWts] = useState<{ cwd: string; list: Worktree[] }>({ cwd: "", list: [] }); // worktrees of the repo the sidebar was opened from
  const [q, setQ] = useState("");
  const [, setTick] = useState(0); // sidebar: open-pane states refresh every 2 s while it is open
  const [theme, setTheme] = useState(cfg.theme);
  const [toast, setToast] = useState("");
  const say = (t: string) => { setToast(t); setTimeout(() => setToast(""), 5000); };
  const sideCwd = () => (apiRef.current?.activePanel?.params as PaneParams | undefined)?.cwd ?? "";
  const loadWts = () => { const cwd = sideCwd(); invoke<Worktree[]>("git_worktree_list", { cwd }).then((list) => setWts({ cwd, list })).catch(() => setWts({ cwd, list: [] })); };
  useEffect(() => {
    if (!side) return;
    invoke<SessionInfo[]>("list_all_sessions").then(setAll).catch(() => setAll([]));
    loadWts();
    const t = setInterval(() => setTick((x) => x + 1), 2000);
    return () => clearInterval(t);
  }, [side]);
  const onReady = async (e: DockviewReadyEvent) => {
    apiRef.current = e.api;
    const args = await invoke<string[]>("cli_args").catch(() => [] as string[]);
    const saved = cfg.restoreLayout && !args.includes("--fresh") ? localStorage.getItem(LAYOUT_KEY) : null;
    try { if (saved) e.api.fromJSON(JSON.parse(saved)); } catch { localStorage.removeItem(LAYOUT_KEY); }
    // spawned floating panes reference claude processes that died with the last run: drop them so a restart never restores a stuck/empty window
    for (const p of [...e.api.panels]) if ((p.params as PaneParams | undefined)?.spawnedBy) p.api.close();
    // no group in the grid = a broken/empty restore (e.g. orphan panels with no layout): reset to a fresh pane instead of a dead window
    if (!e.api.groups.length) { localStorage.removeItem(LAYOUT_KEY); openPane(e.api, "term", {}); }
    e.api.onDidRemovePanel((p) => localStorage.removeItem(`x-term.draft.${p.id}`)); // a closed pane's composer draft is unreachable: drop it
    e.api.onDidLayoutChange(() => localStorage.setItem(LAYOUT_KEY, JSON.stringify(e.api.toJSON())));
  };
  const helpRef = useRef(false);
  helpRef.current = help;
  const [keysDlg, setKeysDlg] = useState(false); // titlebar ⌨: shortcut editor; while open, no pane shortcut fires
  const keysDlgRef = useRef(false);
  keysDlgRef.current = keysDlg;
  const openConfig = () => invoke<string>("open_config").then((p) => say(`opened ${p}`)).catch((e) => say(String(e))); // creates the file with a starter when missing
  useEffect(() => {
    // capture phase: Escape closes the help overlay before any pane sees it (a pane's Escape interrupts a turn / denies a permission)
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape" && helpRef.current) { e.preventDefault(); e.stopPropagation(); setHelp(false); } };
    window.addEventListener("keydown", onEsc, true);
    const onKey = async (e: KeyboardEvent) => {
      if (keysDlgRef.current) return; // the shortcuts dialog owns the keyboard
      const api = apiRef.current;
      const inShell = !!(e.target as HTMLElement | null)?.closest?.(".term"); // F1 / F2 belong to the shell's program there (htop, mc …)
      if ((is(e, "help") && !inShell) || is(e, "help2")) { e.preventDefault(); setHelp((h) => !h); return; }
      const zoomIn = is(e, "zoomIn") || (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "Equal"); // Ctrl+Shift+= is how "+" is typed
      if (zoomIn || is(e, "zoomOut") || is(e, "zoomReset")) { // webview zoom: scales chat and terminal alike
        e.preventDefault();
        const z = is(e, "zoomReset") ? 1 : Math.min(3, Math.max(0.5, +(zoom() + (is(e, "zoomOut") ? -0.1 : 0.1)).toFixed(1)));
        localStorage.setItem(ZOOM_KEY, String(z));
        getCurrentWebview().setZoom(z).catch(console.warn);
        return;
      }
      // Ctrl+C acts on the active chat pane wherever the focus is (nothing selected): interrupt the turn, or end the session
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC" && api?.activePanel) {
        const el = document.querySelector<HTMLElement>(`.pane-root[data-id="${api.activePanel.id}"]`);
        const t = document.activeElement as HTMLTextAreaElement | null;
        const hasSel = (t?.tagName === "TEXTAREA" && t.selectionStart !== t.selectionEnd) || !!window.getSelection()?.toString();
        if (el?.dataset.mode === "agent" && !hasSel && !t?.closest(".thread")) { e.preventDefault(); el.dispatchEvent(new CustomEvent("x-term-ctrlc")); }
        return;
      }
      if (is(e, "sidebar")) { e.preventDefault(); setSide((s) => !s); return; }
      if (is(e, "theme")) { e.preventDefault(); toggleTheme(); return; }
      if (is(e, "config")) { e.preventDefault(); openConfig(); return; }
      if (!api) return;
      const active = api.activePanel;
      const activeEl = active && document.querySelector<HTMLElement>(`.pane-root[data-id="${active.id}"]`);
      for (const [a, dir] of FOCUS) if (is(e, a)) { e.preventDefault(); const id = neighbor(api, dir); if (id) api.getPanel(id)?.api.setActive(); return; }
      for (const [a, dir] of MOVE) if (is(e, a)) {
        e.preventDefault();
        const id = neighbor(api, dir); const target = id ? api.getPanel(id) : undefined;
        if (target && active) active.api.moveTo({ group: target.group, position: ({ left: "left", right: "right", up: "top", down: "bottom" } as const)[dir] });
        return;
      }
      if (is(e, "shrinkW") || is(e, "growW") || is(e, "shrinkH") || is(e, "growH")) {
        e.preventDefault();
        if (!active) return;
        const step = 60;
        if (is(e, "shrinkW") || is(e, "growW")) active.api.setSize({ width: Math.max(120, active.api.width + (is(e, "growW") ? step : -step)) });
        else active.api.setSize({ height: Math.max(80, active.api.height + (is(e, "growH") ? step : -step)) });
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) { e.preventDefault(); api.panels[Number(e.code.slice(5)) - 1]?.api.setActive(); return; }
      if (is(e, "jumpPerm") || is(e, "jumpUnread")) {
        e.preventDefault();
        const id = nextWhere(api, (i) => !!(is(e, "jumpPerm") ? agents.get(i)?.perm : agents.get(i)?.unread));
        if (id) api.getPanel(id)?.api.setActive(); else say(is(e, "jumpPerm") ? "no pane is waiting for permission" : "no unread pane");
        return;
      }
      if (is(e, "maximize")) { e.preventDefault(); api.hasMaximizedGroup() ? api.exitMaximizedGroup() : active?.api.maximize(); return; }
      if (is(e, "rename") && !inShell) { e.preventDefault(); activeEl?.dispatchEvent(new CustomEvent("x-term-rename")); return; }
      if (is(e, "close")) { e.preventDefault(); active?.api.close(); return; }
      const split = (["splitRight", "splitBelow", "chatRight", "chatBelow"] as Action[]).find((a) => is(e, a));
      if (split) {
        e.preventDefault();
        // new panes inherit the active pane's directory: the shell's live cwd (after `cd`) when it is in terminal mode
        let cwd = (active?.params as PaneParams | undefined)?.cwd;
        if (active && activeEl?.dataset.mode === "term") cwd = (await invoke<string>("pty_cwd", { id: active.id }).catch(() => "")) || cwd;
        openPane(api, split.startsWith("chat") ? "session" : "term", { cwd }, active?.id, split.endsWith("Below") ? "below" : "right");
      }
    };
    window.addEventListener("keydown", onKey);
    // `/worktree` and the sidebar open new chat panes next to the active one
    const onOpen = (e: Event) => { const api = apiRef.current; if (api) openPane(api, "session", (e as CustomEvent<PaneParams>).detail, api.activePanel?.id); };
    window.addEventListener("x-term-open", onOpen);
    const onCfg = () => setTheme(cfg.theme);
    window.addEventListener("x-term-config", onCfg);
    const unmcp = listen<McpReq>("mcp-request", (e) => { const api = apiRef.current; if (api) handleMcp(api, e.payload); else invoke("mcp_reply", { id: e.payload.id, result: null, error: "x-term not ready" }); });
    const uncfg = listen<Partial<Config>>("config-changed", (e) => { applyConfig(e.payload); say("config reloaded"); });
    const unclose = getCurrentWindow().onCloseRequested(async (e) => {
      // the async dialog can't gate the synchronous close event, so we always take over the close and finish it ourselves
      e.preventDefault();
      if (cfg.confirmQuit && busyPanes.size && !(await confirm(`${busyPanes.size} session(s) still working. Quit anyway?`))) return;
      await saveWindow();
      await getCurrentWindow().destroy();
    });
    restoreWindow();
    if (zoom() !== 1) getCurrentWebview().setZoom(zoom()).catch(console.warn);
    // OS file drop: hand the paths to the pane under the cursor (Chat listens for "x-term-drop")
    const drop = getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type !== "drop") return;
      const { x, y } = ev.payload.position;
      const s = window.devicePixelRatio || 1;
      document.elementFromPoint(x / s, y / s)?.closest(".pane")?.dispatchEvent(new CustomEvent("x-term-drop", { detail: ev.payload.paths }));
    });
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keydown", onEsc, true); window.removeEventListener("x-term-open", onOpen); window.removeEventListener("x-term-config", onCfg); drop.then((f) => f()); unclose.then((f) => f()); unmcp.then((f) => f()); uncfg.then((f) => f()); };
  }, []);
  const win = getCurrentWindow();
  const panels = side ? apiRef.current?.panels ?? [] : [];
  const stateOf = (id: string) => { const a = agents.get(id); return !a ? "sh" : a.perm ? "⚠ permission" : a.busy ? "⏳ working" : a.unread ? "● done" : "idle"; };
  const mergeWt = async (w: Worktree) => {
    if (!w.branch) return say("detached worktree: nothing to merge");
    if (!(await confirm(`git merge ${w.branch} into the main checkout?`))) return;
    await invoke<string>("git_worktree_merge", { cwd: wts.cwd, branch: w.branch }).then((out) => say(out.trim().split("\n").pop() || "merged")).catch((e) => say(String(e)));
    loadWts();
  };
  const removeWt = async (w: Worktree) => {
    if (!(await confirm(`Remove worktree ${w.path}${w.branch ? ` and delete branch ${w.branch}` : ""}? (fails if it has uncommitted changes)`))) return;
    await invoke("git_worktree_remove", { cwd: wts.cwd, path: w.path, deleteBranch: !!w.branch }).then(() => say("worktree removed")).catch((e) => say(String(e)));
    loadWts();
  };
  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <span data-tauri-drag-region>x-term</span>
        <button className="tb" title="shortcuts: view and change key bindings" onClick={() => setKeysDlg(true)}>⌨ keys</button>
        <button className="tb" title={`open config.json in the editor (${label("config")})`} onClick={openConfig}>⚙ config</button>
        <button onClick={() => win.minimize()}>–</button>
        <button onClick={() => win.toggleMaximize()}>▢</button>
        <button onClick={() => win.close()}>×</button>
      </div>
      <div className="body">
        {side && (
          <aside className="side">
            <input placeholder={`filter by project or prompt (${label("sidebar")} closes)`} value={q} onChange={(e) => setQ(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === "Escape") setSide(false); }} />
            <ul>
              <li className="side-hdr">open panes</li>
              {panels.map((p, i) => {
                const pp = p.params as PaneParams | undefined;
                return (
                  <li key={p.id} className={p.api.isActive ? "sel" : ""} onClick={() => { p.api.setActive(); }}>
                    <b>{i + 1}</b> {pp?.spawnedBy ? "↑ " : ""}{p.title} <span className="dim">{pp?.cwd?.replace(/^.*\//, "")} · {stateOf(p.id)}</span>
                  </li>
                );
              })}
              {wts.list.length > 1 && <li className="side-hdr">worktrees · {wts.list.find((w) => w.main)?.path.replace(/^.*\//, "")}</li>}
              {wts.list.length > 1 && wts.list.filter((w) => !w.main).map((w) => (
                <li key={w.path}>
                  <b>{w.branch || w.head}</b> <span className="dim">{w.path.replace(/^.*\//, "")}</span>
                  <span className="side-acts">
                    <button title="open a chat pane there" onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent("x-term-open", { detail: { cwd: w.path, title: `wt:${w.branch || w.head}` } })); }}>open</button>
                    <button title="git merge into the main checkout" onClick={(e) => { e.stopPropagation(); mergeWt(w); }}>merge</button>
                    <button title="git worktree remove + delete branch" onClick={(e) => { e.stopPropagation(); removeWt(w); }}>remove</button>
                  </span>
                </li>
              ))}
              <li className="side-hdr">sessions</li>
              {all.filter((s) => `${s.cwd} ${s.summary}`.toLowerCase().includes(q.toLowerCase())).slice(0, 200).map((s) => (
                <li key={s.id} onClick={() => { window.dispatchEvent(new CustomEvent("x-term-open", { detail: { resume: s.id, cwd: s.cwd, title: s.summary.slice(0, 30) } })); setSide(false); }}>
                  <b>{s.cwd.replace(/^.*\//, "")}</b> <span className="dim">{new Date(s.mtime * 1000).toLocaleString()}</span>
                  <div>{s.summary}</div>
                </li>
              ))}
            </ul>
          </aside>
        )}
        <div className="dock">
          <DockviewReact theme={theme === "light" ? themeLight : themeDark} components={components} onReady={onReady} />
        </div>
      </div>
      <AgentBar apiRef={apiRef} />
      {toast && <div className="toast app-toast">{toast}</div>}
      {keysDlg && <KeysDialog onClose={() => setKeysDlg(false)} />}
      {help && (
        <div className="help" onClick={() => setHelp(false)}>
          <div><h3>shortcuts</h3><table><tbody>{shortcuts().map(([k, v], i) => <tr key={i}><td>{k}</td><td>{v}</td></tr>)}</tbody></table></div>
        </div>
      )}
    </div>
  );
}
