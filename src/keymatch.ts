// Pure combo parsing / matching (no imports, so `node --test` can check it). See src/keys.ts for the action table.
// Letters, digits and punctuation match on KeyboardEvent.code so a Korean (or any non-US) layout does not change
// what Alt+B or Ctrl+[ mean; named keys (arrows, F1, PageUp …) match on `key`.
const CODES: Record<string, string> = { "[": "BracketLeft", "]": "BracketRight", "=": "Equal", "+": "Equal", "-": "Minus", ",": "Comma", ".": "Period", "/": "Slash", "\\": "Backslash", ";": "Semicolon", "'": "Quote", "`": "Backquote", space: "Space" };
export type Combo = { ctrl: boolean; alt: boolean; shift: boolean; code?: string; key?: string };
export type KeyLike = { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string; key: string };
const cache = new Map<string, Combo | null>();

export function parseCombo(s: string): Combo | null {
  if (cache.has(s)) return cache.get(s)!;
  const parts = s.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const k = parts.pop();
  const c: Combo = { ctrl: parts.includes("ctrl"), alt: parts.includes("alt"), shift: parts.includes("shift") };
  const MODS = ["ctrl", "alt", "shift", "meta"];
  if (!k || MODS.includes(k) || parts.some((p) => !MODS.includes(p))) { cache.set(s, null); return null; }
  if (/^[a-z]$/.test(k)) c.code = `Key${k.toUpperCase()}`;
  else if (/^[0-9]$/.test(k)) c.code = `Digit${k}`;
  else if (CODES[k]) c.code = CODES[k];
  else c.key = k; // arrowleft, pageup, f1, enter, escape, tab …
  cache.set(s, c);
  return c;
}

export function matches(e: KeyLike, combo: string): boolean {
  const c = parseCombo(combo);
  if (!c || e.ctrlKey !== c.ctrl || e.altKey !== c.alt || e.shiftKey !== c.shift) return false;
  return c.code ? e.code === c.code : e.key.toLowerCase() === c.key;
}

const REV: Record<string, string> = Object.fromEntries(Object.entries(CODES).filter(([k]) => k !== "+").map(([k, v]) => [v, k]));
const MOD_KEYS = new Set(["control", "alt", "shift", "meta", "altgraph", "capslock"]);
/** A pressed key as a combo string for the shortcuts dialog, or null when it is only a modifier or a bare printable
 *  key (typing must never become a shortcut). Named keys (F2, PageUp …) are fine without modifiers. */
export function comboFromEvent(e: KeyLike): string | null {
  const k = e.key.toLowerCase();
  if (MOD_KEYS.has(k)) return null;
  let name: string;
  if (/^Key[A-Z]$/.test(e.code)) name = e.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(e.code)) name = e.code.slice(5);
  else if (REV[e.code]) name = REV[e.code];
  else if (k === " ") name = "space";
  else name = k; // arrowleft, pageup, f1, enter, escape, tab, delete …
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean) as string[];
  const named = name.length > 1 && name !== "space";
  if (!mods.length && (!named || ["enter", "tab", "backspace", "delete", "escape"].includes(name) || /^arrow/.test(name))) return null;
  return [...mods, name].join("+");
}

const NAMES: Record<string, string> = { pageup: "PgUp", pagedown: "PgDn", escape: "Esc", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", space: "Space" };
/** Human label for the help overlay: "ctrl+shift+d" -> "Ctrl+Shift+D", "alt+arrowleft" -> "Alt+←". */
export const comboLabel = (s: string) => s.split("+").map((p) => NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p.replace(/^\w/, (x) => x.toUpperCase()))).join("+");
