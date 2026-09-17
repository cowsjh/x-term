import { Fragment, memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { onEvent, warn, busyPanes, agents, AgentState } from "./events";
import { IDockviewPanelProps } from "dockview-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { ToolCard, SubStep } from "./ToolCard";
import { ansiToHtml } from "./ansi";
import { Menu } from "./Menu";
import { openUrl } from "@tauri-apps/plugin-opener";
import { confirm } from "@tauri-apps/plugin-dialog";
import { cfg, projectConfig } from "./config";
import { is, label } from "./keys";
import { Img, Msg, Hist, Paste, modelLabel, fmtTok, fmtSec, toMsgs, takeContext, pushContext, IMAGE_EXT, diffLines, diffStat, lsGet, mdBlocks, MODES, MODELS, EFFORTS } from "./util";
import type { PaneStatus } from "./Pane";

export type SessionParams = { title?: string; resume?: string; fork?: boolean; quote?: string; cwd?: string; prompt?: string; spawnedBy?: string; model?: string; effort?: string }; // prompt: sent once the process is up (spawned agents); model/effort: per-pane override (spawn_agents weight)
const DRAFT = (id: string) => `x-term.draft.${id}`; // composer text survives restarts; App drops it when the pane is closed
type Task = { subject: string; status: string };
const TASK_ICON: Record<string, string> = { pending: "☐", in_progress: "◐", completed: "☑" };
type SessionInfo = { id: string; mtime: number; summary: string; cwd?: string }; // cwd set for /search hits (other projects)
type Perm = { request_id: string; tool_name: string; input: any; description?: string; permission_suggestions?: any[] };
const MODE_KEY = "x-term.permissionMode";
const LOCAL = ["resume", "search", "title", "worktree", "config"]; // handled by x-term itself, never sent to the CLI
const HIST_KEY = "x-term.history"; // last 100 prompts, shared by all panes
// Follow-up thread window. ax/ay = anchor in .msgs content coords; rendered fixed (portal), follows scroll, stacks at the top when its text scrolls out
/** `resume` = main session it forked from, `sid` = the thread's own (forked) session once known -> restored with --resume, no re-fork. */
type Thread = { id: string; ax: number; ay: number; quote: string; resume?: string; sid?: string; open: boolean; mark?: boolean }; // mark = highlight only (bookmark), no session
// Threads belong to a conversation: stored per main session id, swapped in/out together with it.
const threadsKey = (sid: string) => `x-term.threads.${sid}`;
const loadThreads = (sid?: string): Thread[] => (sid ? JSON.parse(localStorage.getItem(threadsKey(sid)) ?? "[]") : []);
const THREAD_INDEX = "x-term.threads.index"; // insertion-ordered session ids; oldest thread sets are dropped past the cap
const THREAD_CAP = 100;
function touchThreadIndex(sid: string) {
  const idx: string[] = lsGet(THREAD_INDEX, "[]").filter((x: string) => x !== sid);
  idx.push(sid);
  for (const old of idx.splice(0, Math.max(0, idx.length - THREAD_CAP))) localStorage.removeItem(threadsKey(old));
  localStorage.setItem(THREAD_INDEX, JSON.stringify(idx));
}

let mermaidSeq = 0;
/** ```mermaid fences: rendered to SVG (lazy-loaded lib). While streaming / on a parse error the raw code block shows instead. */
function Mermaid({ code, children }: { code: string; children: React.ReactNode }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let live = true;
    // debounce: streaming rewrites `code` every delta; render only once it settles, so partial diagrams never flash
    const t = setTimeout(() => import("mermaid").then(async ({ default: m }) => {
      m.initialize({ startOnLoad: false, look: "classic", theme: "base", themeVariables: { fontSize: "15px", fontFamily: "system-ui, sans-serif", primaryColor: "#3a3a3a", primaryTextColor: "#e6e6e6", primaryBorderColor: "#777", lineColor: "#aaa", secondaryColor: "#2e2e2e", tertiaryColor: "#333", edgeLabelBackground: "#262626" }, flowchart: { padding: 16, nodeSpacing: 60, rankSpacing: 60 } });
      try { const r = await m.render(`mmd-${++mermaidSeq}`, code); if (live) setSvg(r.svg); }
      catch { /* partial/invalid mid-stream: keep last good SVG (raw block if none yet), never flip back */ }
    }), 200);
    return () => { live = false; clearTimeout(t); };
  }, [code]);
  return svg ? <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} /> : <>{children}</>;
}
function Pre({ "data-mermaid": mmd, ...props }: React.ComponentProps<"pre"> & { "data-mermaid"?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [ok, setOk] = useState(false);
  const pre = (
    <div className="codewrap">
      <button className="copy" onClick={() => { navigator.clipboard.writeText(ref.current?.innerText ?? mmd ?? ""); setOk(true); setTimeout(() => setOk(false), 1200); }}>{ok ? "copied" : "copy"}</button>
      <pre ref={ref} {...props} />
    </div>
  );
  return mmd ? <Mermaid code={mmd}>{pre}</Mermaid> : pre;
}
/** Tags `pre > code` with data-block so Code can tell fenced blocks from inline code (highlighting turns children into spans); ```mermaid source goes on the pre for Pre/Mermaid. */
function markBlocks() {
  const walk = (n: any) => {
    if (n.type === "element" && n.tagName === "pre") for (const c of n.children ?? []) if (c.tagName === "code") {
      c.properties = { ...c.properties, dataBlock: true };
      if ((c.properties.className ?? []).includes("language-mermaid")) n.properties = { ...n.properties, dataMermaid: c.children.map((t: any) => t.value ?? "").join("") };
    }
    for (const c of n.children ?? []) walk(c);
  };
  return walk;
}
/** Inline code: click to copy. Block code keeps its own copy button via Pre. */
function Code(props: React.ComponentProps<"code"> & { "data-block"?: boolean }) {
  const [ok, setOk] = useState(false);
  if (props["data-block"]) return <code {...props} />;
  const text = String(props.children ?? "");
  return <code {...props} className={`${props.className ?? ""} inline ${ok ? "copied" : ""}`} title="click to copy"
    onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 800); }} />;
}
/** Links: system browser, never navigate the webview. */
const A = (p: React.ComponentProps<"a">) => <a {...p} onClick={(e) => { e.preventDefault(); if (p.href) openUrl(p.href).catch(warn); }} />;
const plugins = { remarkPlugins: [remarkGfm, remarkMath], rehypePlugins: [rehypeKatex, markBlocks, [rehypeHighlight, { ignoreMissing: true }] as any], components: { pre: Pre, code: Code, a: A } };
const LONG = 4000; // assistant messages past this fold to a preview until clicked open (the streaming one stays open)
type RowActs = { edit: (m: Plain) => void; retry: (m: Plain) => void };
/** One message. memo: a streaming turn re-renders only the last row, not every Markdown tree in the list. */
type Plain = Exclude<Msg, { role: "tool" }>;
const Block = memo(function Block({ text }: { text: string }) { return <Markdown {...plugins}>{text}</Markdown>; });
/** While streaming, only the trailing block re-parses per frame; the finished turn renders as one document again. */
const StreamMd = ({ text }: { text: string }) => <>{mdBlocks(text).map((b, i) => <Block key={i} text={b} />)}</>;
const Row = memo(function Row({ m, last, stream, acts }: { m: Plain; last: boolean; stream?: boolean; acts: React.RefObject<RowActs> }) {
  const [open, setOpen] = useState(false);
  const fold = m.role === "assistant" && !last && !open && m.text.length > LONG;
  return (
    <div className={`msg ${m.role} ${fold ? "folded" : ""}`}>
      {(m.role === "user" || m.role === "assistant") && (
        <span className="msg-bar">
          {m.ts && <span className="dim">{new Date(m.ts).toLocaleTimeString()}</span>}
          <button onClick={() => navigator.clipboard.writeText(m.text)} title="copy message">copy</button>
          {m.role === "user" && <button onClick={() => acts.current?.edit(m)} title="load into composer">edit</button>}
          {m.role === "user" && <button onClick={() => acts.current?.retry(m)} title="send again">retry</button>}
        </span>
      )}
      {m.images?.map((im, j) => <img key={j} src={`data:${im.media_type};base64,${im.data}`} title="click to enlarge" />)}
      {m.role === "err" || m.role === "note" ? m.text
        : m.role === "thinking" ? (m.text ? <details><summary>thinking</summary>{m.text}</details> : <span>thinking · ~{m.tokens ?? 0} tokens</span>)
        : stream ? <StreamMd text={m.text} /> : <Markdown {...plugins}>{fold ? m.text.slice(0, LONG) : m.text}</Markdown>}
      {fold && <button className="more" onClick={() => setOpen(true)}>show all ({m.text.length.toLocaleString()} chars)</button>}
    </div>
  );
});
/** Conversation as markdown (for export). */
const toMarkdown = (msgs: Msg[]) => msgs.map((m) => m.role === "user" ? `## User\n\n${m.text}` : m.role === "assistant" ? `## Assistant\n\n${m.text}` : m.role === "tool" ? `> **${m.name}** ${toolSummary(m.input)}${m.result ? `\n\n\`\`\`\n${m.result.slice(0, 4000)}\n\`\`\`` : ""}` : "").filter(Boolean).join("\n\n");
// Long multi-line pastes become a chip above the composer and are appended to the prompt on send
const SPIN = ["✻", "✽", "✶", "✳", "✢", "·"];
const toolSummary = (input: any) => (typeof input?.command === "string" ? input.command : input?.file_path ?? input?.pattern ?? input?.description ?? "");
const PASTE_LINES = 6;
const PASTE_CHARS = 600;
const FORKS = "x-term.forks"; // session ids spawned by thread windows (--fork-session); hidden from the /resume picker
const BUILTINS = "x-term.builtinCommands"; // CLI reports slash_commands only after the first turn; cache across sessions
// Context window comes from result.modelUsage[*].contextWindow after the first turn; 200k until then.
const DEFAULT_CTX = 200_000;
const THREAD_W = 420;
const THREAD_H = 380; // header + body; window is clamped so it never runs past the viewport bottom
// Thread quotes are painted with the CSS Custom Highlight API (no DOM edits under React): one shared registry per state, panes add/remove their own ranges.
const HL = { closed: new Highlight(), open: new Highlight(), mark: new Highlight() };
CSS.highlights.set("thread", HL.closed);
CSS.highlights.set("thread-open", HL.open);
CSS.highlights.set("mark", HL.mark);
const unpaint = (r: Range) => { HL.closed.delete(r); HL.open.delete(r); HL.mark.delete(r); };
/** Range covering `quote` inside `root`, matched with all whitespace removed (markdown rendering re-wraps it). First occurrence. */
function findQuote(root: Node, quote: string): Range | null {
  const q = quote.replace(/\s+/g, "");
  if (!q) return null;
  let text = "";
  const at: { node: Text; off: number }[] = []; // index in `text` -> position in the DOM
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    if (n.parentElement?.closest(".msg-bar, button, textarea")) continue;
    for (let i = 0; i < n.data.length; i++) if (!/\s/.test(n.data[i])) { text += n.data[i]; at.push({ node: n, off: i }); }
  }
  const i = text.indexOf(q);
  if (i < 0) return null;
  const r = document.createRange();
  r.setStart(at[i].node, at[i].off);
  r.setEnd(at[i + q.length - 1].node, at[i + q.length - 1].off + 1);
  return r;
}

export function SessionPane({ api, containerApi, params, onSwitch, onEnd, onTerminal, onStatus }: IDockviewPanelProps<SessionParams> & { onSwitch: () => void; onEnd: () => void; onTerminal: (cmd: string) => void; onStatus: (s: PaneStatus) => void }) {
  const [unread, setUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permPending, setPermPending] = useState(false);
  const [err, setErr] = useState(false);
  useEffect(() => { onStatus(err ? "err" : permPending ? "perm" : busy ? "busy" : unread ? "unread" : "idle"); }, [busy, permPending, unread, err]);
  useEffect(() => { agents.set(api.id, { busy: false, perm: false, unread: false, last: "", turns: 0, spawnedBy: params.spawnedBy, activity: "", err: false }); return () => { busyPanes.delete(api.id); agents.delete(api.id); }; }, []);
  const reg = (p: Partial<AgentState>) => { const a = agents.get(api.id); if (a) agents.set(api.id, { ...a, ...p }); };
  const onLive = (p: { activity?: string; err?: boolean }) => { if (p.activity !== undefined) reg({ activity: p.activity }); if (p.err !== undefined) { setErr(p.err); reg({ err: p.err }); } };
  useEffect(() => { reg({ unread }); }, [unread]);
  const onPerm = (p: Perm | null) => { // another pane may be waiting on you: badge + notification
    setPermPending(!!p); reg({ perm: !!p });
    if (p && !(api.isActive && document.hasFocus())) { setUnread(true); if (cfg.notify !== "none") notify(params.title ?? api.title ?? "x-term", `permission: ${p.tool_name} ${toolSummary(p.input)}`.slice(0, 120)); }
  };
  const [changes, setChanges] = useState<{ root: string; files: [string, string][]; sel: string | null; diff: string } | null>(null);
  const openChanges = async () => {
    const st = await invoke<{ root: string; files: [string, string][] }>("git_status", { cwd: params.cwd ?? "" }).catch((e) => { setToast(String(e)); setTimeout(() => setToast(""), 4000); return null; });
    if (!st) return;
    // files this session edited (Edit/Write/MultiEdit cards) sort first
    const touched = new Set(msgsRef.current.flatMap((m) => (m.role === "tool" && typeof m.input?.file_path === "string" ? [m.input.file_path] : [])));
    const files = [...st.files].sort((a, b) => Number(touched.has(`${st.root}/${b[1]}`)) - Number(touched.has(`${st.root}/${a[1]}`)));
    setChanges({ root: st.root, files: files.map(([k, f]) => [touched.has(`${st.root}/${f}`) ? `✎${k}` : k, f]), sel: null, diff: await invoke<string>("git_diff", { cwd: params.cwd ?? "", path: null }).catch(String) });
  };
  // click a diff line -> quoted into the composer (file:line + the line); several clicks, one message, like Desktop's batched review comments
  const quoteLine = (file: string, line: number | undefined, text: string) => pushContext(api.id, { text: `${file}${line ? `:${line}` : ""}\n${text}`, label: file, ask: true });
  const reviewCode = () => { setChanges(null); document.querySelector(`.pane-root[data-id="${api.id}"]`)?.dispatchEvent(new CustomEvent("x-term-send", { detail: "Review the current uncommitted changes (git diff HEAD). Report only high-signal issues: compile errors, definite logic errors, security vulnerabilities, obvious bugs. Skip style, formatting and pre-existing problems. Cite file:line for each." })); };
  const [stat, setStat] = useState<{ add: number; del: number } | null>(null); // +N -M after a turn that edited files; click opens changes
  const loadDiff = async (path: string | null) => {
    setChanges((c) => c && { ...c, sel: path, diff: "…" });
    const diff = await invoke<string>("git_diff", { cwd: params.cwd ?? "", path }).catch(String);
    setChanges((c) => c && { ...c, sel: path, diff });
  };
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [find, setFind] = useState<string | null>(null); // Ctrl+F: in-conversation search (WebKit window.find)
  const [toast, setToast] = useState("");
  const msgsRef = useRef<Msg[]>([]);
  const exportMd = async () => {
    const name = `${(params.title ?? api.title ?? "session").replace(/[^\w가-힣-]+/g, "_").slice(0, 40)}-${(params.resume ?? api.id).slice(0, 8)}`;
    const path = await invoke<string>("save_export", { name, content: toMarkdown(msgsRef.current) }).catch((e) => `export failed: ${e}`);
    setToast(path); setTimeout(() => setToast(""), 4000);
  };
  // right-click anywhere in the chat -> pane menu (inputs and thread windows keep the native menu)
  const onCtx = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("textarea, input, select, .thread, .slash, .perm")) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };
  const sel = () => window.getSelection()?.toString() ?? "";
  const onKeyCapture = (e: React.KeyboardEvent) => { // capture: wins over the textarea's own handler
    if ((e.target as HTMLElement).closest(".thread")) return; // thread windows are portals: their keys bubble here through React, not for us
    if (is(e, "find")) { e.preventDefault(); e.stopPropagation(); openFind(); }
    if (is(e, "changes")) { e.preventDefault(); e.stopPropagation(); changes ? setChanges(null) : openChanges(); }
    if (e.key === "Escape" && changes) { e.stopPropagation(); setChanges(null); }
  };
  const findRef = useRef<HTMLInputElement>(null);
  const openFind = () => {
    setFind((f) => f ?? "");
    // dockview re-focuses the active panel on pointer/keyboard activity; claim focus after it does
    for (const ms of [0, 50, 150]) setTimeout(() => { const el = findRef.current; if (el && document.activeElement !== el) { el.focus(); el.select(); } }, ms);
  };
  const onFindKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); (window as any).find(e.currentTarget.value, false, e.shiftKey, true, false, true, false); }
    if (e.key === "Escape") { setFind(null); findRef.current?.closest(".pane-wrap")?.querySelector<HTMLElement>(".composer textarea")?.focus(); } // this pane's composer, not the first pane's
  };
  useEffect(() => {
    const d = api.onDidActiveChange(({ isActive }) => { if (isActive) setUnread(false); });
    const onFocus = () => { if (api.isActive) setUnread(false); }; // answer landed while the window was unfocused but this pane was already active: no active-change fires
    window.addEventListener("focus", onFocus);
    return () => { d.dispose(); window.removeEventListener("focus", onFocus); };
  }, [api]);
  useEffect(() => { api.setTitle((unread ? "● " : "") + (params.title ?? api.title ?? "").replace(/^● /, "")); }, [unread, params.title]);
  const onState: ChatProps["onState"] = (st) => {
    if (st.busy !== undefined) { setBusy(st.busy); reg({ busy: st.busy }); st.busy ? busyPanes.add(api.id) : busyPanes.delete(api.id); }
    // keep session id / cwd / title in panel params so the saved layout can resume this pane (dockview merges; undefined deletes)
    const { busy: _b, ...rest } = st;
    api.updateParameters({ ...rest, fork: false, quote: undefined });
    if (st.title && st.title !== params.title) api.setTitle(st.title);
    localStorage.setItem("x-term.layout", JSON.stringify(containerApi.toJSON())); // param changes do not fire onDidLayoutChange
  };
  const onDone = (text: string) => {
    const a = agents.get(api.id); if (a) agents.set(api.id, { ...a, last: text, turns: a.turns + 1 });
    if (msgsRef.current.some((m) => m.role === "tool" && ["Edit", "Write", "MultiEdit"].includes(m.name ?? ""))) invoke<string>("git_diff", { cwd: params.cwd ?? "", path: null }).then((d) => setStat(diffStat(d))).catch(() => {});
    if (api.isActive && document.hasFocus()) return;
    setUnread(true);
    if (cfg.notify === "all") notify(params.title ?? api.title ?? "x-term", text.slice(0, 120));
  };
  return (
    <div className={`pane-wrap ${unread ? "unread" : ""}`} onContextMenu={onCtx} onKeyDownCapture={onKeyCapture}>
      {find !== null && <input ref={findRef} className="findbar" placeholder="find (Enter next, Shift+Enter prev, Esc)" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={onFindKey} autoFocus />}
      {toast && <div className="toast">{toast}</div>}
      {stat && !changes && (stat.add || stat.del) ? <button className="diffstat" title="changes (git diff)" onClick={openChanges}><span className="add">+{stat.add}</span> <span className="del">−{stat.del}</span></button> : null}
      <Chat id={api.id} cwd={params.cwd} resume={params.resume} fork={params.fork} quote={params.quote} prompt={params.prompt} model={params.model} effort={params.effort} title={params.title} spawned={!!params.spawnedBy} onState={onState} onDone={onDone} onLive={onLive} onTerminal={onTerminal} onEnd={onEnd} onMsgs={(m) => { msgsRef.current = m; }} onPerm={onPerm} />
      {changes && (
        <div className="changes">
          <div className="changes-files">
            <div className="changes-hdr" title={changes.root}>changes · {changes.root.replace(/^.*\//, "")} <span><button title="ask Claude to review the diff" onClick={reviewCode}>review</button> <button onClick={() => setChanges(null)}>✕</button></span></div>
            <div className={`changes-file ${changes.sel === null ? "sel" : ""}`} onClick={() => loadDiff(null)}>all ({changes.files.length})</div>
            {changes.files.map(([st, f]) => (
              <div key={f} className={`changes-file ${changes.sel === f ? "sel" : ""} ${st.startsWith("✎") ? "touched" : ""}`} onClick={() => loadDiff(f)} title={f}>
                <span className="st">{st}</span> {f}
                <button title="open in editor" onClick={(e) => { e.stopPropagation(); invoke("open_in_editor", { path: `${changes.root}/${f}`, line: null }).catch(warn); }}>↗</button>
              </div>
            ))}
          </div>
          <div className="changes-diff">{changes.diff ? diffLines(changes.diff).map((r, i) => (
            <pre key={i} className={r.cls} title={r.file && r.cls !== "file" ? "click: quote into the composer" : undefined} onClick={r.file && r.cls !== "file" ? () => quoteLine(r.file!, r.line, r.t) : undefined}>
              {r.file && r.cls !== "file" && r.cls !== "hunk" && <span className="ln">{r.line ?? ""}</span>}{r.t}
            </pre>
          )) : <span className="dim">no changes vs HEAD</span>}</div>
        </div>
      )}
      {menu && <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[...(sel() ? [{ label: "Copy", key: "y", run: () => navigator.clipboard.writeText(sel()) }, { label: "Add to context", key: "x", run: () => pushContext(api.id, { text: sel(), label: "selection" }) }] : []), { label: "Find", key: "f", run: openFind }, { label: "Changes (git diff)", key: "d", run: openChanges }, { label: "Export markdown", key: "e", run: exportMd }, { label: "Terminal mode", key: "t", run: onSwitch }, { label: "Close", key: "c", run: () => api.close() }]} />}
    </div>
  );
}

async function notify(title: string, body: string) {
  let ok = await isPermissionGranted();
  if (!ok) ok = (await requestPermission()) === "granted";
  if (ok) sendNotification({ title, body });
}

type ChatProps = {
  id: string; cwd?: string; resume?: string; fork?: boolean; quote?: string; compact?: boolean; prompt?: string; title?: string; spawned?: boolean;
  model?: string; effort?: string; // initial model / effort for this pane (spawn_agents picks them from the agent's weight); /model in the pane still overrides it
  onState?: (s: { cwd?: string; resume?: string; title?: string; busy?: boolean; prompt?: string }) => void; // session id / cwd / title / turn state changed
  onDone?: (lastText: string) => void; // a turn finished
  onLive?: (p: { activity?: string; err?: boolean }) => void; // live status line / error flag for the pane header strip
  onMsgs?: (msgs: Msg[]) => void; // message list changed (threads report up so the parent can merge them)
  onTerminal?: (cmd: string) => void; // run a shell command in the pane's terminal (fallback for interactive-only slash commands)
  onEnd?: () => void; // Ctrl+C while idle: end this session
  onPerm?: (p: Perm | null) => void; // a can_use_tool prompt appeared / was answered
};

/** One claude process + its message list. `compact` = embedded thread: no cwd bar, no statusline, no nested threads. */
function Chat({ id, cwd: cwdProp, resume: resumeProp, fork, quote, compact, prompt, title, spawned, model: modelProp, effort: effortProp, onState, onDone, onLive, onMsgs, onTerminal, onEnd, onPerm }: ChatProps) {
  const promptRef = useRef(prompt); // spawned agent: first message, sent once the process is up
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState(localStorage.getItem(DRAFT(id)) ?? "");
  const [quotes, setQuotes] = useState<string[]>(quote ? [quote] : []); // "ask about this" text: shown above the composer, prepended on send, never editable by accident
  useEffect(() => { // draft + auto-grow (capped by CSS max-height)
    if (!compact) { if (input) localStorage.setItem(DRAFT(id), input); else localStorage.removeItem(DRAFT(id)); }
    const ta = taRef.current; if (ta) { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 2}px`; }
  }, [input]);
  const [images, setImages] = useState<Img[]>([]);
  const [pastes, setPastesState] = useState<Paste[]>([]);
  const pastesRef = useRef(pastes); // synchronous mirror: several context items can arrive in one tick and each needs its own chip number
  const setPastes = (v: Paste[]) => { pastesRef.current = v; setPastesState(v); };
  const [inspect, setInspect] = useState<Paste | null>(null); // chip clicked: show exactly what the model will get
  const addPaste = (p: Paste) => setPastes([...pastesRef.current, p]); // everything pasted / dropped / added is a chip above the composer, never text in it
  /** Files by path (OS drop, file:// paste): images become thumbnails, the rest `@path` chips (the CLI reads them). */
  const addPaths = (paths: string[]) => {
    for (const p of paths) {
      if (IMAGE_EXT.test(p)) invoke<Img>("read_image", { path: p }).then((im) => setImages((x) => [...x, im])).catch(warn);
      else addPaste({ text: `@${p}`, label: `📄 ${p.replace(/^.*\//, "")}` });
    }
  };
  const [busy, setBusy] = useState(false);
  const live = useRef({ busy, onEnd }); // for the pane-level Ctrl+C listener (bound once)
  live.current = { busy, onEnd };
  useEffect(() => { // App dispatches x-term-ctrlc on the active .pane-root: like the CLI, interrupt a running turn, else end the session
    if (compact) return;
    const el = rootRef.current?.closest(".pane-root"); if (!el) return;
    const h = () => { if (live.current.busy) { control({ subtype: "interrupt" }); setQueue([]); } else live.current.onEnd?.(); };
    const send = (e: Event) => postRef.current((e as CustomEvent<string>).detail, []);
    const ctx = () => { takeContext(id).forEach((c) => ctxRef.current(c)); taRef.current?.focus(); };
    el.addEventListener("x-term-ctrlc", h); el.addEventListener("x-term-send", send); el.addEventListener("x-term-context", ctx);
    ctx(); // queued before this chat existed (shell menu on a terminal-only pane)
    return () => { el.removeEventListener("x-term-ctrlc", h); el.removeEventListener("x-term-send", send); el.removeEventListener("x-term-context", ctx); };
  }, []);
  const ctxRef = useRef((_c: { text: string; label: string; ask?: boolean }) => {});
  ctxRef.current = (c) => { // ask: quoted into the composer like a thread; else a chip, fenced so the model sees where it came from
    if (c.ask) setQuotes((q) => [...q, c.text]);
    else addPaste({ text: `${c.label}:\n\`\`\`\n${c.text}\n\`\`\``, label: `${c.label}, ${c.text.split("\n").length} lines` });
  };
  const [queue, setQueue] = useState<{ text: string; images: Img[] }[]>([]); // prompts typed while a turn runs; sent one per result
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const [picks, setPicks] = useState<Record<string, string[]>>({}); // AskUserQuestion answers in progress
  const threadMsgs = useRef<Record<string, Msg[]>>({});
  const threadBusy = useRef<Record<string, boolean>>({}); // hidden threads stay mounted only while a turn runs
  const [tasks, setTasks] = useState<Record<string, Task>>({}); // TodoWrite / TaskCreate / TaskUpdate checklist
  const [planNote, setPlanNote] = useState(""); // ExitPlanMode "keep planning" feedback
  const addSub = (parent: string, step: SubStep) =>
    setMsgs((m) => m.map((x) => (x.role === "tool" && x.id === parent ? { ...x, sub: [...(x.sub ?? []), step] } : x)));
  const [activity, setActivity] = useState(""); // CLI-style status line: what is running right now
  useEffect(() => { onLive?.({ activity }); }, [activity]); // mirror into the pane header strip (spawned agents)
  const [tick, setTick] = useState(0); // 1s re-render while busy for the elapsed counter
  const [layout, setLayout] = useState(0); // list resized: re-place quote boxes / thread windows
  const turn = useRef({ start: 0, tools: 0, done: "" });
  const [cwd, setCwd] = useState(cwdProp ?? "");
  const [gen, setGen] = useState(0); // bump to restart the claude process
  const [statusHtml, setStatusHtml] = useState("");
  const [ask, setAsk] = useState<{ x: number; y: number; text: string; ax: number; ay: number } | null>(null);
  const [slash, setSlash] = useState<string[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [files, setFiles] = useState<string[]>([]); // @path completion
  const histPos = useRef(-1); // -1 = editing new input; otherwise index from the end of history
  const rootRef = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null); // /resume picker
  const [perm, setPerm] = useState<Perm | null>(null); // pending can_use_tool prompt
  useEffect(() => { onPerm?.(perm); }, [perm]);
  const [mode, setMode] = useState(spawned ? "bypassPermissions" : (localStorage.getItem(MODE_KEY) ?? cfg.permissionMode)); // spawned agents run autonomously: no human at the pane to answer prompts, so never block on can_use_tool
  const [model, setModel] = useState(modelProp || localStorage.getItem("x-term.model") || cfg.model);
  const [effort, setEffort] = useState(effortProp || localStorage.getItem("x-term.effort") || cfg.effort);
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const runCmd = useRef(""); // Ctrl+Shift+R: project .x-term.json override; falls back to cfg.runCommand at press time
  const [threads, setThreads] = useState<Thread[]>(() => (compact ? [] : loadThreads(resumeProp)));
  const threadKey = useRef(resumeProp); // main session the current threads belong to
  useEffect(() => {
    const k = threadKey.current;
    if (compact || !k) return;
    if (threads.length) { localStorage.setItem(threadsKey(k), JSON.stringify(threads)); touchThreadIndex(k); } else localStorage.removeItem(threadsKey(k));
  }, [threads]);
  const switchThreads = (sid?: string) => { if (sid !== threadKey.current) { threadKey.current = sid; setThreads(loadThreads(sid)); } };
  const [scrollTop, setScrollTop] = useState(0); // re-render threads on scroll
  const [front, setFront] = useState(""); // last clicked thread window: drawn above the others
  const quoteRanges = useRef<Range[]>([]); // painted quote ranges, removed from the registry before repainting
  // Transparent hit boxes over each quote's line boxes (in .msgs content coords): pointer cursor, no text selection, click toggles the window
  type Box = { l: number; t: number; w: number; h: number };
  const [quoteBoxes, setQuoteBoxes] = useState<{ id: string; cls: string; boxes: Box[]; dot: { l: number; t: number } }[]>([]);
  const threadCls = (t: Thread) => (t.mark ? "mark" : t.open ? "open" : "");
  useEffect(() => { // paint quotes; re-run whenever the list content may have changed (debounced: streaming appends below the quotes, so per-frame walks are wasted)
    const t = setTimeout(() => {
    const list = listRef.current;
    quoteRanges.current.forEach(unpaint);
    quoteRanges.current = [];
    const lr = list?.getBoundingClientRect();
    const hits: typeof quoteBoxes = [];
    if (list && lr) for (const t of threads) {
      const r = findQuote(list, t.quote);
      if (!r) continue;
      (t.mark ? HL.mark : t.open ? HL.open : HL.closed).add(r);
      quoteRanges.current.push(r);
      const box = (b: DOMRect): Box => ({ l: b.left - lr.left + list.scrollLeft, t: b.top - lr.top + list.scrollTop, w: b.width, h: b.height });
      const bb = box(r.getBoundingClientRect());
      hits.push({ id: t.id, cls: threadCls(t), boxes: [...r.getClientRects()].map(box), dot: { l: bb.l + bb.w, t: bb.t } });
    }
    setQuoteBoxes(hits);
    }, 100);
    return () => clearTimeout(t);
  }, [threads, msgs, layout]);
  useEffect(() => () => quoteRanges.current.forEach(unpaint), []);
  const [atBottom, setAtBottom] = useState(true); // auto-scroll only while the user is at the bottom
  const lastText = useRef("");
  const lastCmd = useRef(""); // last slash command sent; re-run in the terminal if the CLI says it is interactive-only
  const sessionId = useRef<string | undefined>(resumeProp);
  const info = useRef<{ model: string; cwd: string; commands: string[]; rate?: any; usage?: any; cost: number; ctx: number }>({ model: "", cwd: "", commands: [], cost: 0, ctx: DEFAULT_CTX });
  const streaming = useRef("");
  const pendingText = useRef("");
  const raf = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const started = msgs.length > 0;

  const setAssistant = (text: string) =>
    setMsgs((m) => {
      const last = m[m.length - 1];
      return last?.role === "assistant" ? [...m.slice(0, -1), { ...last, text }] : [...m, { role: "assistant", text, ts: Date.now() }];
    });

  /** Feeds the user's own Claude Code statusLine script (~/.claude/settings.json) the same JSON the CLI would. */
  const refreshStatus = async () => {
    if (compact) return;
    const i = info.current;
    const u = i.usage ?? {};
    const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const w = i.rate?.unifiedWindows ?? {};
    const payload = {
      hook_event_name: "Status",
      session_id: sessionId.current,
      cwd: i.cwd,
      model: { id: i.model, display_name: modelLabel(i.model) },
      workspace: { current_dir: i.cwd, project_dir: i.cwd },
      cost: { total_cost_usd: i.cost },
      context_window: { context_window_size: i.ctx, used_percentage: i.usage ? (used / i.ctx) * 100 : null },
      effort: { level: effortRef.current },
      rate_limits: {
        five_hour: w.five_hour && { used_percentage: w.five_hour.utilization * 100, resets_at: w.five_hour.resetsAt },
        seven_day: w.seven_day && { used_percentage: w.seven_day.utilization * 100, resets_at: w.seven_day.resetsAt },
      },
    };
    const pct = i.usage ? Math.round((used / i.ctx) * 100) : 0;
    setCtxPct(pct);
    const out = await invoke<string>("run_statusline", { json: JSON.stringify(payload) }).catch((e) => { warn(e); return ""; });
    // no statusLine script configured: built-in line
    setStatusHtml(out ? ansiToHtml(out) : `${modelLabel(i.model || model)} · ${effortRef.current} · ctx ${pct}% · $${i.cost.toFixed(3)}`);
  };
  const [ctxPct, setCtxPct] = useState(0);
  useEffect(() => {
    if (!cwd) invoke<string>("initial_cwd").then(setCwd);
  }, []);
  useEffect(() => { // shell moved (cd + Ctrl+A): restart the idle claude process there; after the first message cwd is fixed
    if (cwdProp && cwdProp !== cwd && !started) { setCwd(cwdProp); setGen((g) => g + 1); }
  }, [cwdProp]);

  useEffect(() => {
    if (resumeProp && !fork && cwd) invoke<Hist[]>("load_transcript", { cwd, id: resumeProp }).then((hist) => { if (hist.length) setMsgs(toMsgs(hist)); });
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const h = (e: Event) => { addPaths((e as CustomEvent<string[]>).detail); taRef.current?.focus(); };
    el.addEventListener("x-term-drop", h);
    return () => el.removeEventListener("x-term-drop", h);
  }, []);

  useEffect(() => {
    if (!cwd) return;
    invoke<string[]>("list_skills", { cwd }).then((sk) => {
      const builtins: string[] = lsGet(BUILTINS, "[]");
      info.current.commands = [...new Set([...sk, ...builtins])].sort();
    });
  }, [cwd]);

  useEffect(() => {
    let alive = true;
    const off = onEvent<{ id: string; line: string }>("session-event", id, (payload) => {
      if (!alive) return;
      let ev: any;
      try { ev = JSON.parse(payload.line); } catch { return; }
      switch (ev.type) {
        case "system":
          if (ev.subtype === "hook_started") setActivity(`hook ${ev.hook_name}`);
          if (ev.subtype === "hook_response" && ev.outcome && ev.outcome !== "success") setMsgs((m) => [...m, { role: "err", text: `hook ${ev.hook_name}: ${ev.outcome}${ev.stderr ? `\n${ev.stderr}` : ""}` }]);
          if (ev.subtype === "compact_boundary") { // /compact or auto-compact: older context is gone; usage resets at the next assistant message
            const pre = ev.compact_metadata?.pre_tokens;
            setMsgs((m) => [...m, { role: "note", text: `— context compacted (${ev.compact_metadata?.trigger ?? "manual"}${pre ? `, was ${fmtTok(pre)} tokens` : ""}) —` }]);
            info.current.usage = undefined;
            refreshStatus();
          }
          if (ev.subtype === "init") {
            sessionId.current = ev.session_id;
            switchThreads(ev.session_id);
            onState?.({ cwd: ev.cwd, resume: ev.session_id });
            info.current = { ...info.current, model: ev.model, cwd: ev.cwd, commands: [...new Set([...info.current.commands, ...(ev.slash_commands ?? [])])].sort() };
            localStorage.setItem(BUILTINS, JSON.stringify(ev.slash_commands ?? []));
            if (fork) localStorage.setItem(FORKS, JSON.stringify([...new Set([...lsGet(FORKS, "[]"), ev.session_id])].slice(-300)));
            refreshStatus();
          }
          break;
        case "conversation_reset": // `/clear`: CLI starts a fresh session in the same process
          setMsgs([]);
          setTasks({});
          switchThreads(undefined); // new conversation, new thread set (the next init names it)
          info.current.cost = 0;
          info.current.usage = undefined;
          break;
        case "rate_limit_event":
          info.current.rate = ev.rate_limit_info;
          break;
        case "control_request":
          if (ev.request?.subtype === "can_use_tool") setPerm({ request_id: ev.request_id, ...ev.request });
          break;
        case "control_response":
          if (ev.response?.subtype === "error") setMsgs((m) => [...m, { role: "err", text: ev.response.error }]);
          break;
        case "stream_event": {
          if (ev.parent_tool_use_id) break; // sub-agent stream: its full messages are attached to the Agent card instead
          const d = ev.event;
          if (d.type === "content_block_start" && d.content_block?.type === "thinking") {
            setActivity("Thinking");
            setMsgs((m) => [...m, { role: "thinking", text: "" }]);
          } else if (d.type === "content_block_delta" && d.delta?.type === "thinking_delta") {
            // newer models hide the text (only estimated_tokens + a signature arrive); keep the count so the row still says something
            setMsgs((m) => { const last = m[m.length - 1]; return last?.role === "thinking" ? [...m.slice(0, -1), { role: "thinking", text: last.text + (d.delta.thinking ?? ""), tokens: d.delta.estimated_tokens ?? last.tokens }] : m; });
          } else if (d.type === "content_block_start" && d.content_block?.type === "tool_use") {
            streaming.current = "";
            const b = d.content_block;
            turn.current.tools++;
            setActivity(`${b.name}`);
            setMsgs((m) => [...m, { role: "tool", id: b.id, name: b.name, input: b.input, text: b.name }]);
          } else if (d.type === "content_block_delta" && d.delta?.type === "text_delta") {
            streaming.current += d.delta.text;
            lastText.current = streaming.current;
            // batch deltas per frame: one re-render per frame instead of per token
            pendingText.current = streaming.current;
            if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; setActivity("Writing"); setAssistant(pendingText.current); });
          } else if (d.type === "content_block_stop") {
            streaming.current = "";
          }
          break;
        }
        case "assistant":
          if (ev.parent_tool_use_id) {
            for (const b of ev.message?.content ?? []) {
              if (b.type === "tool_use") addSub(ev.parent_tool_use_id, { name: b.name, text: toolSummary(b.input) });
              else if (b.type === "text" && b.text) addSub(ev.parent_tool_use_id, { text: b.text });
            }
            break;
          }
          if (ev.message?.usage) info.current.usage = ev.message.usage;
          for (const b of ev.message?.content ?? []) {
            if (b.type === "thinking" && b.thinking) // when deltas were empty (hidden), the full block may still carry text
              setMsgs((m) => { const i = m.map((x) => x.role).lastIndexOf("thinking"); return i >= 0 && !(m[i] as any).text ? m.map((x, j) => (j === i ? { role: "thinking", text: b.thinking } : x)) : m; });
            if (b.type === "tool_use" && b.name === "TodoWrite" && Array.isArray(b.input?.todos))
              setTasks(Object.fromEntries(b.input.todos.map((t: any, i: number) => [String(i), { subject: t.content, status: t.status }])));
            if (b.type === "tool_use" && b.name === "TaskUpdate" && b.input?.taskId)
              setTasks((t) => (t[b.input.taskId] ? { ...t, [b.input.taskId]: { ...t[b.input.taskId], status: b.input.status ?? t[b.input.taskId].status } } : t));
            if (b.type === "tool_use") setActivity(`${b.name} ${toolSummary(b.input)}`.slice(0, 120));
            if (b.type === "tool_use")
              setMsgs((m) => m.some((x) => x.role === "tool" && x.id === b.id)
                ? m.map((x) => (x.role === "tool" && x.id === b.id ? { ...x, input: b.input } : x))
                : [...m, { role: "tool", id: b.id, name: b.name, input: b.input, text: b.name }]);
            // slash commands (e.g. /context) come back as a full text block without deltas
            if (b.type === "text" && ev.message?.model === "<synthetic>" && /isn't available in this environment/.test(b.text) && lastCmd.current && onTerminal) {
              const cmd = lastCmd.current;
              lastCmd.current = "";
              setAssistant(`\`${cmd}\` is interactive-only. Running it in the terminal (Ctrl+A to come back).`);
              onTerminal(`(cd '${cwd.replace(/'/g, "'\\''")}' && claude '${cmd.replace(/'/g, "'\\''")}')`);
              continue;
            }
            if (b.type === "text" && ev.message?.model === "<synthetic>") { // typed /model, /effort: mirror the CLI's confirmation into the dropdowns + status bar
              const sm = /Set model to `([^`]+)`/.exec(b.text);
              const wanted = sm?.[1].toLowerCase().replace(" (1m context)", " [1m]").replace(/ \(default\)$/, "").trim();
              const mid = wanted && MODELS.find((m) => modelLabel(m) === wanted);
              // a spawned agent runs on the model its weight picked; don't let its /model leak into the default for new panes
              if (mid) { setModel(mid); if (!modelProp) localStorage.setItem("x-term.model", mid); info.current.model = mid; refreshStatus(); }
              const se = /Set effort level to (\w+)/.exec(b.text);
              if (se && EFFORTS.includes(se[1])) { setEffort(se[1]); if (!effortProp) localStorage.setItem("x-term.effort", se[1]); }
            }
            if (b.type === "text" && !streaming.current) { lastText.current = b.text; setAssistant(b.text); }
          }
          break;
        case "user":
          for (const b of ev.message?.content ?? []) {
            if (b.type === "tool_result") {
              const t = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("\n");
              if (ev.parent_tool_use_id) { addSub(ev.parent_tool_use_id, { text: `↳ ${t}` }); continue; }
              setActivity("Thinking");
              const created = /^Task #(\d+) created successfully: (.*)$/m.exec(t);
              if (created) setTasks((tk) => ({ ...tk, [created[1]]: { subject: created[2], status: "pending" } }));
              setMsgs((m) => m.map((x) => (x.role === "tool" && x.id === b.tool_use_id ? { ...x, result: t, error: !!b.is_error } : x)));
            }
          }
          break;
        case "result":
          sessionId.current = ev.session_id;
          {
            const u = ev.usage ?? {};
            const tin = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            turn.current.done = `${ev.is_error ? "✗" : "✓"} ${fmtSec(ev.duration_ms ?? Date.now() - turn.current.start)} · ${turn.current.tools} tools · ↑${fmtTok(tin)} ↓${fmtTok(u.output_tokens ?? 0)} · $${(ev.total_cost_usd ?? 0).toFixed(3)}`;
          }
          setActivity("");
          onLive?.({ err: !!ev.is_error });
          // budget / rate limit / API errors arrive only here (result text + errors[]), not as an assistant message
          if (ev.is_error) { const why = [ev.result, ...(ev.errors ?? [])].filter((x) => typeof x === "string" && x && x !== lastText.current).join("\n"); if (why) setMsgs((m) => [...m, { role: "err", text: why }]); }
          onState?.({ resume: ev.session_id, busy: false });
          onDone?.(lastText.current);
          info.current.cost += ev.total_cost_usd ?? 0;
          // result.usage sums every API call of the turn, so context comes from the last assistant message (set above);
          // modelUsage carries the real context window size
          const mu = Object.values(ev.modelUsage ?? {}) as any[];
          const cw = Math.max(0, ...mu.map((m) => m?.contextWindow ?? 0));
          if (cw) info.current.ctx = cw;
          refreshStatus();
          const next = queueRef.current[0];
          if (next) { setQueue((q) => q.slice(1)); postRef.current(next.text, next.images, true); } else setBusy(false);
          break;
        case "stderr":
          setMsgs((m) => [...m, { role: "err", text: ev.text }]);
          break;
        case "exit":
          setBusy(false);
          setActivity("");
          setStatusHtml("exited");
          break;
      }
    });
    (async () => {
      // <repo>/.x-term.json: model / effort / permissionMode for this project win over the last-used values (not over an
      // explicit pane override such as a spawned agent's weight); applied before the first message only
      let m = model, ef = effort, pm = mode;
      if (cwd && !started) {
        const pc = await projectConfig(cwd);
        if (!modelProp && pc.model && pc.model !== cfg.model) { m = pc.model; setModel(m); }
        if (!effortProp && pc.effort && pc.effort !== cfg.effort) { ef = pc.effort; setEffort(ef); }
        if (!spawned && pc.permissionMode && pc.permissionMode !== cfg.permissionMode) { pm = pc.permissionMode; setMode(pm); } // project intent wins over the last-used mode (not persisted); spawned agents stay autonomous
        runCmd.current = pc.runCommand && pc.runCommand !== cfg.runCommand ? pc.runCommand : "";
      }
      if (!alive) return;
      await invoke("start_session", { id, cwd, resume: sessionId.current ?? null, fork: !!fork, permissionMode: pm, model: m, effort: ef, name: title ?? null });
      const p = promptRef.current; if (p && alive) { promptRef.current = undefined; onState?.({ prompt: undefined }); postRef.current(p, []); }
    })().catch((e) => alive && setMsgs((m) => [...m, { role: "err", text: String(e) }]));
    return () => { alive = false; off(); if (raf.current) cancelAnimationFrame(raf.current); invoke("stop_session", { id }).catch(warn); };
  }, [id, gen]);

  useEffect(() => { if (atBottom) listRef.current?.scrollTo(0, listRef.current.scrollHeight); }, [msgs]);
  useEffect(() => { // list shown/hidden (Ctrl+A / Ctrl+C) or resized: re-place thread windows after layout
    if (compact || !listRef.current) return;
    const ro = new ResizeObserver(() => setLayout((x) => x + 1));
    ro.observe(listRef.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!compact) return;
    const focus = () => { const ta = taRef.current; if (ta && document.activeElement !== ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } };
    focus();
    const t = setTimeout(focus, 50); // dockview re-focuses the panel on pointerup; win the race
    return () => clearTimeout(t);
  }, []);

  const control = (request: object) =>
    invoke("write_line", { id, line: JSON.stringify({ type: "control_request", request_id: crypto.randomUUID(), request }) }).catch(warn);
  const answerPerm = (behavior: "allow" | "deny", always = false, updatedInput = perm?.input) => {
    if (!perm) return;
    const response = behavior === "allow"
      ? { behavior, updatedInput, ...(always && perm.permission_suggestions ? { updatedPermissions: perm.permission_suggestions } : {}) }
      : { behavior, message: "User denied this action" };
    invoke("write_line", { id, line: JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: perm.request_id, response } }) }).catch(warn);
    setPerm(null);
    setPicks({});
  };
  // AskUserQuestion: the CLI's picker is a can_use_tool request; answers go back as updatedInput.answers {question: label(s)}
  const questions: any[] = perm?.tool_name === "AskUserQuestion" ? perm.input?.questions ?? [] : [];
  const pick = (q: any, label: string) =>
    setPicks((p) => ({ ...p, [q.question]: q.multiSelect ? (p[q.question]?.includes(label) ? p[q.question].filter((l) => l !== label) : [...(p[q.question] ?? []), label]) : [label] }));
  // ExitPlanMode: accept = allow (optionally switching the session to acceptEdits); keep planning = deny with feedback
  const plan: string | null = perm?.tool_name === "ExitPlanMode" ? perm.input?.plan ?? "" : null;
  const acceptPlan = (autoEdit: boolean) => {
    if (!perm) return;
    const response = { behavior: "allow", updatedInput: perm.input, ...(autoEdit ? { updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] } : {}) };
    invoke("write_line", { id, line: JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: perm.request_id, response } }) }).catch(warn);
    setPerm(null);
    if (autoEdit) { setMode("acceptEdits"); localStorage.setItem(MODE_KEY, "acceptEdits"); }
  };
  const keepPlanning = () => {
    if (!perm) return;
    const response = { behavior: "deny", message: planNote.trim() ? `Keep planning. Feedback: ${planNote.trim()}` : "Keep planning; the user wants to refine the plan." };
    invoke("write_line", { id, line: JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: perm.request_id, response } }) }).catch(warn);
    setPerm(null); setPlanNote("");
  };
  const submitAnswers = () => {
    if (!questions.every((q) => picks[q.question]?.length)) return;
    answerPerm("allow", false, { ...perm!.input, answers: Object.fromEntries(questions.map((q) => [q.question, picks[q.question].join(", ")])) });
  };
  const cycleMode = () => applyMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  const applyMode = (m: string) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
    if (started) control({ subtype: "set_permission_mode", mode: m }); // live switch; before the first message the restart below picks it up
    else setGen((g) => g + 1);
  };



  const resume = async (sess: SessionInfo) => {
    setSessions(null);
    sessionId.current = sess.id;
    switchThreads(sess.id);
    const dir = sess.cwd || cwd;
    if (dir !== cwd) { setCwd(dir); onState?.({ cwd: dir }); }
    const hist = await invoke<Hist[]>("load_transcript", { cwd: dir, id: sess.id });
    setMsgs(toMsgs(hist));
    setTasks({});
    onState?.({ resume: sess.id, title: sess.summary.slice(0, 30) });
    info.current.cost = 0;
    setGen((g) => g + 1); // restart process with --resume
  };

  const send = async () => {
    const typed = input.trim();
    if (!typed && !images.length && !quotes.length) return;
    const text = typed.startsWith("/") || typed.startsWith("!") ? typed
      : [...quotes.map((q) => `> ${q.replace(/\n/g, "\n> ")}`), typed, ...pastes.map((p) => p.text)].filter(Boolean).join("\n\n");
    if (text.startsWith("!") && onTerminal) { setInput(""); onTerminal(text.slice(1)); return; } // like the CLI: `!cmd` runs in the shell
    const title = /^\/title\s+(.+)/.exec(text);
    if (title) { setInput(""); setSlash([]); onState?.({ title: title[1].trim().slice(0, 40) }); return; } // pane title (export name, notifications)
    if (/^\/config\b/.test(text)) { setInput(""); setSlash([]); invoke<string>("open_config").catch((e) => setMsgs((m) => [...m, { role: "err", text: String(e) }])); return; }
    const wt = /^\/worktree\s+(\S+)/.exec(text);
    if (wt) { // git worktree next to the repo, opened as a new chat pane (parallel agents, separate branches)
      setInput(""); setSlash([]);
      invoke<string>("git_worktree", { cwd, name: wt[1] })
        .then((path) => window.dispatchEvent(new CustomEvent("x-term-open", { detail: { cwd: path, title: `wt:${wt[1]}` } })))
        .catch((e) => setMsgs((m) => [...m, { role: "err", text: String(e) }]));
      return;
    }
    const search = /^\/search\s+(.+)/.exec(text);
    if (search) { // every transcript on this machine; picking one moves this pane to that project
      setInput(""); setSlash([]); setSlashIdx(0);
      const hits = await invoke<{ id: string; cwd: string; mtime: number; snippet: string }[]>("search_sessions", { query: search[1] });
      setSessions(hits.map((h) => ({ id: h.id, mtime: h.mtime, cwd: h.cwd, summary: `${h.cwd.replace(/^.*\//, "")} · ${h.snippet}` })));
      return;
    }
    if (/^\/resume\b/.test(text)) { // CLI's /resume is an interactive picker; unavailable in -p mode
      setInput(""); setSlash([]);
      const forks = new Set<string>(lsGet(FORKS, "[]"));
      setSlashIdx(0);
      setSessions((await invoke<SessionInfo[]>("list_sessions", { cwd })).filter((s) => !forks.has(s.id)));
      return;
    }
    if (text) { const h: string[] = lsGet(HIST_KEY, "[]").filter((x: string) => x !== text); h.push(text); localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(-100))); }
    histPos.current = -1;
    setInput(""); setImages([]); setPastes([]); setQuotes([]); setSlash([]);
    post(text, images);
  };
  /** Send now, or park in the queue while a turn is running (drained one per `result`). */
  const post = (text: string, images: Img[], force = false) => {
    if (busy && !force) { setQueue((q) => [...q, { text, images }]); return; }
    lastCmd.current = text.startsWith("/") ? text : "";
    if (!started && text) onState?.({ title: text.replace(/^>.*\n?/gm, "").trim().slice(0, 30) || text.slice(0, 30) });
    setMsgs((m) => [...m, { role: "user", text, images, ts: Date.now() }]);
    setBusy(true); setAtBottom(true);
    onState?.({ busy: true });
    onLive?.({ err: false }); // new turn clears any prior error state
    turn.current = { start: Date.now(), tools: 0, done: "" };
    setActivity("Thinking");
    invoke("send_message", { id, text, images }).catch((e) => setMsgs((m) => [...m, { role: "err", text: String(e) }]));
  };
  const postRef = useRef(post); // the event listener closure is bound once per process; always call the latest post
  postRef.current = post;
  const acts = useRef<RowActs>({ edit: () => {}, retry: () => {} }); // stable ref so memoized rows never re-render for a new closure
  acts.current = { edit: (m) => { setInput(m.text); taRef.current?.focus(); }, retry: (m) => post(m.text, m.images ?? []) };
  const [lightbox, setLightbox] = useState("");
  /** Alt+PgUp / Alt+PgDn: previous / next user message. */
  const jump = (dir: 1 | -1) => {
    const list = listRef.current; if (!list) return;
    const rows = [...list.querySelectorAll<HTMLElement>(".msg.user")];
    const y = list.scrollTop;
    const target = dir > 0 ? rows.find((r) => r.offsetTop > y + 2) : [...rows].reverse().find((r) => r.offsetTop < y - 2);
    if (target) { setAtBottom(false); list.scrollTo({ top: target.offsetTop - 8 }); }
  };
  useEffect(() => { onMsgs?.(msgs); }, [msgs]);
  /** Fold a thread's exchange into this conversation as one user message, then drop the thread. */
  const mergeThread = (t: Thread) => {
    const body = (threadMsgs.current[t.id] ?? []).filter((m) => m.role === "user" || m.role === "assistant").map((m) => `**${m.role === "user" ? "User" : "Assistant"}:** ${m.text}`).join("\n\n");
    if (!body) return;
    post(`[Merged side thread about: "${t.quote.slice(0, 200)}"]\n\n${body}\n\n(Treat the above as part of our conversation. Reply with a one-line acknowledgement.)`, []);
    patchThread(t.id, null);
    delete threadMsgs.current[t.id];
  };

  const onInput = (v: string) => {
    setInput(v);
    const m = /^\/(\S*)$/.exec(v);
    const arg = /^\/(model|effort) (\S*)$/.exec(v); // argument completion: full model ids / effort levels
    setSlash(m ? [...new Set([...LOCAL, ...info.current.commands])].filter((c) => c.startsWith(m[1])).slice(0, 12)
      : arg ? (arg[1] === "model" ? MODELS : EFFORTS).filter((x) => x.startsWith(arg[2])).map((x) => `${arg[1]} ${x}`) : []);
    const f = /(?:^|\s)@([^\s@]*)$/.exec(v);
    clearTimeout(fileTimer.current);
    if (f) fileTimer.current = setTimeout(() => invoke<string[]>("list_files", { cwd, query: f[1] }).then(setFiles), 150); else setFiles([]);
    setSlashIdx(0);
  };
  const fileTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pickFile = (path: string) => { setInput((v) => v.replace(/@[^\s@]*$/, `@${path} `)); setFiles([]); taRef.current?.focus(); };
  const ctrlEnter = cfg.sendKey === "ctrl+enter";
  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME (Korean, Japanese …) still composing: Enter/arrows belong to the composer, not to us
    // permission card + empty composer: answer from the keyboard like the CLI. The send chord (Enter, or Ctrl+Enter with
    // sendKey ctrl+enter) = allow / submit / accept; the "strong" chord (Ctrl+Enter, or Ctrl+Shift+Enter in ctrl+enter mode)
    // = always allow / accept + auto-edit; Esc = deny / cancel / keep planning
    if (perm && !input.trim()) {
      const enter = e.key === "Enter" && !e.altKey && !e.metaKey;
      const chord = enter && (ctrlEnter ? e.ctrlKey && !e.shiftKey : !e.ctrlKey && !e.shiftKey);
      const strong = enter && (ctrlEnter ? e.ctrlKey && e.shiftKey : e.ctrlKey && !e.shiftKey);
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (questions.length) {
        if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) { const q = questions.find((q) => !picks[q.question]?.length) ?? questions[questions.length - 1]; const o = q?.options?.[Number(e.key) - 1]; if (o) { stop(); pick(q, o.label); } return; }
        if (chord) { stop(); submitAnswers(); return; }
        if (e.key === "Escape") { stop(); answerPerm("deny"); return; }
      } else if (plan !== null) {
        if (chord || strong) { stop(); acceptPlan(strong); return; }
        if (e.key === "Escape") { stop(); keepPlanning(); return; }
      } else {
        if (chord || strong) { stop(); answerPerm("allow", strong && !!perm.permission_suggestions?.length); return; }
        if (e.key === "Escape") { stop(); answerPerm("deny"); return; }
      }
    }
    if (sessions) { // /resume picker
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % Math.max(1, sessions.length)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + sessions.length) % Math.max(1, sessions.length)); return; }
      if (e.key === "Enter") { e.preventDefault(); if (sessions[slashIdx]) resume(sessions[slashIdx]); return; }
      if (e.key === "Escape") { e.preventDefault(); setSessions(null); return; }
    }
    const list = slash.length ? slash : files;
    if (list.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % list.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + list.length) % list.length); return; }
      if (e.key === "Tab" || (e.key === "Enter" && (files.length || input !== `/${slash[slashIdx]}`))) {
        e.preventDefault();
        if (slash.length) { setInput(`/${slash[slashIdx]} `); setSlash([]); } else pickFile(files[slashIdx]);
        return;
      }
      if (e.key === "Escape") { setSlash([]); setFiles([]); return; }
    }
    // prompt history: ↑/↓ when the caret is on the first/last line
    const ta = e.currentTarget as HTMLTextAreaElement;
    if (e.key === "ArrowUp" && !ta.value.slice(0, ta.selectionStart).includes("\n")) {
      const h: string[] = lsGet(HIST_KEY, "[]");
      if (histPos.current + 1 < h.length) { e.preventDefault(); histPos.current++; setInput(h[h.length - 1 - histPos.current]); }
      return;
    }
    if (e.key === "ArrowDown" && !ta.value.slice(ta.selectionStart).includes("\n") && histPos.current >= 0) {
      const h: string[] = lsGet(HIST_KEY, "[]");
      e.preventDefault(); histPos.current--;
      setInput(histPos.current < 0 ? "" : h[h.length - 1 - histPos.current]);
      return;
    }
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
    if (is(e, "retry") && !compact) { e.preventDefault(); const last = [...msgs].reverse().find((m) => m.role === "user"); if (last && last.role === "user") post(last.text, last.images ?? []); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && (ctrlEnter ? e.ctrlKey : !e.ctrlKey)) { e.preventDefault(); send(); }
    if (e.key === "Escape" && busy) { control({ subtype: "interrupt" }); setQueue([]); }
  };

  const addImageFiles = (files: Iterable<File>) => {
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      const r = new FileReader();
      r.onload = () => setImages((im) => [...im, { media_type: f.type, data: (r.result as string).split(",")[1] }]);
      r.readAsDataURL(f);
    }
  };
  /** File paths in pasted text: file manager copies arrive as file:// URIs, GNOME's "x-special/nautilus-clipboard\ncopy\nfile://…", or plain absolute paths. */
  const pathsIn = (raw: string) => {
    const lines = raw.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !/^(x-special\/nautilus-clipboard|copy|cut)$/.test(l));
    if (!lines.length || lines.length > 50 || !lines.every((l) => /^(file:\/\/|\/|~\/)\S/.test(l))) return null;
    return lines.map((l) => (l.startsWith("file://") ? decodeURIComponent(l.replace(/^file:\/\/(localhost)?/, "")) : l));
  };
  /** Pasted text: file paths -> chips, long text -> chip, else typed into the composer at the caret. */
  const pasteText = (t: string, insert: boolean) => {
    const paths = pathsIn(t);
    if (paths) return addPaths(paths);
    const lines = t.split("\n").length;
    if (lines > PASTE_LINES || t.length > PASTE_CHARS) return addPaste({ text: t, label: `${lines} lines` });
    if (insert) { const ta = taRef.current; if (ta) { const a = ta.selectionStart, b = ta.selectionEnd; setInput((v) => v.slice(0, a) + t + v.slice(b)); } }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const dt = e.clipboardData;
    if (dt.files.length) { e.preventDefault(); addImageFiles(dt.files); return; }
    const t = dt.getData("text/uri-list") || dt.getData("text/plain");
    // Files copied in a file manager: WebKit hides the pasteboard from DataTransfer (no text, no files) but the default action would still
    // insert the path. navigator.clipboard sees the real text, so route through that instead.
    if (!t) { e.preventDefault(); navigator.clipboard.readText().then((c) => pasteText(c, true)).catch(warn); return; }
    if (pathsIn(t) || t.split("\n").length > PASTE_LINES || t.length > PASTE_CHARS) { e.preventDefault(); pasteText(t, false); }
  };

  // Selection inside .msgs -> "Ask about this" button; remembers where (in .msgs content coords) to anchor the thread
  const onMouseUp = () => {
    if (compact) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    const list = listRef.current;
    if (!text || !sel || !list || !list.contains(sel.anchorNode)) { setAsk(null); return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    setAsk({ x: Math.min(r.left, window.innerWidth - 180), y: r.bottom + 4, text, ax: r.right - lr.left + list.scrollLeft, ay: r.bottom - lr.top + list.scrollTop + 4 });
  };
  useEffect(() => { // buttons follow the selection: any click elsewhere or key (menu, Ctrl+Shift+D overlay, scroll away) dismisses them
    if (!ask) return;
    const down = (e: Event) => { if (!(e.target as HTMLElement).closest?.(".ask-btns")) setAsk(null); };
    const key = () => setAsk(null);
    document.addEventListener("mousedown", down, true); document.addEventListener("keydown", key, true); document.addEventListener("scroll", key, true);
    return () => { document.removeEventListener("mousedown", down, true); document.removeEventListener("keydown", key, true); document.removeEventListener("scroll", key, true); };
  }, [!!ask]);
  const openThread = (mark = false) => { // mark: just highlight the selection (bookmark), no session
    if (!ask) return;
    const id = crypto.randomUUID();
    setThreads((t) => [...t, { id, ax: ask.ax, ay: ask.ay, quote: ask.text, resume: sessionId.current, open: !mark, mark }].sort((a, b) => a.ay - b.ay));
    if (!mark) setFront(id);
    setAsk(null);
    window.getSelection()?.removeAllRanges();
  };
  const patchThread = (tid: string, p: Partial<Thread> | null) =>
    setThreads((t) => (p ? t.map((x) => (x.id === tid ? { ...x, ...p } : x)) : t.filter((x) => x.id !== tid)));
  /** Scroll the list to a thread's quote (its painted position when found, else the anchor it was created at). */
  const goToQuote = (t: Thread) => {
    const l = listRef.current; if (!l) return;
    const y = quoteBoxes.find((q) => q.id === t.id)?.dot.t ?? t.ay;
    setAtBottom(false);
    l.scrollTo({ top: Math.max(0, y - l.clientHeight / 3), behavior: "smooth" });
  };
  const toggleThread = (tid: string) => { // a mark has nothing to open: clicking it removes it
    if (threads.find((x) => x.id === tid)?.mark) return patchThread(tid, null);
    setFront(tid); setThreads((t) => t.map((x) => (x.id === tid ? { ...x, open: !x.open } : x)));
  };

  // Open threads get a window at their anchor, following the scroll and clamped into the viewport. Closed ones are only their
  // highlighted quote (click to reopen); a closed thread mid-turn stays mounted but hidden so its process finishes.
  const lr = listRef.current?.getBoundingClientRect();
  const visible = !!lr && lr.width > 0; // hidden slot (terminal mode) -> no thread windows
  const top = lr?.top ?? 0, left = lr?.left ?? 0;
  const placed = threads.filter((t) => !t.mark && (t.open || threadBusy.current[t.id])).map((t) => ({
    t, x: Math.min(left + t.ax, window.innerWidth - THREAD_W - 8), y: Math.max(top + 8, Math.min(top + t.ay - scrollTop, window.innerHeight - THREAD_H - 8)),
  }));

  return (
    <div className={`pane ${compact ? "compact" : ""}`} ref={rootRef} onKeyDownCapture={(e) => {
      if (compact || (e.target as HTMLElement).closest(".thread")) return; // thread portals bubble through React into this handler
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (is(e, "focusComposer")) { stop(); taRef.current?.focus(); }
      else if (is(e, "prevMsg") || is(e, "nextMsg")) { stop(); jump(is(e, "nextMsg") ? 1 : -1); }
      else if (is(e, "scrollUp") || is(e, "scrollDown")) { const l = listRef.current; if (l) { stop(); setAtBottom(false); l.scrollBy({ top: (is(e, "scrollDown") ? 1 : -1) * l.clientHeight * 0.9 }); } }
      else if (is(e, "thread") && ask) { stop(); openThread(); } // thread from selection
      else if (is(e, "mark") && ask) { stop(); openThread(true); } // bookmark the selection
      else if (is(e, "clear")) { stop(); post("/clear", []); }
      else if (is(e, "run")) { // a project's .x-term.json is untrusted content: show its command and ask before it touches the shell
        stop(); const cmd = runCmd.current || cfg.runCommand;
        if (!cmd || !onTerminal) setMsgs((m) => [...m, { role: "note", text: "no runCommand in config.json / .x-term.json" }]);
        else if (!runCmd.current) onTerminal(cmd);
        else confirm(`Run this project's command in the shell?\n\n${cmd}`).then((ok) => { if (ok) onTerminal(cmd); });
      }
    }}>
      <div className="msgs" ref={listRef} onMouseUp={onMouseUp} onScroll={onScroll} onClick={(e) => { const t = e.target as HTMLElement; if (t.tagName === "IMG") setLightbox((t as HTMLImageElement).src); }}>
        {threads.length > 0 && listRef.current && (
          <div className="ruler">
            {threads.map((t) => {
              const l = listRef.current!, y = quoteBoxes.find((q) => q.id === t.id)?.dot.t ?? t.ay;
              return <span key={t.id} className={`ruler-mark ${threadCls(t)}`} style={{ top: (y / l.scrollHeight) * l.clientHeight }} title={t.quote} onMouseDown={(e) => e.preventDefault()} onClick={() => goToQuote(t)} />;
            })}
          </div>
        )}
        {msgs.map((m, i) => m.role === "tool" ? <ToolCard key={m.id} m={m} /> : <Row key={i} m={m} last={i === msgs.length - 1} stream={busy && i === msgs.length - 1} acts={acts} />)}
        {queue.map((q, i) => (
          <div key={`q${i}`} className="msg user queued" title="Sent when the current turn finishes">
            <span className="dim">queued · {SPIN[tick % SPIN.length]}</span> {q.text.slice(0, 300)}
          </div>
        ))}
        {!atBottom && <button className="to-bottom" onClick={() => { setAtBottom(true); listRef.current?.scrollTo(0, listRef.current.scrollHeight); }}>↓</button>}
        {lightbox && createPortal(<div className="help" onClick={() => setLightbox("")}><img className="lightbox" src={lightbox} /></div>, document.body)}
        {quoteBoxes.map(({ id, cls, boxes, dot }) => (
          <Fragment key={id}>
            {boxes.map((b, i) => <span key={i} className="quote-hit" style={{ left: b.l, top: b.t, width: b.w, height: b.h }} onMouseDown={(e) => e.preventDefault()} onClick={() => toggleThread(id)} title={cls === "mark" ? "remove mark" : cls === "open" ? "hide thread" : "show thread"} />)}
            <span className={`quote-dot ${cls}`} style={{ left: dot.l, top: dot.t }} onMouseDown={(e) => e.preventDefault()} onClick={() => toggleThread(id)} />
          </Fragment>
        ))}
        {ask && <span className="ask-btns" style={{ left: ask.x, top: ask.y }}>
          <button className="ask-btn" onMouseDown={(e) => { e.preventDefault(); openThread(); }}>Ask about this ↗</button>
          <button className="ask-btn mark" onMouseDown={(e) => { e.preventDefault(); openThread(true); }} title={`bookmark this text (${label("mark")})`}>Mark</button>
          <button className="ask-btn ctx" onMouseDown={(e) => { e.preventDefault(); pushContext(id, { text: ask.text, label: "selection" }); setAsk(null); window.getSelection()?.removeAllRanges(); }} title="add to the composer as a context chip">+ Context</button>
        </span>}
      </div>
      {visible && placed.map(({ t, x, y }) => createPortal(
        <div key={t.id} className="thread" style={{ left: x, top: y, display: t.open ? undefined : "none", zIndex: t.id === front ? 1001 : 1000 }} onMouseDownCapture={() => setFront(t.id)}>
          <div className="thread-hdr" onClick={() => toggleThread(t.id)} title={t.quote}>
            <span className="thread-quote" title="scroll to this quote" onClick={(e) => { e.stopPropagation(); goToQuote(t); }}>{t.quote.slice(0, 40)}{t.quote.length > 40 ? "…" : ""}</span>
            <span>
              <button onClick={(e) => { e.stopPropagation(); toggleThread(t.id); }}>hide</button>
              <button onClick={(e) => { e.stopPropagation(); mergeThread(t); }} title="Inject this thread's conversation into the main session" disabled={!threadMsgs.current[t.id]?.some((m) => m.role === "assistant")}>merge</button>
              <button onClick={(e) => { e.stopPropagation(); patchThread(t.id, null); }}>close</button>
            </span>
          </div>
          <div className="thread-body">
            <Chat id={t.id} cwd={cwd} resume={t.sid ?? t.resume} fork={!t.sid} quote={t.sid ? undefined : t.quote} compact
              onState={(st) => { if (st.resume) patchThread(t.id, { sid: st.resume }); if (st.busy !== undefined) threadBusy.current[t.id] = st.busy; }}
              onMsgs={(m) => { threadMsgs.current[t.id] = m; setTick((x) => x + 1); }} />
          </div>
        </div>,
        document.body,
      ))}
      <div className="composer">
        {quotes.map((q, i) => (
          <div key={i} className="quote-chip" title="click to see all" onClick={() => setInspect({ text: q, label: "quote" })}>
            <span className="q">{q}</span><span className="x" title="remove" onClick={(e) => { e.stopPropagation(); setQuotes((x) => x.filter((_, j) => j !== i)); }}>✕</span>
          </div>
        ))}
        {images.length > 0 && <div className="thumbs">{images.map((im, i) => <img key={i} src={`data:${im.media_type};base64,${im.data}`} title="click to remove" onClick={() => setImages((x) => x.filter((_, j) => j !== i))} />)}</div>}
        {pastes.length > 0 && <div className="thumbs">{pastes.map((p, i) => (
          <span key={i} className="chip" title="click to inspect" onClick={() => setInspect(p)}>
            {p.label} <span className="x" title="remove" onClick={(e) => { e.stopPropagation(); setPastes(pastesRef.current.filter((_, j) => j !== i)); }}>✕</span>
          </span>
        ))}</div>}
        {inspect && createPortal(<div className="help" onClick={() => setInspect(null)}><pre className="inspect">{inspect.text}</pre></div>, document.body)}
        {perm && plan !== null && (
          <div className="perm plan">
            <div className="perm-title">Plan ready · approve?</div>
            <div className="plan-body"><Markdown {...plugins}>{plan}</Markdown></div>
            <input value={planNote} placeholder="feedback for keep planning (optional)" onChange={(e) => setPlanNote(e.target.value)} />
            <div>
              <button onClick={() => acceptPlan(true)}>Accept, auto-accept edits</button>
              <button onClick={() => acceptPlan(false)}>Accept</button>
              <button onClick={keepPlanning}>Keep planning</button>
            </div>
          </div>
        )}
        {perm && questions.length > 0 && (
          <div className="perm ask">
            {questions.map((q) => (
              <div key={q.question} className="ask-q">
                <div className="perm-title">{q.header ? `${q.header} · ` : ""}{q.question}{q.multiSelect ? " (multi)" : ""}</div>
                {q.options?.map((o: any) => (
                  <button key={o.label} className={picks[q.question]?.includes(o.label) ? "sel" : ""} title={o.description} onClick={() => pick(q, o.label)}>{o.label}</button>
                ))}
                <input placeholder="other…" onKeyDown={(e) => { if (e.key === "Enter" && e.currentTarget.value.trim()) { pick(q, e.currentTarget.value.trim()); e.currentTarget.value = ""; } }} />
              </div>
            ))}
            <div>
              <button onClick={submitAnswers} disabled={!questions.every((q) => picks[q.question]?.length)}>Submit</button>
              <button onClick={() => answerPerm("deny")}>Cancel</button>
            </div>
          </div>
        )}
        {perm && !questions.length && plan === null && (
          <div className={`perm ${perm.tool_name === "mcp__x-term__spawn_agents" ? "spawn" : ""}`}>
            {perm.tool_name === "mcp__x-term__spawn_agents" ? (
              <>
                <div className="perm-title">Split into {perm.input?.agents?.length ?? 0} parallel agents?</div>
                {(perm.input?.agents ?? []).map((ag: any, i: number) => (
                  <details key={i} className="spawn-agent"><summary><b>{ag.title}</b> {ag.worktree ? <span className="dim">· worktree {ag.worktree}</span> : <span className="dim">· same directory</span>}</summary><pre>{ag.prompt}</pre></details>
                ))}
              </>
            ) : (
              <>
                <div className="perm-title">{perm.tool_name} {perm.description ? `· ${perm.description}` : ""}</div>
                <pre>{typeof perm.input?.command === "string" ? perm.input.command : perm.input?.file_path ?? JSON.stringify(perm.input, null, 1).slice(0, 600)}</pre>
              </>
            )}
            <div>
              <button onClick={() => answerPerm("allow")}>Allow</button>
              {perm.permission_suggestions?.length ? <button onClick={() => answerPerm("allow", true)}>Always allow</button> : null}
              <button onClick={() => answerPerm("deny")}>Deny</button>
            </div>
          </div>
        )}
        {sessions && (
          <ul className="slash">
            {sessions.length === 0 && <li>no sessions for {cwd}</li>}
            {sessions.map((s, i) => <li key={s.id} className={i === slashIdx ? "sel" : ""} onMouseDown={() => resume(s)}>{new Date(s.mtime * 1000).toLocaleString()} · {s.id.slice(0, 8)} · {s.summary}</li>)}
            <li onMouseDown={() => setSessions(null)}>✕ cancel</li>
          </ul>
        )}
        {slash.length > 0 && (
          <ul className="slash">
            {slash.map((c, i) => <li key={c} className={i === slashIdx ? "sel" : ""} onMouseDown={() => { setInput(`/${c} `); setSlash([]); }}>/{c}</li>)}
          </ul>
        )}
        {files.length > 0 && !slash.length && (
          <ul className="slash">
            {files.map((f, i) => <li key={f} className={i === slashIdx ? "sel" : ""} onMouseDown={() => pickFile(f)}>@{f}</li>)}
          </ul>
        )}
        {Object.keys(tasks).length > 0 && (
          <ul className="tasks">
            {Object.entries(tasks).map(([k, t]) => <li key={k} className={t.status}>{TASK_ICON[t.status] ?? "☐"} {t.subject}</li>)}
          </ul>
        )}
        {(busy || turn.current.done) && <div className="activity">
          {busy ? <><span className="spin">{SPIN[tick % SPIN.length]}</span> {activity || "Thinking"}… <span className="dim">{fmtSec(Date.now() - turn.current.start)} · {turn.current.tools} tools · Esc to interrupt</span></> : <span className="dim">{turn.current.done}</span>}
        </div>}
        <textarea
          ref={taRef}
          value={input}
          placeholder={perm ? `${ctrlEnter ? "Ctrl+Enter" : "Enter"} allow · ${ctrlEnter ? "Ctrl+Shift+Enter" : "Ctrl+Enter"} always · Esc deny (or type to queue a message)` : busy ? "working… (Esc to interrupt)" : compact ? `Follow-up (${ctrlEnter ? "Ctrl+Enter" : "Enter"} to send)` : `Message (${ctrlEnter ? "Ctrl+Enter send, Enter" : "Enter send, Shift+Enter"} newline, / commands, paste images)`}
          onChange={(e) => onInput(e.target.value)}
          onPaste={onPaste}
          onKeyDown={onKey}
        />
        {!compact && (
          <>
            <div className="status">
              <span dangerouslySetInnerHTML={{ __html: statusHtml || "starting…" }} />
              {ctxPct >= 80 && <span className={`ctx-tag ${ctxPct >= 90 ? "crit" : ""}`} title="context used · /compact to shrink">ctx {ctxPct}%</span>}
              <span className="mode-tag" title="permission mode · Shift+Tab cycles">{mode}</span>
            </div>
          </>
        )}
        {compact && busy && <div className="status">⏳</div>}
      </div>
    </div>
  );
}
