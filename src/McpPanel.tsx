import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { warn } from "./events";
import { McpServer, mcpGroups, mcpLabel } from "./util";

type Ask = (request: object) => Promise<any>;
export type McpRefresh = (ms?: number, done?: (l: McpServer[]) => boolean) => void;
const ICON: Record<McpServer["status"], string> = { connected: "✔", pending: "⋯", "needs-auth": "!", failed: "✘", disabled: "○" };

/** Status-bar chip: connected count, "…" while servers are still connecting, "N !" for servers the user added that need a fix. */
export function McpBadge({ list, open, onClick }: { list: McpServer[]; open: boolean; onClick: () => void }) {
  const g = mcpGroups(list);
  const on = g.active.filter((s) => s.status === "connected").length;
  const wait = g.active.length - on;
  const bad = g.attention.length;
  return (
    <button className={`mcp-tag ${bad ? "warn" : ""} ${open ? "on" : ""}`} onClick={onClick}
      title={`MCP: ${on} connected${wait ? `, ${wait} connecting` : ""}${bad ? `, ${bad} need attention` : ""} · click or /mcp`}>
      MCP {on}{wait ? "…" : ""}{bad ? ` · ${bad} !` : ""}
    </button>
  );
}

/** /mcp popover: per-server status with the one action that state needs (sign in / retry), on/off, tool list. */
export function McpPanel({ list, loading, ask, refresh, where, onClose }: { list: McpServer[]; loading: boolean; ask: Ask; refresh: McpRefresh; where: string; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null); // server whose tool list is expanded
  const [note, setNote] = useState<Record<string, { text: string; url?: string; err?: boolean }>>({});
  const say = (name: string, n?: { text: string; url?: string; err?: boolean }) => setNote((x) => { const y = { ...x }; if (n) y[name] = n; else delete y[name]; return y; });
  const run = async (s: McpServer, req: object, busy: string) => {
    say(s.name, { text: busy });
    try { const r = await ask({ ...req, serverName: s.name }); say(s.name); return r ?? {}; }
    catch (e) { say(s.name, { text: String(e instanceof Error ? e.message : e), err: true }); }
  };
  const toggle = async (s: McpServer) => { if (await run(s, { subtype: "mcp_toggle", enabled: s.status === "disabled" }, s.status === "disabled" ? "turning on…" : "turning off…")) refresh(); };
  const retry = async (s: McpServer) => { if (await run(s, { subtype: "mcp_reconnect" }, "reconnecting…")) refresh(); };
  const signIn = async (s: McpServer) => {
    const r = await run(s, { subtype: "mcp_authenticate" }, "starting sign-in…");
    if (!r) return;
    if (r.authUrl) { openUrl(r.authUrl).catch(warn); say(s.name, { text: "Finish signing in in your browser.", url: r.authUrl }); }
    refresh(0, (l) => l.find((x) => x.name === s.name)?.status !== "needs-auth"); // the CLI takes the browser redirect itself; poll until it lands
  };
  const pasteCallback = async (s: McpServer, url: string) => { if (await run(s, { subtype: "mcp_oauth_callback_url", callbackUrl: url.trim() }, "finishing sign-in…")) refresh(0, (l) => l.find((x) => x.name === s.name)?.status !== "needs-auth"); };

  const f = q.trim().toLowerCase();
  const g = mcpGroups(f ? list.filter((s) => s.name.toLowerCase().includes(f)) : list);
  const row = (s: McpServer) => {
    const lb = mcpLabel(s);
    const n = note[s.name];
    const shown = n && !(n.url && s.status !== "needs-auth"); // sign-in note goes away once the server leaves needs-auth
    const tools = s.tools ?? [];
    return (
      <li key={s.name} className="mcp-row">
        <div className="mcp-line">
          <span className={`mcp-dot ${s.status}`} title={s.status}>{ICON[s.status]}</span>
          <span className={`mcp-name ${tools.length ? "click" : ""}`} title={tools.length ? `${s.name} · show tools` : s.name} onClick={() => tools.length && setOpen(open === s.name ? null : s.name)}>{lb.name}</span>
          {lb.tag !== lb.name && <span className="mcp-src">{lb.tag}</span>}
          <span className="mcp-fill" />
          {s.status === "pending" && <span className="dim">connecting…</span>}
          {tools.length > 0 && <span className="dim">{tools.length} tools</span>}
          {s.status === "needs-auth" && <button onClick={() => signIn(s)}>Sign in</button>}
          {s.status === "failed" && <button onClick={() => retry(s)}>Retry</button>}
          <button role="switch" aria-checked={s.status !== "disabled"} aria-label={`${lb.name} on/off`} className={`mcp-sw ${s.status !== "disabled" ? "on" : ""}`} title={s.status === "disabled" ? "Turn on" : "Turn off"} onClick={() => toggle(s)} />
        </div>
        {s.error && <div className="mcp-err">{s.error}</div>}
        {shown && (
          <div className={`mcp-note ${n.err ? "err" : ""}`}>
            {n.text}
            {n.url && <> <button onClick={() => navigator.clipboard.writeText(n.url!).catch(warn)}>Copy link</button> <button onClick={() => say(s.name)}>Cancel</button>
              <input placeholder="Browser on another machine? Paste the redirect URL here and press Enter" onKeyDown={(e) => { if (e.key === "Enter" && e.currentTarget.value.trim()) pasteCallback(s, e.currentTarget.value); }} /></>}
          </div>
        )}
        {open === s.name && (
          <ul className="mcp-tools">
            {tools.map((t) => <li key={t.name} title={t.description}>{t.name}{t.annotations?.readOnly && <span className="dim"> · read-only</span>}{t.annotations?.destructive && <span className="mcp-danger"> destructive</span>}</li>)}
          </ul>
        )}
      </li>
    );
  };
  const group = (title: string, rows: McpServer[], folded = false) =>
    rows.length === 0 ? null : folded && !f
      ? <details className="mcp-group"><summary>{title} ({rows.length})</summary><ul>{rows.map(row)}</ul></details>
      : <div className="mcp-group"><div className="mcp-gt">{title}</div><ul>{rows.map(row)}</ul></div>;

  return (
    <div className="mcp-pop" tabIndex={-1} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div className="mcp-head">
        <b>MCP servers</b>
        {list.length > 8 && <input autoFocus placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />}
        <span className="mcp-fill" />
        <button title="Refresh" onClick={() => refresh()}>↻</button>
        <button title="Close (Esc)" onClick={onClose}>✕</button>
      </div>
      {loading && <div className="dim">loading…</div>}
      {group("Active", g.active)}
      {group("Needs attention", g.attention)}
      {group("Off", g.off)}
      {group("Plugin servers you can sign in to", g.signin, true)}
      {group("Unavailable plugin servers", g.unavailable, true)}
      <div className="mcp-foot dim">On/off is saved for {where} and applies to every session started there. Add servers with <code>claude mcp add</code>; new panes pick them up.</div>
    </div>
  );
}

export type Elicitation = { request_id: string; mcp_server_name: string; message: string; mode?: "form" | "url"; url?: string; requested_schema?: any; title?: string; display_name?: string };

/** An MCP server asks the user for input (form fields or a link to visit). Every path must answer, or the tool call hangs. */
export function ElicitCard({ req, answer }: { req: Elicitation; answer: (action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void }) {
  const props = Object.entries(req.requested_schema?.properties ?? {}) as [string, any][];
  const required: string[] = req.requested_schema?.required ?? [];
  const [v, setV] = useState<Record<string, any>>(() => Object.fromEntries(props.map(([k, p]) => [k, p.default ?? (p.type === "boolean" ? false : "")])));
  const ok = required.every((k) => v[k] !== "" && v[k] !== undefined);
  const submit = () => ok && answer("accept", Object.fromEntries(props.filter(([k]) => v[k] !== "").map(([k, p]) => [k, p.type === "number" || p.type === "integer" ? Number(v[k]) : v[k]])));
  const field = ([k, p]: [string, any]) => {
    const opts: { value: string; label: string }[] | undefined = p.enum?.map((x: string, i: number) => ({ value: x, label: p.enumNames?.[i] ?? x })) ?? p.oneOf?.map((o: any) => ({ value: o.const, label: o.title ?? o.const }));
    const set = (x: any) => setV((y) => ({ ...y, [k]: x }));
    return (
      <label key={k} className="elicit-field">
        <span>{p.title ?? k}{required.includes(k) ? " *" : ""}</span>
        {p.type === "boolean" ? <input type="checkbox" checked={!!v[k]} onChange={(e) => set(e.target.checked)} />
          : opts ? <select value={v[k]} onChange={(e) => set(e.target.value)}><option value="" />{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          : <input type={p.type === "number" || p.type === "integer" ? "number" : "text"} value={v[k]} placeholder={p.description ?? ""} onChange={(e) => set(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />}
      </label>
    );
  };
  return (
    <div className="perm ask elicit">
      <div className="perm-title">{req.display_name ?? req.title ?? req.mcp_server_name} · needs your input</div>
      <div className="elicit-msg">{req.message}</div>
      {req.mode === "url" ? (
        <div>
          <button onClick={() => req.url && openUrl(req.url).catch(warn)}>Open link</button>
          <button onClick={() => answer("accept")}>Done</button>
          <button onClick={() => answer("cancel")}>Cancel</button>
        </div>
      ) : (
        <>
          {props.map(field)}
          <div>
            <button onClick={submit} disabled={!ok}>Submit</button>
            <button onClick={() => answer("decline")}>Decline</button>
            <button onClick={() => answer("cancel")}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
