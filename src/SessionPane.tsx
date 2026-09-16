import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IDockviewPanelProps } from "dockview-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { ToolCard, ToolMsg, SubStep } from "./ToolCard";
import { ansiToHtml } from "./ansi";
import { Menu } from "./Menu";

export type SessionParams = { title?: string; resume?: string; fork?: boolean; quote?: string; cwd?: string };
type Img = { media_type: string; data: string };
type Msg = { role: "user" | "assistant" | "err" | "thinking"; text: string; images?: Img[] } | ToolMsg;
type Task = { subject: string; status: string };
const TASK_ICON: Record<string, string> = { pending: "☐", in_progress: "◐", completed: "☑" };
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
type SessionInfo = { id: string; mtime: number; summary: string };
type Perm = { request_id: string; tool_name: string; input: any; description?: string; permission_suggestions?: any[] };
const MODES = ["auto", "acceptEdits", "manual", "plan", "bypassPermissions", "dontAsk"];
const MODE_KEY = "x-term.permissionMode";
// "" = CLI default. Before the first message these restart the process with --model/--effort; after, they are sent as /model and /effort.
// Full ids: the CLI rejects short forms like `opus-4-8[1m]`; `[1m]` = 1M context variant.
const MODELS = ["claude-fable-5-1", "claude-fable-5-1[1m]", "claude-opus-5", "claude-opus-5[1m]", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-5[1m]", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** "claude-opus-4-8[1m]" -> "opus 4.8 [1m]", "claude-haiku-4-5-20251001" -> "haiku 4.5" */
const modelLabel = (id: string) => id.replace(/^claude-/, "").replace(/-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?$/, (_, a, b, m) => ` ${a}${b ? "." + b : ""}${m ? " " + m : ""}`);
const HIST_KEY = "x-term.history"; // last 100 prompts, shared by all panes
// Follow-up thread window. ax/ay = anchor in .msgs content coords; rendered fixed (portal), follows scroll, stacks at the top when its text scrolls out
/** `resume` = main session it forked from, `sid` = the thread's own (forked) session once known -> restored with --resume, no re-fork. */
type Thread = { id: string; ax: number; ay: number; quote: string; resume?: string; sid?: string; open: boolean };
// Threads belong to a conversation: stored per main session id, swapped in/out together with it.
const threadsKey = (sid: string) => `x-term.threads.${sid}`;
const loadThreads = (sid?: string): Thread[] => (sid ? JSON.parse(localStorage.getItem(threadsKey(sid)) ?? "[]") : []);

function Pre(props: React.ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [ok, setOk] = useState(false);
  return (
    <div className="codewrap">
      <button className="copy" onClick={() => { navigator.clipboard.writeText(ref.current?.innerText ?? ""); setOk(true); setTimeout(() => setOk(false), 1200); }}>{ok ? "copied" : "copy"}</button>
      <pre ref={ref} {...props} />
    </div>
  );
}
/** Inline code: click to copy. Block code keeps its own copy button via Pre. */
function Code(props: React.ComponentProps<"code">) {
  const [ok, setOk] = useState(false);
  const text = String(props.children ?? "");
  if (text.includes("\n")) return <code {...props} />;
  return <code {...props} className={`${props.className ?? ""} inline ${ok ? "copied" : ""}`} title="click to copy"
    onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 800); }} />;
}
const plugins = { remarkPlugins: [remarkGfm, remarkMath], rehypePlugins: [rehypeKatex], components: { pre: Pre, code: Code } };
// Long multi-line pastes become a chip (like the CLI's "[Pasted text #N]") and are expanded back into the prompt on send
const SPIN = ["✻", "✽", "✶", "✳", "✢", "·"];
const fmtSec = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;
const toolSummary = (input: any) => (typeof input?.command === "string" ? input.command : input?.file_path ?? input?.pattern ?? input?.description ?? "");
const PASTE_LINES = 6;
const PASTE_CHARS = 600;
const FORKS = "x-term.forks"; // session ids spawned by thread windows (--fork-session); hidden from the /resume picker
const BUILTINS = "x-term.builtinCommands"; // CLI reports slash_commands only after the first turn; cache across sessions
// Context window comes from result.modelUsage[*].contextWindow after the first turn; 200k until then.
const DEFAULT_CTX = 200_000;
const toMsgs = (hist: { role: string; text: string }[]): Msg[] =>
  hist.map((h) => (h.role === "tool" ? { role: "tool", id: crypto.randomUUID(), name: h.text.replace(/^▶ /, ""), input: {}, result: "", text: h.text } : { role: h.role as "user" | "assistant", text: h.text }));
const THREAD_W = 420;
const THREAD_H = 380; // header + body; window is clamped so it never runs past the viewport bottom
const THREAD_HDR = 30; // stacked (pinned) threads offset by this much

export function SessionPane({ api, containerApi, params, onSwitch, onTerminal }: IDockviewPanelProps<SessionParams> & { onSwitch: () => void; onTerminal: (cmd: string) => void }) {
  const [unread, setUnread] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // right-click anywhere in the chat -> pane menu (inputs and thread windows keep the native menu)
  const onCtx = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("textarea, input, select, .thread, .slash, .perm")) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };
  const sel = () => window.getSelection()?.toString() ?? "";
  // Ctrl+C with nothing selected -> back to the shell (with a selection it stays the copy shortcut)
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLTextAreaElement;
    const has = (t.selectionStart != null && t.selectionStart !== t.selectionEnd) || !!sel();
    if (e.ctrlKey && !e.shiftKey && e.key === "c" && !has) { e.preventDefault(); onSwitch(); }
  };
  useEffect(() => {
    const d = api.onDidActiveChange(({ isActive }) => { if (isActive) setUnread(false); });
    return () => d.dispose();
  }, [api]);
  useEffect(() => { api.setTitle((unread ? "● " : "") + (params.title ?? api.title ?? "").replace(/^● /, "")); }, [unread, params.title]);
  const onState: ChatProps["onState"] = (st) => {
    // keep session id / cwd / title in panel params so the saved layout can resume this pane
    api.updateParameters({ ...params, ...st, fork: false, quote: undefined });
    if (st.title && st.title !== params.title) api.setTitle(st.title);
    localStorage.setItem("x-term.layout", JSON.stringify(containerApi.toJSON())); // param changes do not fire onDidLayoutChange
  };
  const onDone = (text: string) => {
    if (api.isActive && document.hasFocus()) return;
    setUnread(true);
    notify(params.title ?? api.title ?? "x-term", text.slice(0, 120));
  };
  return (
    <div className="pane-wrap" onContextMenu={onCtx} onKeyDown={onKey}>
      <Chat id={api.id} cwd={params.cwd} resume={params.resume} fork={params.fork} quote={params.quote} onState={onState} onDone={onDone} onTerminal={onTerminal} />
      {menu && <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[...(sel() ? [{ label: "Copy", key: "y", run: () => navigator.clipboard.writeText(sel()) }] : []), { label: "Terminal mode", key: "t", run: onSwitch }, { label: "Close", key: "c", run: () => api.close() }]} />}
    </div>
  );
}

async function notify(title: string, body: string) {
  let ok = await isPermissionGranted();
  if (!ok) ok = (await requestPermission()) === "granted";
  if (ok) sendNotification({ title, body });
}

type ChatProps = {
  id: string; cwd?: string; resume?: string; fork?: boolean; quote?: string; compact?: boolean;
  onState?: (s: { cwd?: string; resume?: string; title?: string }) => void; // session id / cwd / title changed
  onDone?: (lastText: string) => void; // a turn finished
  onMsgs?: (msgs: Msg[]) => void; // message list changed (threads report up so the parent can merge them)
  onTerminal?: (cmd: string) => void; // run a shell command in the pane's terminal (fallback for interactive-only slash commands)
};

/** One claude process + its message list. `compact` = embedded thread: no cwd bar, no statusline, no nested threads. */
function Chat({ id, cwd: cwdProp, resume: resumeProp, fork, quote, compact, onState, onDone, onMsgs, onTerminal }: ChatProps) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState(quote ? `> ${quote.replace(/\n/g, "\n> ")}\n\n` : "");
  const [images, setImages] = useState<Img[]>([]);
  const [pastes, setPastes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<{ text: string; images: Img[] }[]>([]); // prompts typed while a turn runs; sent one per result
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const [picks, setPicks] = useState<Record<string, string[]>>({}); // AskUserQuestion answers in progress
  const threadMsgs = useRef<Record<string, Msg[]>>({});
  const [tasks, setTasks] = useState<Record<string, Task>>({}); // TodoWrite / TaskCreate / TaskUpdate checklist
  const [planNote, setPlanNote] = useState(""); // ExitPlanMode "keep planning" feedback
  const addSub = (parent: string, step: SubStep) =>
    setMsgs((m) => m.map((x) => (x.role === "tool" && x.id === parent ? { ...x, sub: [...(x.sub ?? []), step] } : x)));
  const [activity, setActivity] = useState(""); // CLI-style status line: what is running right now
  const [tick, setTick] = useState(0); // 1s re-render while busy for the elapsed counter
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
  const [mode, setMode] = useState(localStorage.getItem(MODE_KEY) ?? "acceptEdits");
  const [model, setModel] = useState(localStorage.getItem("x-term.model") || "claude-opus-5[1m]");
  const [effort, setEffort] = useState(localStorage.getItem("x-term.effort") || "high");
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const [threads, setThreads] = useState<Thread[]>(() => (compact ? [] : loadThreads(resumeProp)));
  const threadKey = useRef(resumeProp); // main session the current threads belong to
  useEffect(() => {
    const k = threadKey.current;
    if (compact || !k) return;
    if (threads.length) localStorage.setItem(threadsKey(k), JSON.stringify(threads)); else localStorage.removeItem(threadsKey(k));
  }, [threads]);
  const switchThreads = (sid?: string) => { if (sid !== threadKey.current) { threadKey.current = sid; setThreads(loadThreads(sid)); } };
  const [scrollTop, setScrollTop] = useState(0); // re-render threads on scroll
  const [atBottom, setAtBottom] = useState(true); // auto-scroll only while the user is at the bottom
  const lastText = useRef("");
  const lastCmd = useRef(""); // last slash command sent; re-run in the terminal if the CLI says it is interactive-only
  const sessionId = useRef<string | undefined>(resumeProp);
  const info = useRef<{ model: string; cwd: string; commands: string[]; rate?: any; usage?: any; cost: number; ctx: number }>({ model: "", cwd: "", commands: [], cost: 0, ctx: DEFAULT_CTX });
  const streaming = useRef("");
  const listRef = useRef<HTMLDivElement>(null);
  const started = msgs.length > 0;

  const setAssistant = (text: string) =>
    setMsgs((m) => {
      const last = m[m.length - 1];
      return last?.role === "assistant" ? [...m.slice(0, -1), { role: "assistant", text }] : [...m, { role: "assistant", text }];
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
    setStatusHtml(ansiToHtml(await invoke<string>("run_statusline", { json: JSON.stringify(payload) })));
  };
  useEffect(() => {
    if (!cwd) invoke<string>("initial_cwd").then(setCwd);
  }, []);

  useEffect(() => {
    if (resumeProp && !fork && cwd) invoke<{ role: string; text: string }[]>("load_transcript", { cwd, id: resumeProp }).then((hist) => { if (hist.length) setMsgs(toMsgs(hist)); });
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const h = (e: Event) => { const paths = (e as CustomEvent<string[]>).detail; setInput((v) => v + paths.map((p) => `@${p} `).join("")); taRef.current?.focus(); };
    el.addEventListener("x-term-drop", h);
    return () => el.removeEventListener("x-term-drop", h);
  }, []);

  useEffect(() => {
    if (!cwd) return;
    invoke<string[]>("list_skills", { cwd }).then((sk) => {
      const builtins: string[] = JSON.parse(localStorage.getItem(BUILTINS) ?? "[]");
      info.current.commands = [...new Set([...sk, ...builtins])].sort();
    });
  }, [cwd]);

  useEffect(() => {
    let alive = true;
    const unlisten = listen<{ id: string; line: string }>("session-event", ({ payload }) => {
      if (payload.id !== id || !alive) return;
      let ev: any;
      try { ev = JSON.parse(payload.line); } catch { return; }
      switch (ev.type) {
        case "system":
          if (ev.subtype === "init") {
            sessionId.current = ev.session_id;
            switchThreads(ev.session_id);
            onState?.({ cwd: ev.cwd, resume: ev.session_id });
            info.current = { ...info.current, model: ev.model, cwd: ev.cwd, commands: [...new Set([...info.current.commands, ...(ev.slash_commands ?? [])])].sort() };
            localStorage.setItem(BUILTINS, JSON.stringify(ev.slash_commands ?? []));
            if (fork) localStorage.setItem(FORKS, JSON.stringify([...new Set([...JSON.parse(localStorage.getItem(FORKS) ?? "[]"), ev.session_id])]));
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
          } else if (d.type === "content_block_delta" && d.delta?.type === "thinking_delta" && d.delta.thinking) {
            setMsgs((m) => { const last = m[m.length - 1]; return last?.role === "thinking" ? [...m.slice(0, -1), { role: "thinking", text: last.text + d.delta.thinking }] : m; });
          } else if (d.type === "content_block_start" && d.content_block?.type === "tool_use") {
            streaming.current = "";
            const b = d.content_block;
            turn.current.tools++;
            setActivity(`${b.name}`);
            setMsgs((m) => [...m, { role: "tool", id: b.id, name: b.name, input: b.input, text: b.name }]);
          } else if (d.type === "content_block_delta" && d.delta?.type === "text_delta") {
            streaming.current += d.delta.text;
            lastText.current = streaming.current;
            setActivity("Writing");
            setAssistant(streaming.current);
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
              if (mid) { setModel(mid); localStorage.setItem("x-term.model", mid); info.current.model = mid; refreshStatus(); }
              const se = /Set effort level to (\w+)/.exec(b.text);
              if (se && EFFORTS.includes(se[1])) { setEffort(se[1]); localStorage.setItem("x-term.effort", se[1]); }
            }
            if (b.type === "text" && !streaming.current) setAssistant(b.text);
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
          onState?.({ resume: ev.session_id });
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
    invoke("start_session", { id, cwd, resume: sessionId.current ?? null, fork: !!fork, permissionMode: mode, model, effort })
      .catch((e) => alive && setMsgs((m) => [...m, { role: "err", text: String(e) }]));
    return () => { alive = false; unlisten.then((f) => f()); invoke("stop_session", { id }); };
  }, [id, gen]);

  useEffect(() => { if (atBottom) listRef.current?.scrollTo(0, listRef.current.scrollHeight); }, [msgs]);
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
    invoke("write_line", { id, line: JSON.stringify({ type: "control_request", request_id: crypto.randomUUID(), request }) }).catch(() => {});
  const answerPerm = (behavior: "allow" | "deny", always = false, updatedInput = perm?.input) => {
    if (!perm) return;
    const response = behavior === "allow"
      ? { behavior, updatedInput, ...(always && perm.permission_suggestions ? { updatedPermissions: perm.permission_suggestions } : {}) }
      : { behavior, message: "User denied this action" };
    invoke("write_line", { id, line: JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: perm.request_id, response } }) }).catch(() => {});
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
    invoke("write_line", { id, line: JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: perm.request_id, response } }) }).catch(() => {});
    setPerm(null);
    if (autoEdit) { setMode("acceptEdits"); localStorage.setItem(MODE_KEY, "acceptEdits"); }
  };
  const keepPlanning = () => {
    if (!perm) return;
    const response = { behavior: "deny", message: planNote.trim() ? `Keep planning. Feedback: ${planNote.trim()}` : "Keep planning; the user wants to refine the plan." };
    invoke("write_line", { id, line: JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: perm.request_id, response } }) }).catch(() => {});
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
    const hist = await invoke<{ role: string; text: string }[]>("load_transcript", { cwd, id: sess.id });
    setMsgs(toMsgs(hist));
    setTasks({});
    onState?.({ resume: sess.id, title: sess.summary.slice(0, 30) });
    info.current.cost = 0;
    setGen((g) => g + 1); // restart process with --resume
  };

  const send = async () => {
    const text = input.replace(/\[Pasted text #(\d+)[^\]]*\]/g, (m, n) => pastes[Number(n) - 1] ?? m).trim();
    if (!text && !images.length) return;
    if (/^\/resume\b/.test(text)) { // CLI's /resume is an interactive picker; unavailable in -p mode
      setInput(""); setSlash([]);
      const forks = new Set<string>(JSON.parse(localStorage.getItem(FORKS) ?? "[]"));
      setSlashIdx(0);
      setSessions((await invoke<SessionInfo[]>("list_sessions", { cwd })).filter((s) => !forks.has(s.id)));
      return;
    }
    if (text) { const h: string[] = JSON.parse(localStorage.getItem(HIST_KEY) ?? "[]").filter((x: string) => x !== text); h.push(text); localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(-100))); }
    histPos.current = -1;
    setInput(""); setImages([]); setPastes([]); setSlash([]);
    post(text, images);
  };
  /** Send now, or park in the queue while a turn is running (drained one per `result`). */
  const post = (text: string, images: Img[], force = false) => {
    if (busy && !force) { setQueue((q) => [...q, { text, images }]); return; }
    lastCmd.current = text.startsWith("/") ? text : "";
    if (!started && text) onState?.({ title: text.replace(/^>.*\n?/gm, "").trim().slice(0, 30) || text.slice(0, 30) });
    setMsgs((m) => [...m, { role: "user", text, images }]);
    setBusy(true); setAtBottom(true);
    turn.current = { start: Date.now(), tools: 0, done: "" };
    setActivity("Thinking");
    invoke("send_message", { id, text, images }).catch((e) => setMsgs((m) => [...m, { role: "err", text: String(e) }]));
  };
  const postRef = useRef(post); // the event listener closure is bound once per process; always call the latest post
  postRef.current = post;
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
    setSlash(m ? info.current.commands.filter((c) => c.startsWith(m[1])).slice(0, 12) : []);
    const f = /(?:^|\s)@([^\s@]*)$/.exec(v);
    if (f) invoke<string[]>("list_files", { cwd, query: f[1] }).then(setFiles); else setFiles([]);
    setSlashIdx(0);
  };
  const pickFile = (path: string) => { setInput((v) => v.replace(/@[^\s@]*$/, `@${path} `)); setFiles([]); taRef.current?.focus(); };
  const onKey = (e: React.KeyboardEvent) => {
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
      const h: string[] = JSON.parse(localStorage.getItem(HIST_KEY) ?? "[]");
      if (histPos.current + 1 < h.length) { e.preventDefault(); histPos.current++; setInput(h[h.length - 1 - histPos.current]); }
      return;
    }
    if (e.key === "ArrowDown" && !ta.value.slice(ta.selectionStart).includes("\n") && histPos.current >= 0) {
      const h: string[] = JSON.parse(localStorage.getItem(HIST_KEY) ?? "[]");
      e.preventDefault(); histPos.current--;
      setInput(histPos.current < 0 ? "" : h[h.length - 1 - histPos.current]);
      return;
    }
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === "Escape" && busy) { control({ subtype: "interrupt" }); setQueue([]); }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const t = e.clipboardData.getData("text/plain");
    const lines = t.split("\n").length;
    if (!e.clipboardData.files.length && (lines > PASTE_LINES || t.length > PASTE_CHARS)) {
      e.preventDefault();
      const ta = e.currentTarget as HTMLTextAreaElement;
      const chip = `[Pasted text #${pastes.length + 1}: ${lines} lines] `;
      setPastes((p) => [...p, t]);
      setInput(ta.value.slice(0, ta.selectionStart) + chip + ta.value.slice(ta.selectionEnd));
      return;
    }
    for (const f of Array.from(e.clipboardData.files)) {
      if (!f.type.startsWith("image/")) continue;
      e.preventDefault();
      const r = new FileReader();
      r.onload = () => setImages((im) => [...im, { media_type: f.type, data: (r.result as string).split(",")[1] }]);
      r.readAsDataURL(f);
    }
  };

  // Selection inside .msgs -> "Ask about this" button; remembers where (in .msgs content coords) to anchor the thread
  const onMouseUp = (e: React.MouseEvent) => {
    if (compact) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    const list = listRef.current;
    if (!text || !sel || !list || !list.contains(sel.anchorNode)) { setAsk(null); return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    setAsk({ x: e.clientX, y: e.clientY - 30, text, ax: r.right - lr.left + list.scrollLeft, ay: r.bottom - lr.top + list.scrollTop + 4 });
  };
  const openThread = () => {
    if (!ask) return;
    setThreads((t) => [...t, { id: crypto.randomUUID(), ax: ask.ax, ay: ask.ay, quote: ask.text, resume: sessionId.current, open: true }].sort((a, b) => a.ay - b.ay));
    setAsk(null);
    window.getSelection()?.removeAllRanges();
  };
  const patchThread = (tid: string, p: Partial<Thread> | null) =>
    setThreads((t) => (p ? t.map((x) => (x.id === tid ? { ...x, ...p } : x)) : t.filter((x) => x.id !== tid)));

  // Viewport position per thread: follows its anchor while scrolling. Anchor above the list -> pinned at the top, stacked
  // downward; anchor below -> pinned at the bottom, stacked upward (header only). Threads are kept sorted by anchor.
  const lr = listRef.current?.getBoundingClientRect();
  const top = lr?.top ?? 0, left = lr?.left ?? 0, bottom = lr?.bottom ?? window.innerHeight;
  const placed = threads.map((t) => ({ t, x: Math.min(left + t.ax, window.innerWidth - THREAD_W - 8), y: top + t.ay - scrollTop, showBody: t.open }));
  let k = 0;
  for (const p of placed) { const minY = top + 8 + k * THREAD_HDR; if (p.y < minY) { p.y = minY; k++; } }
  k = 0;
  for (const p of [...placed].reverse()) { const maxY = bottom - 8 - (k + 1) * THREAD_HDR; if (p.y > maxY) { p.y = maxY; p.showBody = false; k++; } }
  for (const p of placed) if (p.showBody) p.y = Math.min(p.y, window.innerHeight - THREAD_H - 8);

  return (
    <div className={`pane ${compact ? "compact" : ""}`} ref={rootRef}>
      <div className="msgs" ref={listRef} onMouseUp={onMouseUp} onScroll={onScroll}>
        {msgs.map((m, i) => m.role === "tool" ? <ToolCard key={m.id} m={m} /> : (
          <div key={i} className={`msg ${m.role}`}>
            {m.images?.map((im, j) => <img key={j} src={`data:${im.media_type};base64,${im.data}`} />)}
            {m.role === "err" ? m.text : m.role === "thinking" ? <details><summary>thinking{m.text ? "" : " (hidden)"}</summary>{m.text}</details> : <Markdown {...plugins}>{m.text}</Markdown>}
          </div>
        ))}
        {queue.map((q, i) => (
          <div key={`q${i}`} className="msg user queued" title="Sent when the current turn finishes">
            <span className="dim">queued · {SPIN[tick % SPIN.length]}</span> {q.text.slice(0, 300)}
          </div>
        ))}
        {!atBottom && <button className="to-bottom" onClick={() => { setAtBottom(true); listRef.current?.scrollTo(0, listRef.current.scrollHeight); }}>↓</button>}
        {ask && <button className="ask-btn" style={{ left: ask.x, top: ask.y }} onMouseDown={(e) => { e.preventDefault(); openThread(); }}>Ask about this ↗</button>}
      </div>
      {placed.map(({ t, x, y, showBody }) => createPortal(
        <div key={t.id} className={`thread ${showBody ? "" : "collapsed"}`} style={{ left: x, top: y }}>
          <div className="thread-hdr" onClick={() => patchThread(t.id, { open: !t.open })} title={t.quote}>
            <span>{t.quote.slice(0, 40)}{t.quote.length > 40 ? "…" : ""}</span>
            <span>
              <button onClick={(e) => { e.stopPropagation(); patchThread(t.id, { open: !t.open }); }}>{t.open ? "hide" : "show"}</button>
              <button onClick={(e) => { e.stopPropagation(); mergeThread(t); }} title="Inject this thread's conversation into the main session" disabled={!threadMsgs.current[t.id]?.some((m) => m.role === "assistant")}>merge</button>
              <button onClick={(e) => { e.stopPropagation(); patchThread(t.id, null); }}>close</button>
            </span>
          </div>
          <div className="thread-body" style={{ display: showBody ? undefined : "none" }}><Chat id={t.id} cwd={cwd} resume={t.sid ?? t.resume} fork={!t.sid} quote={t.sid ? undefined : t.quote} compact onState={(st) => st.resume && patchThread(t.id, { sid: st.resume })} onMsgs={(m) => { threadMsgs.current[t.id] = m; setTick((x) => x + 1); }} /></div>
        </div>,
        document.body,
      ))}
      <div className="composer">
        {pastes.length > 0 && <div className="thumbs">{pastes.map((p, i) => <span key={i} className="chip" title={p.slice(0, 500)} onClick={() => { setPastes((x) => x.filter((_, j) => j !== i)); setInput((v) => v.replace(new RegExp(`\\[Pasted text #${i + 1}[^\\]]*\\] ?`), "")); }}>#{i + 1}: {p.split("\n").length} lines ✕</span>)}</div>}
        {images.length > 0 && <div className="thumbs">{images.map((im, i) => <img key={i} src={`data:${im.media_type};base64,${im.data}`} onClick={() => setImages((x) => x.filter((_, j) => j !== i))} />)}</div>}
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
          <div className="perm">
            <div className="perm-title">{perm.tool_name} {perm.description ? `· ${perm.description}` : ""}</div>
            <pre>{typeof perm.input?.command === "string" ? perm.input.command : perm.input?.file_path ?? JSON.stringify(perm.input, null, 1).slice(0, 600)}</pre>
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
        <div className="activity">
          {busy ? <><span className="spin">{SPIN[tick % SPIN.length]}</span> {activity || "Thinking"}… <span className="dim">{fmtSec(Date.now() - turn.current.start)} · {turn.current.tools} tools · Esc to interrupt</span></> : <span className="dim">{turn.current.done}</span>}
        </div>
        <textarea
          ref={taRef}
          value={input}
          placeholder={busy ? "working… (Esc to interrupt)" : compact ? "Follow-up (Enter to send)" : "Message (Enter send, Shift+Enter newline, / commands, paste images)"}
          onChange={(e) => onInput(e.target.value)}
          onPaste={onPaste}
          onKeyDown={onKey}
        />
        {!compact && (
          <>
            <div className="status">
              <span dangerouslySetInnerHTML={{ __html: statusHtml || "starting…" }} />
              <span className="mode-tag" title="permission mode · Shift+Tab cycles">{mode}</span>
            </div>
          </>
        )}
        {compact && busy && <div className="status">⏳</div>}
      </div>
    </div>
  );
}
