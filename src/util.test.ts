import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLabel, toMsgs, fmtTok, pickAgentModel, diffLines, diffStat, mdBlocks, hex2hsv, hsv2hex, mcpGroups, mcpLabel, mcpToolName, mcpAnnotations, type McpServer } from "./util.ts";

test("modelLabel", () => {
  assert.equal(modelLabel("claude-opus-4-8[1m]"), "opus 4.8 [1m]");
  assert.equal(modelLabel("claude-haiku-4-5-20251001"), "haiku 4.5");
  assert.equal(modelLabel("claude-sonnet-5"), "sonnet 5");
});
test("toMsgs folds tool results into cards", () => {
  const m = toMsgs([{ role: "user", text: "hi" }, { role: "tool", text: "Bash", id: "t1", input: { command: "ls" } }, { role: "tool_result", text: "a\nb", id: "t1", error: false }]);
  assert.equal(m.length, 2);
  assert.deepEqual(m[1], { role: "tool", id: "t1", name: "Bash", input: { command: "ls" }, text: "Bash", result: "a\nb", error: false });
});
test("fmtTok", () => { assert.equal(fmtTok(999), "999"); assert.equal(fmtTok(1500), "1.5k"); assert.equal(fmtTok(12345), "12k"); });

test("pickAgentModel", () => {
  const models = { light: { model: "h", effort: "low" }, standard: { model: "s", effort: "medium" }, heavy: { model: "o", effort: "high" } };
  assert.equal(pickAgentModel({ prompt: "where is foo defined" }, models).model, "h"); // short lookup
  assert.equal(pickAgentModel({ prompt: "x".repeat(600) }, models).model, "s");
  assert.equal(pickAgentModel({ prompt: "x".repeat(1400) }, models).model, "o"); // long brief
  assert.equal(pickAgentModel({ prompt: "short", worktree: "feat" }, models).model, "o"); // owns a branch
  assert.equal(pickAgentModel({ prompt: "x".repeat(1400), weight: "light" }, models).model, "h"); // explicit weight wins
  assert.equal(pickAgentModel({ prompt: "short", weight: "bogus" }, models).weight, "light"); // unknown weight falls back to inference
  assert.deepEqual(pickAgentModel({ prompt: "short", model: "m", effort: "max" }, models), { weight: "light", model: "m", effort: "max" });
});

test("diffLines numbers the new side", () => {
  const d = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +10,3 @@\n a\n-b\n+c\n+d\n";
  const r = diffLines(d);
  assert.equal(r[0].file, "x.ts");
  assert.deepEqual(r.slice(4, 8).map((x) => [x.cls, x.line]), [["", 10], ["del", undefined], ["add", 11], ["add", 12]]);
  assert.deepEqual(diffStat(d), { add: 2, del: 1 });
});

test("mdBlocks splits at blank lines, keeps fences whole", () => {
  assert.deepEqual(mdBlocks("a\n\nb\nc\n\n```\nx\n\ny\n```\n\nd"), ["a", "b\nc", "```\nx\n\ny\n```", "d"]);
  assert.deepEqual(mdBlocks(""), []);
});

test("hex <-> hsv round trip", () => {
  assert.deepEqual(hex2hsv("#ff0000"), [0, 1, 1]);
  assert.deepEqual(hex2hsv("#00ff00"), [120, 1, 1]);
  assert.equal(hsv2hex(240, 1, 1), "#0000ff");
  for (const h of ["#3b6ea5", "#1e1e1e", "#d7af00", "#fafafa", "#000000"]) assert.equal(hsv2hex(...hex2hsv(h)), h);
});
test("mcp groups, labels, tool names", () => {
  const list: McpServer[] = [
    { name: "x-term", status: "connected" },
    { name: "serena", status: "connected", scope: "user", tools: [{ name: "find_symbol", annotations: { readOnly: true } }] },
    { name: "claude.ai Gmail", status: "pending", scope: "claudeai" },
    { name: "headroom", status: "failed", scope: "user", error: "boom" },
    { name: "plugin:design:figma", status: "needs-auth", source: "plugin" },
    { name: "plugin:data:snowflake", status: "failed", source: "plugin" },
    { name: "plugin:context7:context7", status: "disabled", source: "plugin" },
  ];
  const g = mcpGroups(list);
  assert.deepEqual(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((s) => s.name)])), {
    active: ["serena", "claude.ai Gmail"], attention: ["headroom"], off: ["plugin:context7:context7"], signin: ["plugin:design:figma"], unavailable: ["plugin:data:snowflake"],
  });
  assert.deepEqual(mcpLabel(list[4]), { name: "figma", tag: "design" });
  assert.deepEqual(mcpLabel(list[2]), { name: "Gmail", tag: "claude.ai" });
  assert.deepEqual(mcpLabel(list[1]), { name: "serena", tag: "user" });
  assert.equal(mcpToolName("claude.ai Gmail", "search_threads"), "mcp__claude_ai_Gmail__search_threads");
  assert.equal(mcpToolName("plugin:context7:context7", "query-docs"), "mcp__plugin_context7_context7__query-docs");
  assert.deepEqual(mcpAnnotations(list, "mcp__serena__find_symbol"), { readOnly: true });
});
