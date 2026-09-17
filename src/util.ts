// Pure helpers shared by SessionPane; kept free of React/DOM so `node --test` can check them.
import type { ToolMsg } from "./ToolCard";

export type Img = { media_type: string; data: string };
export type Msg = { role: "user" | "assistant" | "err" | "thinking" | "note"; text: string; images?: Img[]; tokens?: number; ts?: number } | ToolMsg; // note = grey divider (compaction, hints)
export const MODES = ["auto", "acceptEdits", "manual", "plan", "bypassPermissions", "dontAsk"];
// "" = CLI default. Before the first message these restart the process with --model/--effort; after, they are sent as /model and /effort.
// Full ids: the CLI rejects short forms like `opus-4-8[1m]`; `[1m]` = 1M context variant.
export const MODELS = ["claude-fable-5-1", "claude-fable-5-1[1m]", "claude-opus-5", "claude-opus-5[1m]", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-5[1m]", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export type Hist = { role: string; text: string; id?: string; input?: any; error?: boolean };

/** "claude-opus-4-8[1m]" -> "opus 4.8 [1m]", "claude-haiku-4-5-20251001" -> "haiku 4.5" */
export const modelLabel = (id: string) => id.replace(/^claude-/, "").replace(/-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?$/, (_, a, b, m) => ` ${a}${b ? "." + b : ""}${m ? " " + m : ""}`);

/** localStorage JSON read; a corrupted value falls back instead of throwing on mount. */
export const lsGet = (key: string, fallback: string) => { try { return JSON.parse(localStorage.getItem(key) ?? fallback); } catch { return JSON.parse(fallback); } };

/** Top-level markdown blocks split at blank lines (fences kept whole). Streaming renders each block separately so finished
 *  ones are never re-parsed; loose lists / reference links spanning blocks look off only until the turn ends. */
export function mdBlocks(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [], fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && line.trim() === "" && cur.length) { out.push(cur.join("\n")); cur = []; continue; }
    cur.push(line);
  }
  if (cur.some((l) => l.trim())) out.push(cur.join("\n"));
  return out;
}

export const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
export const fmtSec = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;

/** Stored transcript rows -> message list; tool_result rows fold into their tool card. */
export const toMsgs = (hist: Hist[]): Msg[] => {
  const out: Msg[] = [];
  for (const h of hist) {
    if (h.role === "tool_result") {
      const t = out.find((m) => m.role === "tool" && m.id === h.id) as ToolMsg | undefined;
      if (t) { t.result = h.text; t.error = !!h.error; }
    } else if (h.role === "tool") out.push({ role: "tool", id: h.id ?? crypto.randomUUID(), name: h.text, input: h.input ?? {}, text: h.text });
    else out.push({ role: h.role as "user" | "assistant", text: h.text });
  }
  return out;
};

/** A composer chip: `text` is what the model gets (appended after the typed text), `label` what the user sees. */
export type Paste = { text: string; label: string };

/** Text handed to a pane's chat from outside it (shell selection / output, chat selection). `ask` = quote it in the composer;
 *  otherwise it becomes a context chip. Queued per pane id and drained by the chat on mount and on "x-term-context", so it
 *  survives the chat not existing yet (terminal-only pane switching to agent mode). */
export type CtxItem = { text: string; label: string; ask?: boolean };
const ctxQueue = new Map<string, CtxItem[]>();
export const takeContext = (id: string) => { const q = ctxQueue.get(id) ?? []; ctxQueue.delete(id); return q; };
export function pushContext(id: string, item: CtxItem) {
  ctxQueue.set(id, [...(ctxQueue.get(id) ?? []), item]);
  document.querySelector(`.pane-root[data-id="${id}"]`)?.dispatchEvent(new CustomEvent("x-term-context"));
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export type AgentSpec = { prompt?: string; worktree?: string; weight?: string; model?: string; effort?: string };
/** Model + effort for a spawned pane: explicit model/effort win, then `weight`, then a guess from the task itself. */
export function pickAgentModel(ag: AgentSpec, models: Record<string, { model: string; effort: string }>) {
  const weight = ag.weight && models[ag.weight] ? ag.weight
    : ag.worktree || (ag.prompt ?? "").length > 1200 ? "heavy" // owns a branch, or a long brief: real work
    : (ag.prompt ?? "").length < 300 ? "light" // a lookup or a one-liner
    : "standard";
  const pick = models[weight] ?? models.standard;
  return { weight, model: ag.model || pick.model, effort: ag.effort || pick.effort };
}

// Unified diff → one row per line with the file and new-side line number (del/hunk/header rows have no line)
export type DiffRow = { t: string; cls: "add" | "del" | "hunk" | "file" | ""; file?: string; line?: number };
export function diffLines(diff: string): DiffRow[] {
  let file: string | undefined, n = 0;
  return diff.split("\n").map((t) => {
    if (t.startsWith("diff ")) { file = t.match(/ b\/(.*)$/)?.[1]; return { t, cls: "file", file }; }
    if (t.startsWith("+++") || t.startsWith("---")) return { t, cls: "" };
    if (t.startsWith("@@")) { n = Number(t.match(/\+(\d+)/)?.[1] ?? 1); return { t, cls: "hunk", file }; }
    if (t.startsWith("-")) return { t, cls: "del", file };
    if (t.startsWith("\\")) return { t, cls: "" }; // "\ No newline at end of file"
    return { t, cls: t.startsWith("+") ? "add" : "", file, line: n++ };
  });
}
export const diffStat = (diff: string) => diff.split("\n").reduce((s, l) => ({ add: s.add + Number(l.startsWith("+") && !l.startsWith("+++")), del: s.del + Number(l.startsWith("-") && !l.startsWith("---")) }), { add: 0, del: 0 });

/** #rrggbb -> [hue 0-360, sat 0-1, val 0-1] and back (Settings colour wheel). */
export function hex2hsv(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max : 0, max];
}
export function hsv2hex(h: number, s: number, v: number) {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return "#" + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}
