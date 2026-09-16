import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLabel, toMsgs, expandPastes, fmtTok, pickAgentModel } from "./util.ts";

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
test("expandPastes", () => {
  assert.equal(expandPastes("see [Pasted text #1: 9 lines] and [Pasted text #2: 3 lines] ", ["A", "B"]), "see A and B");
  assert.equal(expandPastes("[Pasted text #7: 1 lines]", []), "[Pasted text #7: 1 lines]");
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
