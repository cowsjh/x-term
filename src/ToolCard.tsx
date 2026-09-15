import { useState } from "react";
import { diffLines } from "diff";

export type ToolMsg = { role: "tool"; id: string; name: string; input: any; result?: string; error?: boolean; text: string };

function summary(input: any): string {
  if (typeof input?.command === "string") return input.command;
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
  const preview = (m.result ?? "").split("\n").slice(0, 2).join("\n").slice(0, 200);
  return (
    <div className={`msg tool ${m.error ? "error" : ""}`} onClick={() => setOpen((o) => !o)}>
      <div className="tool-hdr">{open ? "▾" : "▸"} <b>{m.name}</b> <span className="tool-sum">{summary(m.input)}</span>{m.result === undefined ? " …" : ""}</div>
      {!open && preview && <pre className="tool-res">{preview}{(m.result ?? "").length > preview.length ? " …" : ""}</pre>}
      {open && (
        <div onClick={(e) => e.stopPropagation()}>
          <Diff name={m.name} input={m.input} /> 
          {!["Edit", "Write", "MultiEdit"].includes(m.name) && <pre className="tool-in">{JSON.stringify(m.input, null, 2)}</pre>}
          {m.result !== undefined && <pre className="tool-res full">{m.result}</pre>}
        </div>
      )}
    </div>
  );
}
