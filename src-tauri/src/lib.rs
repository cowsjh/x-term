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
#[tauri::command]
fn run_statusline(json: String) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let cmd = std::fs::read_to_string(format!("{home}/.claude/settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["statusLine"]["command"].as_str().map(String::from));
    let Some(cmd) = cmd else { return String::new() };
    let Ok(mut child) = Command::new("sh").args(["-c", &cmd]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { return String::new() };
    let _ = child.stdin.take().unwrap().write_all(json.as_bytes());
    child.wait_with_output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
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
            let summary = text
                .lines()
                .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
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

/// Abort the running turn (CLI answers with control_response, then a result with subtype error_during_execution).
#[tauri::command]
fn interrupt_session(state: State<Sessions>, id: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    let s = map.get_mut(&id).ok_or("no such session")?;
    writeln!(s.stdin, r#"{{"type":"control_request","request_id":"{}","request":{{"subtype":"interrupt"}}}}"#, id).map_err(|e| e.to_string())?;
    s.stdin.flush().map_err(|e| e.to_string())
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
        .manage(Sessions::default())
        .invoke_handler(tauri::generate_handler![start_session, send_message, stop_session, interrupt_session, run_statusline, initial_cwd, list_sessions, load_transcript, list_skills])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs a real ~/.claude/projects entry; run with X_TERM_TEST_CWD=<project dir that has skills and sessions>.
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
