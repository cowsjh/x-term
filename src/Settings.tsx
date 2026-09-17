import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cfg, DEFAULTS, Config, COLOR_VARS, THEMES, applyConfig, paintColors } from "./config";
import { KeysDialog } from "./KeysDialog";
import { MODES, MODELS, EFFORTS, hex2hsv, hsv2hex } from "./util";

export type Tab = "config" | "keys" | "appearance";
/** Status line under a tab's form: "saved" for 1.5 s, or an error until the next save. */
export function useStatus(): [string, (msg: string, err?: boolean) => void] {
  const [st, setSt] = useState("");
  return [st, (msg, err) => { setSt(msg); if (!err) setTimeout(() => setSt((x) => (x === msg ? "" : x)), 1500); }];
}
const TABS: Tab[] = ["config", "keys", "appearance"];

/** Titlebar ⚙: config form, shortcut editor, palette editor. Every tab writes config.json via `save_config_patch`;
 *  the Rust watcher reloads it live. Closing (Esc / backdrop / cancel) repaints from the saved state, so previews never stick. */
export function Settings({ tab: initial, onClose: close }: { tab: Tab; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(initial);
  const onClose = () => { applyConfig(); close(); };
  useEffect(() => { // KeysDialog owns Escape on its own tab (it also cancels a recording)
    if (tab === "keys") return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [tab]);
  return (
    <div className="help" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="keys-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
        {tab === "config" && <ConfigTab onClose={onClose} />}
        {tab === "keys" && <KeysDialog onClose={onClose} />}
        {tab === "appearance" && <AppearanceTab onClose={onClose} />}
      </div>
    </div>
  );
}

// Scalar config keys with a form control; the rest (claudeArgs, agentModels, shell …) stay in the file.
type Field = { k: keyof Config; opts?: readonly string[]; type?: "number" | "bool"; hint?: string };
const FIELDS: Field[] = [
  { k: "model", opts: MODELS },
  { k: "effort", opts: EFFORTS },
  { k: "permissionMode", opts: MODES },
  { k: "scrollback", type: "number", hint: "terminal lines" },
  { k: "sendKey", opts: ["enter", "ctrl+enter"], hint: "which key sends a chat message" },
  { k: "notify", opts: ["all", "permission", "none"], hint: "desktop notifications" },
  { k: "confirmQuit", type: "bool", hint: "ask before quitting with a running turn" },
  { k: "restoreLayout", type: "bool", hint: "reopen last panes on start" },
  { k: "runCommand", hint: "Ctrl+Shift+R runs this in the pane's shell" },
];
function ConfigTab({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState<Record<string, any>>(() => Object.fromEntries(FIELDS.map((f) => [f.k, cfg[f.k]])));
  const [st, status] = useStatus();
  const [, bump] = useState(0); // cfg is mutated in place on save; re-render so `dirty` clears
  const dirty = FIELDS.some((f) => v[f.k] !== cfg[f.k]);
  const set = (k: string, x: any) => setV((o) => ({ ...o, [k]: x }));
  const save = async () => {
    const patch: Record<string, any> = {};
    for (const f of FIELDS) if (v[f.k] !== cfg[f.k]) patch[f.k] = v[f.k] === DEFAULTS[f.k] ? null : v[f.k]; // default -> drop the key
    await invoke("save_config_patch", { patch }).then(() => { Object.assign(cfg, v); localStorage.removeItem("x-term.theme"); applyConfig(); bump((x) => x + 1); status("saved"); }).catch((e) => status(String(e), true));
  };
  return (
    <>
      <div className="cfg-form">
        {FIELDS.map((f) => (
          <FieldRow key={f.k} f={f}>
            {f.opts ? <select value={v[f.k]} onChange={(e) => set(f.k, e.target.value)}>{f.opts.map((o) => <option key={o}>{o}</option>)}</select>
              : f.type === "bool" ? <input type="checkbox" checked={!!v[f.k]} onChange={(e) => set(f.k, e.target.checked)} />
              : f.type === "number" ? <input type="number" value={v[f.k]} onChange={(e) => set(f.k, Number(e.target.value))} />
              : <input type="text" value={v[f.k]} onChange={(e) => set(f.k, e.target.value)} />}
          </FieldRow>
        ))}
      </div>
      {st && <div className={st === "saved" ? "keys-ok" : "keys-err"}>{st}</div>}
      <div className="keys-acts">
        <span className="dim">~/.config/x-term/config.json · other keys (claudeArgs, agentModels, shell, exportDir, worktreeDir, autocompact) are edited in the file</span>
        <button onClick={() => invoke<string>("open_config").catch((e) => status(String(e), true))}>open config.json</button>
        <button onClick={onClose}>close</button>
        <button className="primary" onClick={save} disabled={!dirty}>save</button>
      </div>
    </>
  );
}
const FieldRow = ({ f, children }: { f: Field; children: React.ReactNode }) => <><label title={f.hint}>{f.k}</label>{children}</>;

/** Palette editor: one row per CSS var, native colour picker, live preview, per-colour reset. Overrides for the theme being
 *  edited are saved under `colors.<theme>`; the base values come from THEMES. */
function AppearanceTab({ onClose }: { onClose: () => void }) {
  const theme = cfg.theme;
  const base = THEMES[theme].colors;
  const [over, setOver] = useState<Record<string, string>>(() => ({ ...(cfg.colors[theme] ?? {}) }));
  const [st, status] = useStatus();
  const [wheel, setWheel] = useState(() => localStorage.getItem("x-term.picker") !== "system"); // swatch opens the hue wheel instead of the OS picker
  const [pop, setPop] = useState<{ v: string; x: number; y: number } | null>(null); // open wheel popover: var + anchor
  const [font, setFont] = useState({ fontFamily: cfg.fontFamily, fontSize: cfg.fontSize, textFontFamily: cfg.textFontFamily, textFontSize: cfg.textFontSize });
  const [themeDirty, setThemeDirty] = useState(false); // select switches live; save writes it to the file
  const fontDirty = (Object.keys(font) as (keyof typeof font)[]).some((k) => font[k] !== cfg[k]);
  const cur = (v: string) => over[v] ?? base[v];
  const raf = useRef(0);
  const paint = (o: Record<string, string>) => { // live preview; terminals repaint on x-term-config (one per frame while dragging the wheel)
    setOver(o); paintColors({ ...base, ...o });
    cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("x-term-config")));
  };
  const set = (v: string, hex: string) => paint(hex.toLowerCase() === base[v] ? Object.fromEntries(Object.entries(over).filter(([k]) => k !== v)) : { ...over, [v]: hex.toLowerCase() });
  const dirty = themeDirty || fontDirty || JSON.stringify(over) !== JSON.stringify(cfg.colors[theme] ?? {});
  const save = async () => {
    const colors = { ...cfg.colors, [theme]: over };
    if (!Object.keys(over).length) delete colors[theme];
    const patch = { colors: Object.keys(colors).length ? colors : null, theme: theme === DEFAULTS.theme ? null : theme, ...Object.fromEntries((Object.keys(font) as (keyof typeof font)[]).map((k) => [k, font[k] === DEFAULTS[k] ? null : font[k]])) };
    await invoke("save_config_patch", { patch }).then(() => {
      cfg.colors = colors; Object.assign(cfg, font); localStorage.removeItem("x-term.theme"); setThemeDirty(false); applyConfig(); setOver({ ...over }); status("saved");
    }).catch((e) => status(String(e), true));
  };
  return (
    <>
      <div className="cfg-form" style={{ flex: "none" }}>
        <label>theme</label><select value={theme} onChange={(e) => { cfg.theme = e.target.value; localStorage.removeItem("x-term.theme"); applyConfig(); setThemeDirty(true); setOver({ ...(cfg.colors[cfg.theme] ?? {}) }); }}>{Object.keys(THEMES).map((n) => <option key={n}>{n}</option>)}</select>
        <label title="terminal + code font">fontFamily</label><input type="text" value={font.fontFamily} onChange={(e) => setFont({ ...font, fontFamily: e.target.value })} />
        <label>fontSize</label><input type="number" value={font.fontSize} onChange={(e) => setFont({ ...font, fontSize: Number(e.target.value) })} />
        <label title="chat text font">textFontFamily</label><input type="text" value={font.textFontFamily} onChange={(e) => setFont({ ...font, textFontFamily: e.target.value })} />
        <label>textFontSize</label><input type="number" value={font.textFontSize} onChange={(e) => setFont({ ...font, textFontSize: Number(e.target.value) })} />
      </div>
      <div className="keys-acts">
        <span className="dim">palette for <b>{theme}</b> · changes preview live · stored in config.json → colors.{theme}</span>
        <button onClick={() => { setWheel(!wheel); localStorage.setItem("x-term.picker", wheel ? "native" : "wheel"); setPop(null); }} title="how a swatch click picks a colour">picker: {wheel ? "wheel" : "system"}</button>
      </div>
      <div className="colors">
        {COLOR_VARS.map(([v, d]) => (
          <Row key={v}>
            <span className="v">{v}</span><span className="d">{d}</span>
            {wheel ? <button className="swatch" style={{ background: cur(v) }} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPop(pop?.v === v ? null : { v, x: r.left, y: r.bottom + 4 }); }} title="open the colour wheel" />
              : <input type="color" value={cur(v)} onChange={(e) => set(v, e.target.value)} />}
            <input type="text" value={cur(v)} spellCheck={false} onChange={(e) => /^#[0-9a-f]{6}$/i.test(e.target.value) && set(v, e.target.value)} />
            <button className="reset" disabled={!over[v]} onClick={() => set(v, base[v])} title={`default: ${base[v]}`}>↺ default</button>
          </Row>
        ))}
      </div>
      {pop && (
        <div className="wheel-backdrop" onMouseDown={() => setPop(null)}>
          <div className="wheel-pop" style={{ left: pop.x, top: pop.y }} onMouseDown={(e) => e.stopPropagation()}>
            <Wheel hex={cur(pop.v)} onChange={(h) => set(pop.v, h)} />
          </div>
        </div>
      )}
      {st && <div className={st === "saved" ? "keys-ok" : "keys-err"}>{st}</div>}
      <div className="keys-acts">
        <span className="dim">{Object.keys(over).length} override{Object.keys(over).length === 1 ? "" : "s"}</span>
        <button onClick={() => paint({})} disabled={!Object.keys(over).length}>reset all</button>
        <button onClick={onClose}>close</button>
        <button className="primary" onClick={save} disabled={!dirty}>save</button>
      </div>
    </>
  );
}
const Row = ({ children }: { children: React.ReactNode }) => <>{children}</>;

// ---- hue/saturation wheel + value slider (no lib: CSS conic + radial gradients draw the disc) ----
const R = 80; // wheel radius (px), matches .wheel in app.css
function Wheel({ hex, onChange }: { hex: string; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState(() => hex2hsv(hex)); // own state: 8-bit round trips would make the dot jitter while dragging
  const last = useRef(hex);
  useEffect(() => { if (hex !== last.current) { last.current = hex; setHsv(hex2hsv(hex)); } }, [hex]); // typed hex / reset
  const emit = (h: number, s: number, v: number) => { setHsv([h, s, v]); last.current = hsv2hex(h, s, v); onChange(last.current); };
  const pick = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), dx = e.clientX - r.left - R, dy = e.clientY - r.top - R;
    emit((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360, Math.min(1, Math.hypot(dx, dy) / R), hsv[2]);
  };
  const [h, s, v] = hsv;
  return (
    <>
      <div className="wheel" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pick(e); }} onPointerMove={(e) => e.buttons && pick(e)}>
        <span className="wheel-dot" style={{ left: R + Math.sin(h * Math.PI / 180) * s * R, top: R - Math.cos(h * Math.PI / 180) * s * R, background: hex }} />
      </div>
      <input type="range" min={0} max={360} value={Math.round(h)} title="hue" style={{ background: `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360].map((d) => hsv2hex(d, s, v)).join(", ")})` }} onChange={(e) => emit(+e.target.value, s, v)} />
      <input type="range" min={0} max={100} value={Math.round(s * 100)} title="saturation" style={{ background: `linear-gradient(to right, ${hsv2hex(h, 0, v)}, ${hsv2hex(h, 1, v)})` }} onChange={(e) => emit(h, +e.target.value / 100, v)} />
      <input type="range" min={0} max={100} value={Math.round(v * 100)} title="brightness" style={{ background: `linear-gradient(to right, #000, ${hsv2hex(h, s, 1)})` }} onChange={(e) => emit(h, s, +e.target.value / 100)} />
      <span className="dim wheel-info">{hex} · h {String(Math.round(h)).padStart(3)}° s {String(Math.round(s * 100)).padStart(3)}% v {String(Math.round(v * 100)).padStart(3)}%</span>
    </>
  );
}
