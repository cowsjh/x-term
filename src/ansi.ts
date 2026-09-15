// Minimal ANSI SGR -> HTML: handles 38;5;N (256-color fg), 2 (dim), 1 (bold), 0/39/22 reset. Enough for statusline scripts.
function xterm256(n: number): string {
  if (n < 16) return ["#000","#c00","#0c0","#cc0","#00c","#c0c","#0cc","#ccc","#666","#f44","#4f4","#ff4","#44f","#f4f","#4ff","#fff"][n];
  if (n < 232) { const v = (x: number) => (x ? x * 40 + 55 : 0); n -= 16; return `rgb(${v(Math.floor(n / 36))},${v(Math.floor(n / 6) % 6)},${v(n % 6)})`; }
  const g = (n - 232) * 10 + 8; return `rgb(${g},${g},${g})`;
}
export function ansiToHtml(s: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let out = "", color = "", dim = false, bold = false, open = false;
  const style = () => { const st = [color && `color:${color}`, dim && "opacity:.6", bold && "font-weight:bold"].filter(Boolean).join(";"); return st ? `<span style="${st}">` : ""; };
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!m) { out += esc(part); continue; }
    if (open) { out += "</span>"; open = false; }
    const codes = m[1] ? m[1].split(";").map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { color = ""; dim = bold = false; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) dim = bold = false;
      else if (c === 39) color = "";
      else if (c === 38 && codes[i + 1] === 5) { color = xterm256(codes[i + 2]); i += 2; }
      else if (c >= 30 && c <= 37) color = xterm256(c - 30);
      else if (c >= 90 && c <= 97) color = xterm256(c - 82);
    }
    const o = style(); if (o) { out += o; open = true; }
  }
  return out + (open ? "</span>" : "");
}
