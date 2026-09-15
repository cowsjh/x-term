import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IDockviewPanelProps } from "dockview-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { openSession } from "./App";

export type SessionParams = { title?: string; resume?: string; fork?: boolean; quote?: string; cwd?: string };
type Img = { media_type: string; data: string };
type Msg = { role: "user" | "assistant" | "tool" | "err"; text: string; images?: Img[] };

const plugins = { remarkPlugins: [remarkGfm, remarkMath], rehypePlugins: [rehypeKatex] };

export function SessionPane({ api, containerApi, params }: IDockviewPanelProps<SessionParams>) {
  const id = api.id;
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState(params.quote ? `> ${params.quote.replace(/\n/g, "\n> ")}\n\n` : "");
  const [images, setImages] = useState<Img[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(params.resume ? `forked from ${params.resume.slice(0, 8)}` : "new session");
  const [ask, setAsk] = useState<{ x: number; y: number; text: string } | null>(null);
  const sessionId = useRef<string | undefined>(undefined);
  const streaming = useRef("");
  const listRef = useRef<HTMLDivElement>(null);

  // append or replace trailing assistant message
  const setAssistant = (text: string) =>
    setMsgs((m) => {
      const last = m[m.length - 1];
      return last?.role === "assistant" ? [...m.slice(0, -1), { role: "assistant", text }] : [...m, { role: "assistant", text }];
    });

  useEffect(() => {
    let alive = true;
    const unlisten = listen<{ id: string; line: string }>("session-event", ({ payload }) => {
      if (payload.id !== id) return;
      let ev: any;
      try { ev = JSON.parse(payload.line); } catch { return; }
      switch (ev.type) {
        case "system":
          if (ev.subtype === "init") { sessionId.current = ev.session_id; setStatus(`${ev.model} · ${ev.session_id.slice(0, 8)}`); }
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
          for (const b of ev.message?.content ?? []) {
            if (b.type === "tool_use")
              setMsgs((m) => [...m.filter((x) => x.text !== `▶ ${b.name}`), { role: "tool", text: `▶ ${b.name} ${JSON.stringify(b.input).slice(0, 300)}` }]);
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
          setBusy(false);
          setStatus(`${ev.session_id.slice(0, 8)} · $${(ev.total_cost_usd ?? 0).toFixed(3)} · ${ev.num_turns} turns`);
          break;
        case "stderr":
          setMsgs((m) => [...m, { role: "err", text: ev.text }]);
          break;
        case "exit":
          setBusy(false);
          setStatus("exited");
          break;
      }
    });
    invoke("start_session", { id, cwd: params.cwd ?? null, resume: params.resume ?? null, fork: !!params.fork, permissionMode: "acceptEdits" })
      .catch((e) => alive && setMsgs((m) => [...m, { role: "err", text: String(e) }]));
    return () => { alive = false; unlisten.then((f) => f()); invoke("stop_session", { id }); };
  }, [id]);

  useEffect(() => { listRef.current?.scrollTo(0, listRef.current.scrollHeight); }, [msgs]);

  const send = async () => {
    const text = input.trim();
    if (!text && !images.length) return;
    setMsgs((m) => [...m, { role: "user", text, images }]);
    setInput(""); setImages([]); setBusy(true);
    await invoke("send_message", { id, text, images }).catch((e) => setMsgs((m) => [...m, { role: "err", text: String(e) }]));
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
    openSession(containerApi, { resume: sessionId.current, fork: true, quote: ask.text, title: `↳ ${api.title}` }, id);
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
        <textarea
          value={input}
          placeholder={busy ? "working…" : "Message (Enter to send, Shift+Enter newline, paste images)"}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <div className="status">{status}{busy ? " · ⏳" : ""}</div>
      </div>
    </div>
  );
}
