// First import in main.tsx: uncaught errors (including module-evaluation failures) go to the Rust process stderr
// and onto the page, so a blank window still says why.
import { invoke } from "@tauri-apps/api/core";
const report = (msg: string) => {
  invoke("log", { msg }).catch(() => {});
  const el = document.getElementById("root");
  if (el && !el.childElementCount) el.textContent = msg;
};
window.addEventListener("error", (e) => report(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => report(`unhandled: ${e.reason?.stack ?? e.reason}`));
