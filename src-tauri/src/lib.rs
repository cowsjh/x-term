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
        .invoke_handler(tauri::generate_handler![start_session, send_message, stop_session, run_statusline, initial_cwd])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
