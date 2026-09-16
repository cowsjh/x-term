import test from "node:test";
import assert from "node:assert/strict";
import { parseCombo, matches, comboLabel, comboFromEvent } from "./keymatch.ts";

const ev = (p: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string; key: string }>) => ({ ctrlKey: false, altKey: false, shiftKey: false, code: "", key: "", ...p });

test("letters match on code, so a Korean layout (key = 'ㅠ') still hits alt+b", () => {
  assert.ok(matches(ev({ altKey: true, code: "KeyB", key: "ㅠ" }), "alt+b"));
  assert.ok(!matches(ev({ altKey: true, code: "KeyB", key: "b" }), "ctrl+b"));
  assert.ok(!matches(ev({ altKey: true, shiftKey: true, code: "KeyB", key: "B" }), "alt+b"), "extra modifier must not match");
});

test("punctuation and digits map to codes; shift+[ is alt+shift+[ even though key is '{'", () => {
  assert.ok(matches(ev({ altKey: true, shiftKey: true, code: "BracketLeft", key: "{" }), "alt+shift+["));
  assert.ok(matches(ev({ ctrlKey: true, code: "Equal", key: "=" }), "ctrl+="));
  assert.ok(matches(ev({ ctrlKey: true, code: "Digit0", key: "0" }), "ctrl+0"));
  assert.ok(matches(ev({ ctrlKey: true, code: "Comma", key: "," }), "ctrl+,"));
});

test("named keys match on key, case-insensitively", () => {
  assert.ok(matches(ev({ altKey: true, code: "ArrowLeft", key: "ArrowLeft" }), "alt+arrowleft"));
  assert.ok(matches(ev({ code: "F1", key: "F1" }), "f1"));
  assert.ok(matches(ev({ shiftKey: true, code: "PageUp", key: "PageUp" }), "shift+pageup"));
});

test("bad combos never match", () => {
  assert.equal(parseCombo("super+x"), null);
  assert.equal(parseCombo("ctrl+"), null);
  assert.ok(!matches(ev({ ctrlKey: true, code: "KeyX", key: "x" }), "super+x"));
});

test("labels", () => {
  assert.equal(comboLabel("ctrl+shift+d"), "Ctrl+Shift+D");
  assert.equal(comboLabel("alt+arrowleft"), "Alt+←");
  assert.equal(comboLabel("shift+pageup"), "Shift+PgUp");
  assert.equal(comboLabel("alt+["), "Alt+[");
});

test("comboFromEvent: modifiers alone and bare printable keys are rejected, named keys accepted", () => {
  assert.equal(comboFromEvent(ev({ ctrlKey: true, code: "ControlLeft", key: "Control" })), null);
  assert.equal(comboFromEvent(ev({ code: "KeyB", key: "ㅠ" })), null);
  assert.equal(comboFromEvent(ev({ altKey: true, code: "KeyB", key: "ㅠ" })), "alt+b");
  assert.equal(comboFromEvent(ev({ ctrlKey: true, shiftKey: true, code: "BracketLeft", key: "{" })), "ctrl+shift+[");
  assert.equal(comboFromEvent(ev({ code: "F2", key: "F2" })), "f2");
  assert.equal(comboFromEvent(ev({ code: "Enter", key: "Enter" })), null);
  assert.equal(comboFromEvent(ev({ ctrlKey: true, code: "Space", key: " " })), "ctrl+space");
  assert.equal(comboFromEvent(ev({ shiftKey: true, code: "PageUp", key: "PageUp" })), "shift+pageup");
});
