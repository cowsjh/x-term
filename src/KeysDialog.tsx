import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cfg } from "./config";
import { DEFAULT_KEYS, DESC, Action } from "./keys";
import { comboFromEvent, comboLabel, parseCombo } from "./keymatch";

const ACTIONS = Object.keys(DEFAULT_KEYS) as Action[];

/** Shortcut editor (titlebar ⌨ button). Click a combo, press the new keys; Save writes `keys` into config.json, which the
 *  Rust watcher reloads live. Only overrides that differ from the defaults are stored. */
export function KeysDialog({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<Record<string, string>>(() => ({ ...cfg.keys }));
  const [rec, setRec] = useState<Action | null>(null); // action currently being re-bound
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const cur = (a: Action) => keys[a] || DEFAULT_KEYS[a];
  const dupes = useMemo(() => { // combo -> actions using it (conflicts shown in red; Alt+1..9 is a fixed chord)
    const m = new Map<string, Action[]>();
    for (const a of ACTIONS) m.set(cur(a), [...(m.get(cur(a)) ?? []), a]);
    return m;
  }, [keys]);
  const dirty = useMemo(() => JSON.stringify(keys) !== JSON.stringify(cfg.keys), [keys]);
  useEffect(() => {
    // capture phase + stopPropagation: while recording, nothing else in the app may react to the pressed keys
    const h = (e: KeyboardEvent) => {
      if (!rec) { if (e.key === "Escape") { e.stopPropagation(); onClose(); } return; }
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRec(null); return; }
      const c = comboFromEvent(e);
      if (!c) return; // modifier only, or a bare letter: keep waiting
      setKeys((k) => (c === DEFAULT_KEYS[rec] ? Object.fromEntries(Object.entries(k).filter(([x]) => x !== rec)) : { ...k, [rec]: c }));
      setRec(null);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [rec]);
  const reset = (a: Action) => setKeys((k) => Object.fromEntries(Object.entries(k).filter(([x]) => x !== a)));
  const save = async () => {
    const bad = ACTIONS.find((a) => !parseCombo(cur(a)));
    if (bad) return setErr(`${bad}: cannot parse "${cur(bad)}"`);
    setSaving(true); setErr("");
    // null = delete the override from the file
    const patch: Record<string, string | null> = {};
    for (const a of ACTIONS) patch[a] = keys[a] && keys[a] !== DEFAULT_KEYS[a] ? keys[a] : null;
    await invoke("save_config_patch", { patch: { keys: patch } }).then(onClose).catch((e) => setErr(String(e)));
    setSaving(false);
  };
  return (
    <div className="help" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="keys-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h3>shortcuts <span className="dim">· click a key, press the new combination · Esc cancels · Alt+1…9 focus panes and cannot change</span></h3>
        <div className="keys-list">
          <table><tbody>
            {ACTIONS.map((x) => {
              const conflict = (dupes.get(cur(x))?.length ?? 0) > 1;
              return (
                <tr key={x} className={rec === x ? "rec" : ""}>
                  <td className="d">{DESC[x]}</td>
                  <td className={`k ${conflict ? "conflict" : ""} ${keys[x] ? "custom" : ""}`} title={conflict ? `also used by: ${dupes.get(cur(x))!.filter((y) => y !== x).join(", ")}` : x} onClick={() => setRec(rec === x ? null : x)}>
                    {rec === x ? "press keys…" : comboLabel(cur(x))}
                  </td>
                  <td className="r">{keys[x] && <button onClick={() => reset(x)} title={`default: ${comboLabel(DEFAULT_KEYS[x])}`}>reset</button>}</td>
                </tr>
              );
            })}
          </tbody></table>
        </div>
        {err && <div className="keys-err">{err}</div>}
        <div className="keys-acts">
          <span className="dim">{[...dupes.values()].some((v) => v.length > 1) ? "⚠ conflicting combos are red: the first action in the list wins" : "stored in ~/.config/x-term/config.json → keys"}</span>
          <button onClick={() => setKeys({})} disabled={!Object.keys(keys).length}>reset all</button>
          <button onClick={onClose}>cancel</button>
          <button className="primary" onClick={save} disabled={!dirty || saving}>save</button>
        </div>
      </div>
    </div>
  );
}
