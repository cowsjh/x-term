import { invoke } from "@tauri-apps/api/core";
import { lsGet } from "./util";

/** ~/.config/x-term/config.json (see README). Read at startup and re-read when the file changes (Rust emits
 *  `config-changed`); missing keys fall back to these defaults. `claudeArgs`, `shell`, `exportDir`, `worktreeDir`
 *  and `autocompact` are consumed on the Rust side. A `.x-term.json` in a project overrides per pane (see `projectConfig`). */
/** Palette vars every stylesheet rule reads; `colors` in config.json overrides per theme (Settings → appearance). */
export const COLOR_VARS: [string, string][] = [
  ["--bg", "background"], ["--bg0", "titlebar / status bars"], ["--bg2", "cards, tool results"], ["--bg3", "code blocks, sidebar"], ["--bg4", "buttons"],
  ["--fg", "text"], ["--fg2", "secondary text"], ["--dim", "muted text"], ["--dim2", "faint text"],
  ["--border", "borders"], ["--border2", "faint borders"], ["--accent", "accent, links, focus"],
  ["--user", "user message"], ["--user-border", "user message border"], ["--warn", "warnings, shortcut keys"], ["--err-bg", "error background"],
];
export const PALETTE: Record<"dark" | "light", Record<string, string>> = {
  dark: { "--bg": "#1e1e1e", "--bg0": "#161616", "--bg2": "#262626", "--bg3": "#111111", "--bg4": "#222222", "--fg": "#dddddd", "--fg2": "#cccccc", "--dim": "#888888", "--dim2": "#666666", "--border": "#444444", "--border2": "#333333", "--accent": "#3b6ea5", "--user": "#2a3a55", "--user-border": "#444466", "--warn": "#d7af00", "--err-bg": "#4a2020" },
  light: { "--bg": "#fafafa", "--bg0": "#e8e8e8", "--bg2": "#f0f0f0", "--bg3": "#ffffff", "--bg4": "#f4f4f4", "--fg": "#222222", "--fg2": "#333333", "--dim": "#666666", "--dim2": "#888888", "--border": "#cccccc", "--border2": "#dddddd", "--accent": "#2b62a0", "--user": "#dce8f8", "--user-border": "#b8cce8", "--warn": "#a07800", "--err-bg": "#f8d8d8" },
};

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
  /** Per-theme palette overrides, var -> hex (see COLOR_VARS); edited in Settings → appearance. */
  colors: {} as Record<string, Record<string, string>>,
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
  const c: Config = { ...DEFAULTS, ...file, agentModels: { ...DEFAULTS.agentModels, ...(file.agentModels ?? {}) }, keys: { ...(file.keys ?? {}) }, colors: { ...(file.colors ?? {}) } };
  try {
    const t = lsGet(THEME_KEY, "null");
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
  paintColors({ ...PALETTE[cfg.theme], ...(cfg.colors[cfg.theme] ?? {}) });
  root.style.setProperty("--mono", cfg.fontFamily);
  root.style.setProperty("--mono-size", `${cfg.fontSize}px`);
  window.dispatchEvent(new CustomEvent("x-term-config"));
}

/** Set the palette vars on :root (live preview uses it too, then `applyConfig()` restores the saved state). */
export function paintColors(m: Record<string, string>) {
  for (const [v] of COLOR_VARS) document.documentElement.style.setProperty(v, m[v] ?? "");
}
/** Current value of a palette var (overrides applied). */
export const cssVar = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function toggleTheme() {
  const base = (lsGet(THEME_KEY, "null")?.base as string | undefined) ?? cfg.theme; // what the file says
  cfg.theme = cfg.theme === "light" ? "dark" : "light";
  if (cfg.theme === base) localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, JSON.stringify({ value: cfg.theme, base }));
  applyConfig();
}

/** Per-project overrides from `<repo>/.x-term.json` merged over the global file (Rust `config_for`). Only the keys a pane
 *  reads at spawn time matter here: model, effort, permissionMode, runCommand. */
export const projectConfig = (cwd: string) => invoke<Partial<Config>>("load_config", { cwd }).catch(() => ({} as Partial<Config>));
