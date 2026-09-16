import { invoke } from "@tauri-apps/api/core";

/** ~/.config/x-term/config.json (see README). Read at startup and re-read when the file changes (Rust emits
 *  `config-changed`); missing keys fall back to these defaults. `claudeArgs`, `shell`, `exportDir`, `worktreeDir`
 *  and `autocompact` are consumed on the Rust side. A `.x-term.json` in a project overrides per pane (see `projectConfig`). */
export const DEFAULTS = {
  theme: "dark" as "dark" | "light",
  model: "claude-opus-5[1m]",
  effort: "high",
  permissionMode: "acceptEdits",
  scrollback: 5000,
  /** Terminal + code font; the chat UI keeps the system font. */
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
  /** "enter" = Enter sends, Shift+Enter newline; "ctrl+enter" = Enter newline, Ctrl+Enter sends. */
  sendKey: "enter" as "enter" | "ctrl+enter",
  /** Desktop notifications: "all" (turn done + permission), "permission", "none". */
  notify: "all" as "all" | "permission" | "none",
  confirmQuit: true,
  /** false = start with one empty terminal instead of the saved layout (also `x-term --fresh`). */
  restoreLayout: true,
  /** Ctrl+Shift+R in a chat runs this in the pane's shell (tests, build …). */
  runCommand: "",
  /** Shortcut overrides, action -> combo (see src/keys.ts for actions and the default combos). */
  keys: {} as Record<string, string>,
  claudeArgs: [] as string[],
  /** Model + effort a spawned agent gets per `weight` in the spawn_agents MCP tool (see src/App.tsx). */
  agentModels: {
    light: { model: "claude-haiku-4-5", effort: "low" },
    standard: { model: "claude-sonnet-5", effort: "medium" },
    heavy: { model: "claude-opus-5[1m]", effort: "high" },
  } as Record<string, { model: string; effort: string }>,
};
export type Config = typeof DEFAULTS;
const THEME_KEY = "x-term.theme"; // runtime toggle (Ctrl+Shift+L): {value, base}; dropped as soon as the file's theme changes from `base`

function merge(file: Partial<Config>): Config {
  // agentModels merges per weight: a config that only overrides "heavy" must not drop light/standard
  const c: Config = { ...DEFAULTS, ...file, agentModels: { ...DEFAULTS.agentModels, ...(file.agentModels ?? {}) }, keys: { ...(file.keys ?? {}) } };
  try {
    const t = JSON.parse(localStorage.getItem(THEME_KEY) ?? "null");
    if (t && t.base === c.theme && (t.value === "dark" || t.value === "light")) c.theme = t.value; else localStorage.removeItem(THEME_KEY);
  } catch { localStorage.removeItem(THEME_KEY); }
  return c;
}

/** Live config object: mutated in place by `applyConfig` so every module sees the new values without re-importing. */
export const cfg: Config = merge(await invoke<Partial<Config>>("load_config", { cwd: null }).catch(() => ({})));

/** Push document-level settings (theme attribute, font variables) and notify listeners (`x-term-config` window event). */
export function applyConfig(file?: Partial<Config>) {
  if (file) Object.assign(cfg, merge(file));
  const root = document.documentElement;
  root.dataset.theme = cfg.theme;
  root.style.setProperty("--mono", cfg.fontFamily);
  root.style.setProperty("--mono-size", `${cfg.fontSize}px`);
  window.dispatchEvent(new CustomEvent("x-term-config"));
}

export function toggleTheme() {
  const base = (JSON.parse(localStorage.getItem(THEME_KEY) ?? "null")?.base as string | undefined) ?? cfg.theme; // what the file says
  cfg.theme = cfg.theme === "light" ? "dark" : "light";
  if (cfg.theme === base) localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, JSON.stringify({ value: cfg.theme, base }));
  applyConfig();
}

/** Per-project overrides from `<repo>/.x-term.json` merged over the global file (Rust `config_for`). Only the keys a pane
 *  reads at spawn time matter here: model, effort, permissionMode, runCommand. */
export const projectConfig = (cwd: string) => invoke<Partial<Config>>("load_config", { cwd }).catch(() => ({} as Partial<Config>));
