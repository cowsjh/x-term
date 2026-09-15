import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IDockviewPanelProps } from "dockview-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { openSession } from "./App";
import { ansiToHtml } from "./ansi";

export type SessionParams = { title?: string; resume?: string; fork?: boolean; quote?: string; cwd?: string };
type Img = { media_type: string; data: string };
type Msg = { role: "user" | "assistant" | "tool" | "err"; text: string; images?: Img[] };

const plugins = { remarkPlugins: [remarkGfm, remarkMath], rehypePlugins: [rehypeKatex] };
// ponytail: context size not reported by CLI; 1M for fable/opus-1m, else 200k. Fix when stream-json exposes it.
const BUILTINS = "x-term.builtinCommands"; // CLI reports slash_commands only after the first turn; cache across sessions
type SessionInfo = { id: string; mtime: number; summary: string };
const ctxSize = (model: string) => (/fable|\[1m\]/.test(model) ? 1_000_000 : 200_000);

export function SessionPane({ api, containerApi, params }: IDockviewPanelProps<SessionParams>) {
  const id = api.id;
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState(params.quote ? `> ${params.quote.replace(/\n/g, "\n> ")}\n\n` : "");
  const [images, setImages] = useState<Img[]>([]);
  const [busy, setBusy] = useState(false);
  const [cwd, setCwd] = useState(params.cwd ?? "");
  const [gen, setGen] = useState(0); // bump to restart the claude process
  const [statusHtml, setStatusHtml] = useState("");
  const [ask, setAsk] = useState<{ x: number; y: number; text: string } | null>(null);
  const [slash, setSlash] = useState<string[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null); // /resume picker
  const sessionId = useRef<string | undefined>(params.resume);
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
            info.current = { ...info.current, model: ev.model, cwd: ev.cwd, commands: [...new Set([...info.current.commands, ...(ev.slash_commands ?? [])])].sort() };
            localStorage.setItem(BUILTINS, JSON.stringify(ev.slash_commands ?? []));
            refreshStatus();
          }
          break;
        case "conversation_reset": // `/clear`: CLI starts a fresh session in the same process
          setMsgs([]);
          info.current.cost = 0;
          info.current.usage = undefined;
          break;
        case "rate_limit_event":
          info.current.rate = ev.rate_limit_info;
          break;
        case "stream_event": {
          const d = ev.event;
          if (d.type === "content_block_start" && d.content_block?.type === "tool_use") {
            streaming.current = "";
            setMsgs((m) => [...m, { role: "tool", text: `▶ ${d.content_block.name}` }]);
          } else if (d.type === "content_block_delta" && d.delta?.type === "text_delta") {
            streaming.current += d.delta.text;
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
              setMsgs((m) => [...m.filter((x) => x.text !== `▶ ${b.name}`), { role: "tool", text: `▶ ${b.name} ${JSON.stringify(b.input).slice(0, 300)}` }]);
            // slash commands (e.g. /context) come back as a full text block without deltas
            if (b.type === "text" && !streaming.current) setAssistant(b.text);
          }
          break;
        case "user":
          for (const b of ev.message?.content ?? []) {
            if (b.type === "tool_result") {
              const t = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("\n");
              setMsgs((m) => [...m, { role: "tool", text: `◀ ${t.slice(0, 500)}` }]);
            }
          }
          break;
        case "result":
          sessionId.current = ev.session_id;
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
    invoke("start_session", { id, cwd, resume: sessionId.current ?? null, fork: !!params.fork, permissionMode: "acceptEdits" })
      .catch((e) => alive && setMsgs((m) => [...m, { role: "err", text: String(e) }]));
    return () => { alive = false; unlisten.then((f) => f()); invoke("stop_session", { id }); };
  }, [id, gen]);

  useEffect(() => { listRef.current?.scrollTo(0, listRef.current.scrollHeight); }, [msgs]);

  const applyCwd = (dir: string) => {
    if (!dir || dir === cwd) return;
    setCwd(dir);
    if (!started) setGen((g) => g + 1); // restart process in new dir; after first message cwd is fixed
  };

  const resume = async (sess: SessionInfo) => {
    setSessions(null);
    sessionId.current = sess.id;
    const hist = await invoke<{ role: string; text: string }[]>("load_transcript", { cwd, id: sess.id });
    setMsgs(hist.map((h) => ({ role: h.role as Msg["role"], text: h.text })));
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
    setMsgs((m) => [...m, { role: "user", text, images }]);
    setInput(""); setImages([]); setBusy(true); setSlash([]);
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

  const onMouseUp = (e: React.MouseEvent) => {
    const sel = window.getSelection()?.toString().trim();
    setAsk(sel ? { x: e.clientX, y: e.clientY - 30, text: sel } : null);
  };
  const followUp = () => {
    if (!ask) return;
    openSession(containerApi, { resume: sessionId.current, fork: true, quote: ask.text, title: `↳ ${api.title}`, cwd }, id);
    setAsk(null);
  };

  return (
    <div className="pane">
      <div className="msgs" ref={listRef} onMouseUp={onMouseUp}>
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.images?.map((im, j) => <img key={j} src={`data:${im.media_type};base64,${im.data}`} />)}
            {m.role === "assistant" || m.role === "user" ? <Markdown {...plugins}>{m.text}</Markdown> : m.text}
          </div>
        ))}
        {ask && <button className="ask-btn" style={{ left: ask.x, top: ask.y }} onMouseDown={followUp}>Ask about this ↗</button>}
      </div>
      <div className="composer">
        {images.length > 0 && <div className="thumbs">{images.map((im, i) => <img key={i} src={`data:${im.media_type};base64,${im.data}`} onClick={() => setImages((x) => x.filter((_, j) => j !== i))} />)}</div>}
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
          value={input}
          placeholder={busy ? "working…" : "Message (Enter send, Shift+Enter newline, / commands, paste images)"}
          onChange={(e) => onInput(e.target.value)}
          onPaste={onPaste}
          onKeyDown={onKey}
        />
        <div className="status">
          <span dangerouslySetInnerHTML={{ __html: statusHtml || "starting…" }} />{busy ? " ⏳" : ""}
        </div>
        <input className="cwd" value={cwd} disabled={started} title="Working directory (locked after first message)" onChange={(e) => setCwd(e.target.value)} onBlur={(e) => applyCwd(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyCwd(cwd)} />
      </div>
    </div>
  );
}
