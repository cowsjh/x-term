use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct Session {
    child: Child,
    stdin: ChildStdin,
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
    let cwd = cwd.filter(|d| !d.is_empty()).unwrap_or_else(|| std::env::var("HOME").unwrap_or("/".into()));
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
    state.0.lock().unwrap().insert(id, Session { child, stdin });
    Ok(())
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
    let mut map = state.0.lock().unwrap();
    let s = map.get_mut(&id).ok_or("no such session")?;
    writeln!(s.stdin, "{msg}").map_err(|e| e.to_string())?;
    s.stdin.flush().map_err(|e| e.to_string())
}

/// Runs the user's Claude Code statusLine command (from ~/.claude/settings.json) with `json` on stdin.
/// `oauthAccount` from ~/.claude.json (plan / org type for the status bar); Null if unavailable.
#[tauri::command]
fn account_info() -> serde_json::Value {
    std::fs::read_to_string(format!("{}/.claude.json", home()))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|v| v["oauthAccount"].clone())
        .unwrap_or(serde_json::Value::Null)
}

// ---- PTY terminal panes ----------------------------------------------------------------------

struct Pty {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pid: Option<u32>,
}

#[derive(Default)]
struct Ptys(Mutex<HashMap<String, Pty>>);

/// Spawn `$SHELL` in a pty. Output streams as `pty-data` {id, data} events (UTF-8 safe across chunk
/// boundaries); `pty-exit` {id} when the shell exits.
#[tauri::command]
fn pty_open(app: AppHandle, state: State<Ptys>, id: String, cwd: Option<String>, cols: u16, rows: u16) -> Result<(), String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()));
    cmd.cwd(cwd.filter(|c| !c.is_empty()).unwrap_or_else(initial_cwd));
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let pid = child.process_id();
    state.0.lock().unwrap().insert(id.clone(), Pty { master: pair.master, writer, child, pid });
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
        let _ = app.emit("pty-exit", id);
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
    let mut m = state.0.lock().unwrap();
    let p = m.get_mut(&id).ok_or("no pty")?;
    p.writer.write_all(data.as_bytes()).and_then(|_| p.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(state: State<Ptys>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let m = state.0.lock().unwrap();
    let p = m.get(&id).ok_or("no pty")?;
    p.master.resize(portable_pty::PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

/// Where the shell is right now (tracks `cd`), via /proc; empty if unknown.
#[tauri::command]
fn pty_cwd(state: State<Ptys>, id: String) -> String {
    let pid = state.0.lock().unwrap().get(&id).and_then(|p| p.pid);
    pid.and_then(|pid| std::fs::read_link(format!("/proc/{pid}/cwd")).ok())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[tauri::command]
fn pty_close(state: State<Ptys>, id: String) {
    if let Some(mut p) = state.0.lock().unwrap().remove(&id) {
        let _ = p.child.kill();
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
}

/// Past sessions for `cwd`, newest first. Summary = last recorded prompt.
#[tauri::command]
fn list_sessions(cwd: String) -> Vec<SessionInfo> {
    let Ok(rd) = std::fs::read_dir(project_dir(&cwd)) else { return vec![] };
    let mut out: Vec<SessionInfo> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| {
            let id = e.path().file_stem()?.to_string_lossy().into_owned();
            let mtime = e.metadata().ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            let text = std::fs::read_to_string(e.path()).ok()?;
            let lines: Vec<serde_json::Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
            // stubs: sessions that only ran a local slash command (`/clear`, a typo) have no real user prompt
            let has_prompt = lines.iter().any(|v| v["type"] == "user" && v["isMeta"] != true && match &v["message"]["content"] {
                serde_json::Value::String(s) => !s.starts_with('<'),
                serde_json::Value::Array(a) => a.iter().any(|b| b["type"] == "text" && !b["text"].as_str().unwrap_or("<").starts_with('<')),
                _ => false,
            });
            if !has_prompt {
                return None;
            }
            let summary = lines
                .iter()
                .filter_map(|v| v["lastPrompt"].as_str().or_else(|| v["message"]["content"].as_str()).map(|t| t.chars().take(80).collect::<String>()))
                .last()
                .unwrap_or_default();
            Some(SessionInfo { id, mtime, summary })
        })
        .collect();
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

#[derive(Serialize)]
struct TranscriptMsg {
    role: String,
    text: String,
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
                out.push(TranscriptMsg { role: role.into(), text: t.into() });
            }
            continue;
        }
        for b in content.as_array().into_iter().flatten() {
            match b["type"].as_str() {
                Some("text") => out.push(TranscriptMsg { role: role.into(), text: b["text"].as_str().unwrap_or("").into() }),
                Some("tool_use") => out.push(TranscriptMsg { role: "tool".into(), text: format!("▶ {}", b["name"].as_str().unwrap_or("")) }),
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
    let mut map = state.0.lock().unwrap();
    let s = map.get_mut(&id).ok_or("no such session")?;
    writeln!(s.stdin, "{line}").map_err(|e| e.to_string())?;
    s.stdin.flush().map_err(|e| e.to_string())
}

/// Relative paths under `cwd` containing `query` (case-insensitive), depth <= 5, skipping build/vcs dirs. For `@file` completion.
#[tauri::command]
fn list_files(cwd: String, query: String) -> Vec<String> {
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
    if let Some(mut s) = state.0.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Sessions::default())
        .manage(Ptys::default())
        .invoke_handler(tauri::generate_handler![start_session, send_message, stop_session, write_line, account_info, pty_open, pty_write, pty_resize, pty_cwd, pty_close, initial_cwd, list_sessions, load_transcript, list_skills, list_files])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
    fn sessions_and_skills_from_claude_dir() {
        let Ok(cwd) = std::env::var("X_TERM_TEST_CWD") else { return };
        assert!(!list_skills(cwd.clone()).is_empty());
        let ss = list_sessions(cwd.clone());
        assert!(!ss.is_empty());
        assert!(ss.windows(2).all(|w| w[0].mtime >= w[1].mtime), "newest first");
        let tr = load_transcript(cwd, ss[0].id.clone());
        assert!(tr.iter().any(|m| m.role == "user"), "transcript has user text");
        assert!(tr.iter().all(|m| !m.text.is_empty() || m.role == "tool"));
    }
}
