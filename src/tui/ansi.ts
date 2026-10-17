/**
 * ANSI terminal helpers — zero dependencies.
 * Truecolor (24-bit) where supported; falls back gracefully elsewhere.
 */

const ESC = "\x1b[";

/** Convert #rrggbb to [r, g, b]. */
function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const fg = (hex: string): string => {
  const [r, g, b] = hexRgb(hex);
  return `${ESC}38;2;${r};${g};${b}m`;
};

export const bg = (hex: string): string => {
  const [r, g, b] = hexRgb(hex);
  return `${ESC}48;2;${r};${g};${b}m`;
};

export const S = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  inverse: `${ESC}7m`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  clear: `${ESC}2J`,
  home: `${ESC}H`,
  altScreen: `${ESC}?1049h`,
  altScreenOff: `${ESC}?1049l`,
};

/** Zenith palette — dark premium. */
export const P = {
  purple: "#7C5CFF",
  purpleDim: "#5A3EE0",
  teal: "#00E5CC",
  text: "#EDEDF2",
  muted: "#8B8B98",
  faint: "#55555F",
  green: "#22C55E",
  red: "#EF4444",
  yellow: "#EAB308",
  border: "#2A2A35",
};

/** Box-drawing characters. */
export const BOX = {
  h: "─",
  v: "│",
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  lT: "├",
  rT: "┤",
};

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** Strip ANSI escape sequences. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Visible width (accounts for ANSI codes and wide CJK chars roughly). */
export function width(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp > 0xffff || (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x9fff) ? 2 : 1;
  }
  return w;
}

/** Truncate to visible width, preserving ANSI sequences, appending … if cut. */
export function truncate(s: string, maxW: number): string {
  let out = "";
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = s[i];
    const cw = width(ch);
    if (w + cw > maxW) {
      // Don't leave a dangling partial char; append ellipsis if room.
      return out + (w < maxW ? "…" : "") + S.reset;
    }
    out += ch;
    w += cw;
    i += 1;
  }
  return out;
}

/** Pad (visible width) to exactly w with spaces. */
export function padEnd(s: string, w: number): string {
  const vw = width(s);
  return vw >= w ? s : s + " ".repeat(w - vw);
}

/** Word-wrap plain text to width; returns lines. */
export function wrap(text: string, w: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (width(para) <= w) {
      lines.push(para);
      continue;
    }
    const words = para.split(/(\s+)/);
    let cur = "";
    for (const word of words) {
      if (width(cur + word) <= w) {
        cur += word;
      } else {
        if (cur) lines.push(cur.trimEnd());
        // Hard-break an overlong word.
        let rest = word;
        while (width(rest) > w) {
          let cut = "";
          let cw = 0;
          for (const ch of rest) {
            if (cw + width(ch) > w) break;
            cut += ch;
            cw += width(ch);
          }
          lines.push(cut);
          rest = rest.slice(cut.length);
        }
        cur = rest;
      }
    }
    lines.push(cur.trimEnd());
  }
  return lines;
}

/** Horizontal rule of width w. */
export function rule(w: number, ch = BOX.h): string {
  return ch.repeat(Math.max(0, w));
}
