import { useEffect } from "react";
import { createPortal } from "react-dom";

export type MenuItem = { label: string; key: string; run: () => void };

/** Right-click menu. Each item has a one-letter shortcut usable while the menu is open; Esc / click elsewhere closes. */
export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const it = items.find((i) => i.key === e.key.toLowerCase());
      if (it || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); it?.run(); }
    };
    window.addEventListener("keydown", onKey, true); // capture: beats xterm's key handler
    window.addEventListener("mousedown", onClose);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("mousedown", onClose); };
  }, []);
  return createPortal(
    <ul className="menu" style={{ left: Math.min(x, window.innerWidth - 180), top: Math.min(y, window.innerHeight - items.length * 26 - 8) }}>
      {items.map((i) => <li key={i.key} onMouseDown={(e) => { e.stopPropagation(); onClose(); i.run(); }}>{i.label}<kbd>{i.key}</kbd></li>)}
    </ul>,
    document.body,
  );
}
