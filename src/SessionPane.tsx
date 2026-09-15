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
import { ansiToHtml } from "./ansi";
import { ToolCard, ToolMsg } from "./ToolCard";

export type SessionParams = { title?: string; resume?: string; fork?: boolean; quote?: string; cwd?: string };
type Img = { media_type: string; data: string };
type Msg = { role: "user" | "assistant" | "err"; text: string; images?: Img[] } | ToolMsg;
type SessionInfo = { id: string; mtime: number; summary: string };
type Perm = { request_id: string; tool_name: string; input: any; description?: string; permission_suggestions?: any[] };
const MODES = ["auto", "acceptEdits", "manual", "plan", "bypassPermissions", "dontAsk"];
const MODE_KEY = "x-term.permissionMode";
// Follow-up thread window. ax/ay = anchor in .msgs content coords; rendered fixed (portal), follows scroll, stacks at the top when its text scrolls out
type Thread = { id: string; ax: number; ay: number; quote: string; resume?: string; open: boolean };

const plugins = { remarkPlugins: [remarkGfm, remarkMath], rehypePlugins: [rehypeKatex] };
const BUILTINS = "x-term.builtinCommands"; // CLI reports slash_commands only after the first turn; cache across sessions
// ponytail: context size not reported by CLI; 1M for fable/opus-1m, else 200k. Fix when stream-json exposes it.
const ctxSize = (model: string) => (/fable|\[1m\]/.test(model) ? 1_000_000 : 200_000);
const toMsgs = (hist: { role: string; text: string }[]): Msg[] =>
  hist.map((h) => (h.role === "tool" ? { role: "tool", id: crypto.randomUUID(), name: h.text.replace(/^▶ /, ""), input: {}, result: "", text: h.text } : { role: h.role as "user" | "assistant", text: h.text }));
const THREAD_W = 420;
const THREAD_H = 380; // header + body; window is clamped so it never runs past the viewport bottom
const THREAD_HDR = 30; // stacked (pinned) threads offset by this much

export function SessionPane({ api, containerApi, params }: IDockviewPanelProps<SessionParams>) {
  const [unread, setUnread] = useState(false);
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
  return <Chat id={api.id} cwd={params.cwd} resume={params.resume} fork={params.fork} quote={params.quote} onState={onState} onDone={onDone} />;
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
};

/** One claude process + its message list. `compact` = embedded thread: no cwd bar, no statusline, no nested threads. */
function Chat({ id, cwd: cwdProp, resume: resumeProp, fork, quote, compact, onState, onDone }: ChatProps) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState(quote ? `> ${quote.replace(/\n/g, "\n> ")}\n\n` : "");
  const [images, setImages] = useState<Img[]>([]);
  const [busy, setBusy] = useState(false);
  const [cwd, setCwd] = useState(cwdProp ?? "");
  const [gen, setGen] = useState(0); // bump to restart the claude process
  const [statusHtml, setStatusHtml] = useState("");
  const [ask, setAsk] = useState<{ x: number; y: number; text: string; ax: number; ay: number } | null>(null);
  const [slash, setSlash] = useState<string[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null); // /resume picker
  const [perm, setPerm] = useState<Perm | null>(null); // pending can_use_tool prompt
  const [mode, setMode] = useState(localStorage.getItem(MODE_KEY) ?? "acceptEdits");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [scrollTop, setScrollTop] = useState(0); // re-render threads on scroll
  const [atBottom, setAtBottom] = useState(true); // auto-scroll only while the user is at the bottom
  const lastText = useRef("");
  const sessionId = useRef<string | undefined>(resumeProp);
  const info = useRef<{ model: string; cwd: string; commands: string[]; rate?: any; usage?: any; cost: number }>({ model: "", cwd: "", commands: [], cost: 0 });
  const streaming = useRef("");
  const listRef = useRef<HTMLDivElement>(null);
  const started = msgs.length > 0;

  const setAssistant = (text: string) =>
    setMsgs((m) => {
      const last = m[m.length - 1];
      return last?.role === "assistant" ? [...m.slice(0, -1), { role: "assistant", text }] : [...m, { role: "assistant", text }];
    });

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
      model: { id: i.model, display_name: i.model.replace(/^claude-/, "").replace(/-\d.*$/, "") },
      workspace: { current_dir: i.cwd, project_dir: i.cwd },
      cost: { total_cost_usd: i.cost },
      context_window: { context_window_size: ctxSize(i.model), used_percentage: (used / ctxSize(i.model)) * 100 },
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
            onState?.({ cwd: ev.cwd, resume: ev.session_id });
            info.current = { ...info.current, model: ev.model, cwd: ev.cwd, commands: [...new Set([...info.current.commands, ...(ev.slash_commands ?? [])])].sort() };
            localStorage.setItem(BUILTINS, JSON.stringify(ev.slash_commands ?? []));
            refreshStatus();
          }
          break;
        case "conversation_reset": // `/clear`: CLI starts a fresh session in the same process
          setMsgs([]);
          setThreads([]);
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
          const d = ev.event;
          if (d.type === "content_block_start" && d.content_block?.type === "tool_use") {
            streaming.current = "";
            const b = d.content_block;
            setMsgs((m) => [...m, { role: "tool", id: b.id, name: b.name, input: b.input, text: b.name }]);
          } else if (d.type === "content_block_delta" && d.delta?.type === "text_delta") {
            streaming.current += d.delta.text;
            lastText.current = streaming.current;
            setAssistant(streaming.current);
          } else if (d.type === "content_block_stop") {
            streaming.current = "";
          }
          break;
        }
        case "assistant":
          if (ev.message?.usage) info.current.usage = ev.message.usage;
          for (const b of ev.message?.content ?? []) {
            if (b.type === "tool_use")
              setMsgs((m) => m.some((x) => x.role === "tool" && x.id === b.id)
                ? m.map((x) => (x.role === "tool" && x.id === b.id ? { ...x, input: b.input } : x))
                : [...m, { role: "tool", id: b.id, name: b.name, input: b.input, text: b.name }]);
            // slash commands (e.g. /context) come back as a full text block without deltas
            if (b.type === "text" && !streaming.current) setAssistant(b.text);
          }
          break;
        case "user":
          for (const b of ev.message?.content ?? []) {
            if (b.type === "tool_result") {
              const t = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("\n");
              setMsgs((m) => m.map((x) => (x.role === "tool" && x.id === b.tool_use_id ? { ...x, result: t, error: !!b.is_error } : x)));
            }
          }
          break;
        case "result":
          sessionId.current = ev.session_id;
          onState?.({ resume: ev.session_id });
          onDone?.(lastText.current);
          info.current.cost += ev.total_cost_usd ?? 0;
          if (ev.usage) info.current.usage = ev.usage;
          setBusy(false);
          refreshStatus();
          break;
        case "stderr":
          setMsgs((m) => [...m, { role: "err", text: ev.text }]);
          break;
        case "exit":
          setBusy(false);
          setStatusHtml("exited");
          break;
      }
    });
    invoke("start_session", { id, cwd, resume: sessionId.current ?? null, fork: !!fork, permissionMode: mode })
      .catch((e) => alive && setMsgs((m) => [...m, { role: "err", text: String(e) }]));
    return () => { alive = false; unlisten.then((f) => f()); invoke("stop_session", { id }); };
  }, [id, gen]);

  useEffect(() => { if (atBottom) listRef.current?.scrollTo(0, listRef.current.scrollHeight); }, [msgs]);
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
  const answerPerm = (behavior: "allow" | "deny", always = false) => {
    if (!perm) return;
    const response = behavior === "allow"
      ? { behavior, updatedInput: perm.input, ...(always && perm.permission_suggestions ? { updatedPermissions: perm.permission_suggestions } : {}) }
      : { behavior, message: "User denied this action" };
    invoke("write_line", { id, line: JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: perm.request_id, response } }) }).catch(() => {});
    setPerm(null);
  };
  const applyMode = (m: string) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
    if (started) control({ subtype: "set_permission_mode", mode: m }); // live switch; before the first message the restart below picks it up
    else setGen((g) => g + 1);
  };

  const applyCwd = (dir: string) => {
    if (!dir || dir === cwd) return;
    setCwd(dir);
    if (!started) setGen((g) => g + 1); // restart process in new dir; after first message cwd is fixed
  };

  const resume = async (sess: SessionInfo) => {
    setSessions(null);
    sessionId.current = sess.id;
    const hist = await invoke<{ role: string; text: string }[]>("load_transcript", { cwd, id: sess.id });
    setMsgs(toMsgs(hist));
    onState?.({ resume: sess.id, title: sess.summary.slice(0, 30) });
    setThreads([]); // threads belong to the previous conversation
    info.current.cost = 0;
    setGen((g) => g + 1); // restart process with --resume
  };

  const send = async () => {
    const text = input.trim();
    if (!text && !images.length) return;
    if (/^\/resume\b/.test(text)) { // CLI's /resume is an interactive picker; unavailable in -p mode
      setInput(""); setSlash([]);
      setSessions(await invoke<SessionInfo[]>("list_sessions", { cwd }));
      return;
    }
    if (!started && text) onState?.({ title: text.replace(/^>.*\n?/gm, "").trim().slice(0, 30) || text.slice(0, 30) });
    setMsgs((m) => [...m, { role: "user", text, images }]);
    setInput(""); setImages([]); setBusy(true); setSlash([]); setAtBottom(true);
    await invoke("send_message", { id, text, images }).catch((e) => setMsgs((m) => [...m, { role: "err", text: String(e) }]));
  };

  const onInput = (v: string) => {
    setInput(v);
    const m = /^\/(\S*)$/.exec(v);
    setSlash(m ? info.current.commands.filter((c) => c.startsWith(m[1])).slice(0, 12) : []);
    setSlashIdx(0);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (slash.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % slash.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + slash.length) % slash.length); return; }
      if (e.key === "Tab" || (e.key === "Enter" && input !== `/${slash[slashIdx]}`)) { e.preventDefault(); setInput(`/${slash[slashIdx]} `); setSlash([]); return; }
      if (e.key === "Escape") { setSlash([]); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === "Escape" && busy) control({ subtype: "interrupt" });
  };

  const onPaste = (e: React.ClipboardEvent) => {
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
    <div className={`pane ${compact ? "compact" : ""}`}>
      <div className="msgs" ref={listRef} onMouseUp={onMouseUp} onScroll={onScroll}>
        {msgs.map((m, i) => m.role === "tool" ? <ToolCard key={m.id} m={m} /> : (
          <div key={i} className={`msg ${m.role}`}>
            {m.images?.map((im, j) => <img key={j} src={`data:${im.media_type};base64,${im.data}`} />)}
            {m.role === "err" ? m.text : <Markdown {...plugins}>{m.text}</Markdown>}
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
              <button onClick={(e) => { e.stopPropagation(); patchThread(t.id, null); }}>close</button>
            </span>
          </div>
          <div className="thread-body" style={{ display: showBody ? undefined : "none" }}><Chat id={t.id} cwd={cwd} resume={t.resume} fork quote={t.quote} compact /></div>
        </div>,
        document.body,
      ))}
      <div className="composer">
        {images.length > 0 && <div className="thumbs">{images.map((im, i) => <img key={i} src={`data:${im.media_type};base64,${im.data}`} onClick={() => setImages((x) => x.filter((_, j) => j !== i))} />)}</div>}
        {perm && (
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
            {sessions.map((s) => <li key={s.id} onMouseDown={() => resume(s)}>{new Date(s.mtime * 1000).toLocaleString()} · {s.id.slice(0, 8)} · {s.summary}</li>)}
            <li onMouseDown={() => setSessions(null)}>✕ cancel</li>
          </ul>
        )}
        {slash.length > 0 && (
          <ul className="slash">
            {slash.map((c, i) => <li key={c} className={i === slashIdx ? "sel" : ""} onMouseDown={() => { setInput(`/${c} `); setSlash([]); }}>/{c}</li>)}
          </ul>
        )}
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
              <span dangerouslySetInnerHTML={{ __html: statusHtml || "starting…" }} />{busy ? " ⏳" : ""}
            </div>
            <div className="cwdrow">
              <input className="cwd" value={cwd} disabled={started} title="Working directory (locked after first message)" onChange={(e) => setCwd(e.target.value)} onBlur={(e) => applyCwd(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyCwd(cwd)} />
              <select className="mode" value={mode} title="Permission mode" onChange={(e) => applyMode(e.target.value)}>
                {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </>
        )}
        {compact && busy && <div className="status">⏳</div>}
      </div>
    </div>
  );
}
