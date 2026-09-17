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
  ["--user", "user message"], ["--user-border", "user message border"], ["--user-fg", "user message text"], ["--warn", "warnings, shortcut keys"], ["--err-bg", "error background"],
  ["--h1", "heading 1"], ["--h2", "heading 2"], ["--h3", "heading 3"], ["--h4", "heading 4"], ["--h5", "heading 5"], ["--h6", "heading 6"], ["--bold", "bold text"],
];
const DARK = { "--bg": "#1e1e1e", "--bg0": "#161616", "--bg2": "#262626", "--bg3": "#111111", "--bg4": "#222222", "--fg": "#dddddd", "--fg2": "#cccccc", "--dim": "#888888", "--dim2": "#666666", "--border": "#444444", "--border2": "#333333", "--accent": "#3b6ea5", "--user": "#2a3a55", "--user-border": "#444466", "--warn": "#d7af00", "--err-bg": "#4a2020", "--h1": "#dddddd", "--h2": "#dddddd", "--h3": "#dddddd", "--h4": "#dddddd", "--h5": "#dddddd", "--h6": "#dddddd", "--bold": "#dddddd" };
const LIGHT = { "--bg": "#fafafa", "--bg0": "#e8e8e8", "--bg2": "#f0f0f0", "--bg3": "#ffffff", "--bg4": "#f4f4f4", "--fg": "#222222", "--fg2": "#333333", "--dim": "#666666", "--dim2": "#888888", "--border": "#cccccc", "--border2": "#dddddd", "--accent": "#2b62a0", "--user": "#dce8f8", "--user-border": "#b8cce8", "--warn": "#a07800", "--err-bg": "#f8d8d8", "--h1": "#222222", "--h2": "#222222", "--h3": "#222222", "--h4": "#222222", "--h5": "#222222", "--h6": "#222222", "--bold": "#222222" };

/** Named themes for `theme` in config.json (Settings → appearance → theme); `base` picks the dark/light CSS rules and the
 *  Ctrl+Shift+L toggle target, `colors` the palette that `colors.<theme>` in config.json overrides per var. */
export const THEMES: Record<string, { base: "dark" | "light"; colors: Record<string, string> }> = {
  dark: { base: "dark", colors: DARK },
  light: { base: "light", colors: LIGHT },
  "Minimal Flexoki": { base: "dark", colors: { ...DARK, "--bg": "#100f0f", "--bg0": "#1c1b1a", "--bg2": "#1c1b1a", "--bg3": "#282726", "--bg4": "#343331", "--fg": "#b7b7b7", "--fg2": "#a9a8a2", "--dim": "#878580", "--dim2": "#575653", "--border": "#403e3c", "--border2": "#282726", "--accent": "#78738c", "--user": "#26242f", "--user-border": "#403e3c", "--warn": "#d0a215", "--err-bg": "#3a2320", "--h1": "#dacaa8", "--h2": "#c99b6a", "--h3": "#c2b26a", "--h4": "#8faf8f", "--h5": "#7b9bc6", "--h6": "#a68fc6", "--bold": "#f9f5f5" } },
  "Nord": { base: "dark", colors: { ...DARK, "--bg": "#2e3440", "--bg0": "#272c36", "--bg2": "#3b4252", "--bg3": "#272c36", "--bg4": "#434c5e", "--fg": "#d8dee9", "--fg2": "#e5e9f0", "--dim": "#7b88a1", "--dim2": "#616e88", "--border": "#4c566a", "--border2": "#3b4252", "--accent": "#88c0d0", "--user": "#3b4a5f", "--user-border": "#5e81ac", "--warn": "#ebcb8b", "--err-bg": "#4b3038", "--h1": "#88c0d0", "--h2": "#81a1c1", "--h3": "#8fbcbb", "--h4": "#a3be8c", "--h5": "#b48ead", "--h6": "#d08770", "--bold": "#eceff4" } },
  "Gruvbox": { base: "dark", colors: { ...DARK, "--bg": "#282828", "--bg0": "#1d2021", "--bg2": "#32302f", "--bg3": "#1d2021", "--bg4": "#3c3836", "--fg": "#ebdbb2", "--fg2": "#d5c4a1", "--dim": "#928374", "--dim2": "#665c54", "--border": "#504945", "--border2": "#3c3836", "--accent": "#83a598", "--user": "#3a3f4a", "--user-border": "#504945", "--warn": "#fabd2f", "--err-bg": "#4a2a28", "--h1": "#fb4934", "--h2": "#fe8019", "--h3": "#fabd2f", "--h4": "#b8bb26", "--h5": "#8ec07c", "--h6": "#d3869b", "--bold": "#fbf1c7" } },
  "Catppuccin Mocha": { base: "dark", colors: { ...DARK, "--bg": "#1e1e2e", "--bg0": "#181825", "--bg2": "#313244", "--bg3": "#11111b", "--bg4": "#45475a", "--fg": "#cdd6f4", "--fg2": "#bac2de", "--dim": "#a6adc8", "--dim2": "#6c7086", "--border": "#585b70", "--border2": "#45475a", "--accent": "#89b4fa", "--user": "#2a2b45", "--user-border": "#585b70", "--warn": "#f9e2af", "--err-bg": "#4a2a38", "--h1": "#f5c2e7", "--h2": "#cba6f7", "--h3": "#89b4fa", "--h4": "#94e2d5", "--h5": "#a6e3a1", "--h6": "#fab387", "--bold": "#f5e0dc" } },
  "Solarized Dark": { base: "dark", colors: { ...DARK, "--bg": "#002b36", "--bg0": "#00212b", "--bg2": "#073642", "--bg3": "#00212b", "--bg4": "#0a4050", "--fg": "#93a1a1", "--fg2": "#839496", "--dim": "#657b83", "--dim2": "#586e75", "--border": "#586e75", "--border2": "#073642", "--accent": "#268bd2", "--user": "#0a3a4a", "--user-border": "#2a6b8a", "--warn": "#b58900", "--err-bg": "#4a2a2a", "--h1": "#b58900", "--h2": "#cb4b16", "--h3": "#dc322f", "--h4": "#859900", "--h5": "#2aa198", "--h6": "#6c71c4", "--bold": "#eee8d5" } },
  "Minimal": { base: "light", colors: { ...LIGHT, "--bg": "#ffffff", "--bg0": "#f5f5f5", "--bg2": "#f5f5f5", "--bg3": "#ededed", "--bg4": "#e6e6e6", "--fg": "#0f0f0f", "--fg2": "#333333", "--dim": "#757575", "--dim2": "#b5b5b5", "--border": "#c2c2c2", "--border2": "#e6e6e6", "--accent": "#78738c", "--user": "#eeecf3", "--user-border": "#d6d3e0", "--warn": "#a07800", "--err-bg": "#f8d8d8", "--h1": "#832e2e", "--h2": "#d5763f", "--h3": "#e5b567", "--h4": "#a8c373", "--h5": "#73bbb2", "--h6": "#6c99bb", "--bold": "#0f0f0f" } },
  "Solarized Light": { base: "light", colors: { ...LIGHT, "--bg": "#fdf6e3", "--bg0": "#eee8d5", "--bg2": "#eee8d5", "--bg3": "#f7f0dc", "--bg4": "#e6dfc8", "--fg": "#586e75", "--fg2": "#657b83", "--dim": "#93a1a1", "--dim2": "#b5bcb8", "--border": "#d3cbb7", "--border2": "#e6dfc8", "--accent": "#268bd2", "--user": "#e3ecf3", "--user-border": "#b0c9dd", "--warn": "#b58900", "--err-bg": "#f4d6d0", "--h1": "#b58900", "--h2": "#cb4b16", "--h3": "#dc322f", "--h4": "#859900", "--h5": "#2aa198", "--h6": "#6c71c4", "--bold": "#073642" } },
  "Catppuccin Latte": { base: "light", colors: { ...LIGHT, "--bg": "#eff1f5", "--bg0": "#e6e9ef", "--bg2": "#e6e9ef", "--bg3": "#dce0e8", "--bg4": "#ccd0da", "--fg": "#4c4f69", "--fg2": "#5c5f77", "--dim": "#8c8fa1", "--dim2": "#acb0be", "--border": "#bcc0cc", "--border2": "#ccd0da", "--accent": "#1e66f5", "--user": "#dfe4f4", "--user-border": "#b4bfe0", "--warn": "#df8e1d", "--err-bg": "#f4d3d8", "--h1": "#ea76cb", "--h2": "#8839ef", "--h3": "#1e66f5", "--h4": "#179299", "--h5": "#40a02b", "--h6": "#fe640b", "--bold": "#303446" } },
  "Gruvbox Light": { base: "light", colors: { ...LIGHT, "--bg": "#fbf1c7", "--bg0": "#f2e5bc", "--bg2": "#f2e5bc", "--bg3": "#f9f5d7", "--bg4": "#ebdbb2", "--fg": "#3c3836", "--fg2": "#504945", "--dim": "#7c6f64", "--dim2": "#a89984", "--border": "#bdae93", "--border2": "#d5c4a1", "--accent": "#076678", "--user": "#e8e0c4", "--user-border": "#bdae93", "--warn": "#b57614", "--err-bg": "#f0c8b8", "--h1": "#9d0006", "--h2": "#af3a03", "--h3": "#b57614", "--h4": "#79740e", "--h5": "#427b58", "--h6": "#8f3f71", "--bold": "#282828" } },
};
for (const t of Object.values(THEMES)) t.colors["--user-fg"] ??= t.colors["--fg"]; // user text defaults to the theme's text colour

export const themeBase = (t: string) => (THEMES[t] ?? THEMES.dark).base;

export const DEFAULTS = {
  theme: "dark" as string, // key of THEMES
  model: "claude-opus-5[1m]",
  effort: "high",
  permissionMode: "acceptEdits",
  scrollback: 5000,
  /** Terminal + code font. */
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
  /** Chat text font (markdown, dialogs). */
  textFontFamily: "system-ui, sans-serif",
  textFontSize: 14,
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
const THEME_KEY = "x-term.theme"; // runtime toggle (Ctrl+Shift+L): {value, base}; `base` = the file's theme; dropped as soon as the file's theme changes

function merge(file: Partial<Config>): Config {
  // agentModels merges per weight: a config that only overrides "heavy" must not drop light/standard
  const c: Config = { ...DEFAULTS, ...file, agentModels: { ...DEFAULTS.agentModels, ...(file.agentModels ?? {}) }, keys: { ...(file.keys ?? {}) }, colors: { ...(file.colors ?? {}) } };
  try {
    const t = lsGet(THEME_KEY, "null");
    if (!(c.theme in THEMES)) c.theme = DEFAULTS.theme;
    if (t && t.base === c.theme && t.value in THEMES) c.theme = t.value; else localStorage.removeItem(THEME_KEY);
  } catch { localStorage.removeItem(THEME_KEY); }
  return c;
}

/** Live config object: mutated in place by `applyConfig` so every module sees the new values without re-importing. */
export const cfg: Config = merge(await invoke<Partial<Config>>("load_config", { cwd: null }).catch(() => ({})));

/** Push document-level settings (theme attribute, font variables) and notify listeners (`x-term-config` window event). */
export function applyConfig(file?: Partial<Config>) {
  if (file) Object.assign(cfg, merge(file));
  const root = document.documentElement;
  root.dataset.theme = themeBase(cfg.theme);
  paintColors({ ...THEMES[cfg.theme].colors, ...(cfg.colors[cfg.theme] ?? {}) });
  root.style.setProperty("--mono", cfg.fontFamily);
  root.style.setProperty("--mono-size", `${cfg.fontSize}px`);
  root.style.setProperty("--sans", cfg.textFontFamily);
  root.style.setProperty("--sans-size", `${cfg.textFontSize}px`);
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
  cfg.theme = cfg.theme !== base ? base : themeBase(base) === "light" ? "dark" : "light"; // named theme ⇄ plain opposite base
  if (cfg.theme === base) localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, JSON.stringify({ value: cfg.theme, base }));
  applyConfig();
}

/** Per-project overrides from `<repo>/.x-term.json` merged over the global file (Rust `config_for`). Only the keys a pane
 *  reads at spawn time matter here: model, effort, permissionMode, runCommand. */
export const projectConfig = (cwd: string) => invoke<Partial<Config>>("load_config", { cwd }).catch(() => ({} as Partial<Config>));
