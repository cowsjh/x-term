//! x-term as an MCP server for the claude sessions it hosts, so a session can open sibling panes and wait for them.
//!
//! `x-term --mcp` (same binary, spawned by claude via --mcp-config) speaks MCP over stdio and forwards every
//! `tools/call` as one JSON line to the running app's unix socket; the app hands it to the frontend
//! (`mcp-request` event), which does the pane work and answers with `mcp_reply`.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::Duration;

/// Upper bound for one forwarded tool call. `lib.rs` gives the CLI the same budget via `MCP_TOOL_TIMEOUT`.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(2 * 3600);
use tauri::{AppHandle, Emitter, State};

/// Where sockets live: the user's runtime dir, else /tmp.
fn runtime_dir() -> std::path::PathBuf {
    match std::env::var("XDG_RUNTIME_DIR") {
        Ok(dir) if !dir.is_empty() => std::path::PathBuf::from(dir),
        _ => std::path::PathBuf::from("/tmp"),
    }
}

pub fn sock_path() -> std::path::PathBuf {
    // per-uid name: the /tmp fallback is shared, so a fixed name there lets another local user drive our panes
    match std::env::var("XDG_RUNTIME_DIR") {
        Ok(dir) if !dir.is_empty() => std::path::PathBuf::from(dir).join("x-term.sock"),
        _ => std::path::PathBuf::from("/tmp").join(format!("x-term-{}.sock", uid())),
    }
}

/// The socket this process actually bound (see `listen`). Empty = we never bound one, so there is nothing to
/// hand to sessions and nothing of ours to unlink; unset = `listen` has not run yet.
static SOCK: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// The socket we bound, or an empty path when MCP is unavailable. Callers must check `as_os_str().is_empty()`
/// rather than assume `sock_path()`: unlinking a socket another instance owns would cut its sessions off.
pub fn active_sock() -> std::path::PathBuf {
    SOCK.get().cloned().unwrap_or_default()
}

/// Unlink the socket only when this process is the one that bound it.
pub fn cleanup_sock() {
    if let Some(p) = SOCK.get().filter(|p| !p.as_os_str().is_empty()) {
        let _ = std::fs::remove_file(p);
    }
}

/// Bridge side: the socket our parent app told us about, else the default one.
fn bridge_sock() -> std::path::PathBuf {
    match std::env::var("X_TERM_SOCK") {
        Ok(p) if !p.is_empty() => std::path::PathBuf::from(p),
        _ => sock_path(),
    }
}

fn uid() -> u32 {
    // no libc dependency: the owner of our runtime dir / proc entry is us
    std::fs::metadata("/proc/self").map(|m| std::os::unix::fs::MetadataExt::uid(&m)).unwrap_or(0)
}

pub const TOOLS: &str = r#"[
 {"name":"spawn_agents","description":"Open parallel Claude panes in x-term, each started with its own prompt. Returns the pane ids. Each agent starts with NO context except its prompt. Give each a `worktree` (branch name) so edits never collide; omit it only for read-only tasks.","inputSchema":{"type":"object","properties":{"agents":{"type":"array","maxItems":8,"items":{"type":"object","properties":{"title":{"type":"string","description":"short pane title"},"prompt":{"type":"string","description":"complete, self-contained task"},"worktree":{"type":"string","description":"branch / worktree name (letters, digits, - _); omit to share the parent's directory"},"weight":{"type":"string","enum":["light","standard","heavy"],"description":"how much thinking the task needs; picks the pane's model. light = lookup / mechanical edit, standard = normal feature or review work, heavy = architecture, tricky debugging, long multi-file work. Omit and x-term infers it from the prompt."},"model":{"type":"string","description":"full model id, overrides `weight` (e.g. claude-opus-5[1m])"},"effort":{"type":"string","enum":["low","medium","high","xhigh","max"],"description":"overrides the effort that comes with `weight`"}},"required":["title","prompt"]}}},"required":["agents"]}},
 {"name":"wait_agents","description":"Block until the given panes finish their turn (or timeout). Returns each pane's status and final answer text.","inputSchema":{"type":"object","properties":{"ids":{"type":"array","items":{"type":"string"}},"timeout_s":{"type":"number","minimum":1,"maximum":7200,"description":"default 1800"}},"required":["ids"]}},
 {"name":"agent_status","description":"Status (idle | working | permission | closed) and last answer of one pane.","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}},
 {"name":"send_to_agent","description":"Send a follow-up message to a pane you spawned.","inputSchema":{"type":"object","properties":{"id":{"type":"string"},"text":{"type":"string"}},"required":["id","text"]}},
 {"name":"close_agent","description":"Close a pane you spawned (its worktree stays on disk).","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}
]"#;

pub const SYSTEM_PROMPT: &str = "You run inside x-term, a desktop app that shows several Claude sessions as side-by-side panes. Through the x-term MCP tools (spawn_agents, wait_agents, agent_status, send_to_agent, close_agent) you can delegate work to new panes that run in parallel and are visible to the user.\n\
When to delegate: the request splits into 2 or more independent subtasks, each touching several files, with no subtask needing another's result. Then call spawn_agents once with all of them (one worktree per agent unless the task is read-only), then wait_agents, then integrate: merge the worktree branches (git merge / cherry-pick from the main checkout) or tell the user exactly how, and summarize. The user approves spawn_agents through a permission prompt, so describe each agent's job clearly in its prompt. Set each agent's `weight` (light / standard / heavy) from how much thinking its task needs: x-term gives the pane a model to match, so a lookup does not run on the biggest model.\n\
When not to: small tasks, sequential tasks, anything a single session finishes in a few steps. Then do the work yourself. Never delegate if your own prompt says you were spawned by another pane.";

/// `x-term --mcp`: stdio MCP server that proxies tool calls to the running app.
pub fn bridge() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    let pane = std::env::var("X_TERM_PANE").unwrap_or_default();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let id = req["id"].clone();
        if id.is_null() { continue } // notifications
        let method = req["method"].as_str().unwrap_or("");
        let result = match method {
            "initialize" => Ok(json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"x-term","version":env!("CARGO_PKG_VERSION")}})),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": serde_json::from_str::<Value>(TOOLS).unwrap()})),
            "tools/call" => {
                let msg = json!({"id": uuid(), "pane": pane, "name": req["params"]["name"], "arguments": req["params"]["arguments"]});
                match call_app(&msg) {
                    Ok(r) => Ok(json!({"content":[{"type":"text","text": r["result"].to_string()}], "isError": !r["error"].is_null()})),
                    Err(e) => Ok(json!({"content":[{"type":"text","text": e}], "isError": true})),
                }
            }
            _ => Err(json!({"code": -32601, "message": format!("unknown method {method}")})),
        };
        let resp = match result { Ok(r) => json!({"jsonrpc":"2.0","id":id,"result":r}), Err(e) => json!({"jsonrpc":"2.0","id":id,"error":e}) };
        let _ = writeln!(out, "{resp}");
        let _ = out.flush();
    }
}

fn uuid() -> String {
    // ponytail: nanos + pid is unique enough for request ids within one machine
    format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0))
}

fn call_app(msg: &Value) -> Result<Value, String> {
    let mut s = UnixStream::connect(bridge_sock()).map_err(|e| format!("x-term app not reachable: {e}"))?;
    let _ = s.set_read_timeout(Some(CALL_TIMEOUT)); // the app can die mid-call; never block the session forever
    writeln!(s, "{msg}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(&s).read_line(&mut line).map_err(|e| e.to_string())?;
    if line.trim().is_empty() { return Err("x-term app closed the connection (restarted?)".into()) }
    let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    if let Some(e) = v["error"].as_str() { return Err(e.to_string()) }
    Ok(v)
}

pub struct Pending(Mutex<Vec<(String, Sender<Value>)>>); // Vec: const-constructible for a static; a handful of entries at most
impl Pending {
    pub const fn new() -> Self { Pending(Mutex::new(Vec::new())) }
    fn take(&self, id: &str) -> Option<Sender<Value>> {
        let mut v = super::lock(&self.0);
        v.iter().position(|(k, _)| k == id).map(|i| v.remove(i).1)
    }
}

/// Bind one socket path, owner-only. Never unlinks: the caller decides what counts as a stale file.
fn bind(path: &std::path::Path) -> std::io::Result<UnixListener> {
    let l = UnixListener::bind(path)?;
    let _ = std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600));
    Ok(l)
}

/// App side: accept bridge connections, forward each call to the frontend, block until `mcp_reply`.
pub fn listen(app: AppHandle, pending: &'static Pending) {
    // per-instance name; the /tmp fallback is shared between users, so it needs the uid too
    let per_pid = match std::env::var("XDG_RUNTIME_DIR") {
        Ok(d) if !d.is_empty() => runtime_dir().join(format!("x-term-{}.sock", std::process::id())),
        _ => runtime_dir().join(format!("x-term-{}-{}.sock", uid(), std::process::id())),
    };
    let _ = std::fs::remove_file(&per_pid); // carries our own pid, so any file there is a leftover
    let default = sock_path();
    // a live app answering the default name owns it; anything else means the file is stale
    let first = if UnixStream::connect(&default).is_ok() {
        per_pid.clone()
    } else {
        let _ = std::fs::remove_file(&default);
        default
    };
    let (listener, path) = match bind(&first) {
        Ok(l) => (l, first),
        // lost the race for the default name (AddrInUse), or it is unwritable: fall back to our own name
        Err(e) => {
            if first != per_pid {
                eprintln!("x-term: MCP socket {} unavailable ({e}), using {}", first.display(), per_pid.display());
            }
            match bind(&per_pid) {
                Ok(l) => (l, per_pid),
                Err(e2) => {
                    eprintln!("x-term: no MCP socket ({e2}); sessions run without the x-term MCP server");
                    let _ = SOCK.set(std::path::PathBuf::new()); // sentinel: nothing bound, nothing to clean up
                    return;
                }
            }
        }
    };
    let _ = SOCK.set(path);
    std::thread::spawn(move || {
        for stream in listener.incoming().filter_map(|s| s.ok()) {
            let app = app.clone();
            std::thread::spawn(move || {
                // a bridge that connects and never speaks must not pin a thread forever
                let _ = stream.set_read_timeout(Some(CALL_TIMEOUT));
                let mut line = String::new();
                if BufReader::new(&stream).read_line(&mut line).is_err() { return }
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { return };
                // the id is the routing key for mcp_reply: anything but a non-empty string is unanswerable
                let Some(id) = msg["id"].as_str().filter(|i| !i.is_empty()).map(String::from) else {
                    let mut s = &stream;
                    let _ = writeln!(s, "{}", json!({"error":"x-term: request id must be a non-empty string"}));
                    return;
                };
                let (tx, rx) = std::sync::mpsc::channel();
                super::lock(&pending.0).push((id.clone(), tx));
                let _ = app.emit("mcp-request", msg);
                let reply = rx.recv_timeout(CALL_TIMEOUT).unwrap_or_else(|_| json!({"error":"timed out waiting for x-term"}));
                pending.take(&id);
                let mut s = &stream;
                let _ = writeln!(s, "{reply}");
            });
        }
    });
}

/// Frontend answers a forwarded tool call. `result` = any JSON; `error` = message.
#[tauri::command]
pub fn mcp_reply(state: State<&'static Pending>, id: String, result: Option<Value>, error: Option<String>) {
    if let Some(tx) = state.take(&id) {
        let _ = tx.send(match error { Some(e) => json!({"error": e}), None => json!({"result": result.unwrap_or(Value::Null)}) });
    }
}
