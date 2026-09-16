// Pure helpers shared by SessionPane; kept free of React/DOM so `node --test` can check them.
import type { ToolMsg } from "./ToolCard";

export type Img = { media_type: string; data: string };
export type Msg = { role: "user" | "assistant" | "err" | "thinking" | "note"; text: string; images?: Img[]; tokens?: number; ts?: number } | ToolMsg; // note = grey divider (compaction, hints)
export type Hist = { role: string; text: string; id?: string; input?: any; error?: boolean };

/** "claude-opus-4-8[1m]" -> "opus 4.8 [1m]", "claude-haiku-4-5-20251001" -> "haiku 4.5" */
export const modelLabel = (id: string) => id.replace(/^claude-/, "").replace(/-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?$/, (_, a, b, m) => ` ${a}${b ? "." + b : ""}${m ? " " + m : ""}`);

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

/** Composer text with "[Pasted text #N: …]" chips expanded back to their contents. */
export const expandPastes = (input: string, pastes: string[]) => input.replace(/\[Pasted text #(\d+)[^\]]*\]/g, (m, n) => pastes[Number(n) - 1] ?? m).trim();

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
