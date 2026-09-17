// Keyboard shortcuts: one table of actions -> combos, overridable per action via `keys` in config.json
// (e.g. { "keys": { "sidebar": "ctrl+b", "splitRight": "ctrl+shift+e" } }). Matching lives in src/keymatch.ts.
import { cfg } from "./config";
import { matches, comboLabel } from "./keymatch";

export const DEFAULT_KEYS = {
  splitRight: "alt+[", splitBelow: "alt+]", chatRight: "alt+shift+[", chatBelow: "alt+shift+]",
  close: "alt+w", maximize: "alt+z", sidebar: "ctrl+shift+b", help: "f1", help2: "ctrl+/", // sidebar not ctrl+b: that is tmux's prefix / readline backward-char in the shell
  focusLeft: "alt+arrowleft", focusRight: "alt+arrowright", focusUp: "alt+arrowup", focusDown: "alt+arrowdown",
  moveLeft: "alt+shift+arrowleft", moveRight: "alt+shift+arrowright", moveUp: "alt+shift+arrowup", moveDown: "alt+shift+arrowdown",
  shrinkW: "ctrl+alt+arrowleft", growW: "ctrl+alt+arrowright", shrinkH: "ctrl+alt+arrowup", growH: "ctrl+alt+arrowdown",
  jumpPerm: "alt+p", jumpUnread: "alt+u", theme: "ctrl+shift+l", rename: "f2", config: "ctrl+,",
  zoomIn: "ctrl+=", zoomOut: "ctrl+-", zoomReset: "ctrl+0",
  // chat pane
  find: "ctrl+f", changes: "ctrl+shift+d", focusComposer: "ctrl+l", retry: "ctrl+r", thread: "ctrl+shift+t", mark: "ctrl+shift+m",
  clear: "ctrl+shift+k", run: "ctrl+shift+r", prevMsg: "alt+pageup", nextMsg: "alt+pagedown", scrollUp: "shift+pageup", scrollDown: "shift+pagedown",
  // shell pane
  agentMode: "ctrl+a", termSearch: "ctrl+shift+f", termCopy: "ctrl+shift+c", termPaste: "ctrl+shift+v",
};
export type Action = keyof typeof DEFAULT_KEYS;
/** One line per action for the shortcuts dialog; "(shell)" / "(chat)" = where it applies. */
export const DESC: Record<Action, string> = {
  splitRight: "split: new terminal to the right", splitBelow: "split: new terminal below", chatRight: "split: new claude chat to the right", chatBelow: "split: new claude chat below",
  close: "close pane", maximize: "maximize / restore pane", sidebar: "sidebar: open panes, worktrees, sessions", help: "shortcut help", help2: "shortcut help (works in the shell too)",
  focusLeft: "focus pane left", focusRight: "focus pane right", focusUp: "focus pane up", focusDown: "focus pane down",
  moveLeft: "move pane left", moveRight: "move pane right", moveUp: "move pane up", moveDown: "move pane down",
  shrinkW: "pane narrower", growW: "pane wider", shrinkH: "pane shorter", growH: "pane taller",
  jumpPerm: "next pane waiting for permission", jumpUnread: "next pane with an unread answer", theme: "toggle dark / light", rename: "rename pane", config: "settings (config, shortcuts, appearance)",
  zoomIn: "zoom in", zoomOut: "zoom out", zoomReset: "zoom reset",
  find: "(chat) find in conversation", changes: "(chat) changes: git diff of the repo", focusComposer: "(chat) focus composer", retry: "(chat) retry last prompt", thread: "(chat) thread from selected text", mark: "(chat) mark (bookmark) selected text",
  clear: "(chat) /clear", run: "(chat) run config runCommand in the shell", prevMsg: "(chat) previous user message", nextMsg: "(chat) next user message", scrollUp: "(chat) scroll up", scrollDown: "(chat) scroll down",
  agentMode: "(shell) switch to agent mode", termSearch: "(shell) search scrollback", termCopy: "(shell) copy selection", termPaste: "(shell) paste",
};
/** Actions the window-level handler owns; the shell must not see these even though xterm has focus. */
const APP_ACTIONS: Action[] = ["splitRight", "splitBelow", "chatRight", "chatBelow", "close", "maximize", "sidebar", "help", "help2",
  "focusLeft", "focusRight", "focusUp", "focusDown", "moveLeft", "moveRight", "moveUp", "moveDown", "shrinkW", "growW", "shrinkH", "growH",
  "jumpPerm", "jumpUnread", "theme", "rename", "config", "zoomIn", "zoomOut", "zoomReset"];

export const combo = (a: Action) => cfg.keys?.[a] || DEFAULT_KEYS[a];
export const label = (a: Action) => comboLabel(combo(a));
export const is = (e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string; key: string }, a: Action) => matches(e, combo(a));
/** Of those, the ones the shell must never see. F1/F2 stay with the shell (htop, mc …) and zoom chords are harmless to double up. */
const TERM_BLOCK: Action[] = APP_ACTIONS.filter((a) => !["help", "rename", "zoomIn", "zoomOut", "zoomReset"].includes(a));
/** True when the event belongs to a window-level action (or Alt+digit pane focus): xterm must not consume it. */
export const isAppKey = (e: KeyboardEvent) => (e.altKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) || TERM_BLOCK.some((a) => is(e, a));
