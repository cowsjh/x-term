import { useState } from "react";
import { diffLines } from "diff";

export type SubStep = { name?: string; text: string }; // sub-agent (Agent/Task) activity, keyed by parent_tool_use_id
export type ToolMsg = { role: "tool"; id: string; name: string; input: any; result?: string; error?: boolean; text: string; sub?: SubStep[] };
/** mcp__server__tool -> "server › tool" */
export const toolLabel = (name: string) => (name.startsWith("mcp__") ? name.slice(5).replace(/__/, " › ") : name);
const STATUS = { pending: "☐", in_progress: "◐", completed: "☑" } as Record<string, string>;

function summary(input: any): string {
  if (typeof input?.command === "string") return input.command;
  if (Array.isArray(input?.todos)) return `${input.todos.length} todos, ${input.todos.filter((t: any) => t.status === "completed").length} done`;
  if (typeof input?.subject === "string") return input.subject;
  if (typeof input?.taskId === "string") return `#${input.taskId} ${input.status ?? ""}`;
  if (typeof input?.file_path === "string") return input.file_path;
  if (typeof input?.pattern === "string") return input.pattern;
  if (typeof input?.description === "string") return input.description;
  const j = JSON.stringify(input ?? {});
  return j === "{}" ? "" : j.slice(0, 120);
}

/** Line diff for Edit / Write / MultiEdit inputs; null for other tools. */
function Diff({ name, input }: { name: string; input: any }) {
  const pairs: [string, string][] =
    name === "Edit" ? [[input.old_string ?? "", input.new_string ?? ""]]
    : name === "Write" ? [["", input.content ?? ""]]
    : name === "MultiEdit" ? (input.edits ?? []).map((e: any) => [e.old_string ?? "", e.new_string ?? ""])
    : [];
  if (!pairs.length) return null;
  return (
    <div className="diff">
      {pairs.map(([a, b], i) =>
        diffLines(a, b).map((part, j) => (
          <pre key={`${i}-${j}`} className={part.added ? "add" : part.removed ? "del" : ""}>
            {part.value.replace(/\n$/, "").split("\n").map((l) => (part.added ? "+ " : part.removed ? "- " : "  ") + l).join("\n")}
          </pre>
        )),
      )}
    </div>
  );
}

export function ToolCard({ m }: { m: ToolMsg }) {
  const [open, setOpen] = useState(false);
  const lines = (m.result ?? "").split("\n").length;
  return (
    <div className={`msg tool ${m.error ? "error" : ""}`} onClick={() => setOpen((o) => !o)}>
      <div className="tool-hdr">{open ? "▾" : "▸"} <b>{toolLabel(m.name)}</b> <span className="tool-sum">{summary(m.input).split("\n")[0].slice(0, 100)}</span>
        <span className="tool-meta">{m.sub?.length ? `${m.sub.length} steps · ` : ""}{m.result === undefined ? "…" : m.error ? "error" : m.result ? `${lines} lines` : ""}</span></div>
      {open && (
        <div onClick={(e) => e.stopPropagation()}>
          <Diff name={m.name} input={m.input} />
          {Array.isArray(m.input?.todos) && <ul className="todos">{m.input.todos.map((t: any, i: number) => <li key={i} className={t.status}>{STATUS[t.status] ?? "☐"} {t.content}</li>)}</ul>}
          {!["Edit", "Write", "MultiEdit", "TodoWrite"].includes(m.name) && <pre className="tool-in">{JSON.stringify(m.input, null, 2)}</pre>}
          {m.sub?.length ? <div className="tool-sub">{m.sub.map((s, i) => <div key={i}>{s.name ? <b>{toolLabel(s.name)}</b> : null} {s.text.split("\n")[0].slice(0, 160)}</div>)}</div> : null}
          {m.result !== undefined && <pre className="tool-res full">{m.result}</pre>}
        </div>
      )}
    </div>
  );
}
