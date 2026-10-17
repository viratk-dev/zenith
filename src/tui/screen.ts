/**
 * Screen rendering — builds full terminal frames as strings.
 * Pure functions of state; app.ts decides when to paint.
 */
import { S, P, BOX, fg, width, truncate, padEnd, wrap, rule } from "./ansi.js";

export type WaStatus = "connected" | "connecting" | "disconnected";

export interface ApprovalInfo {
  id: string;
  toolName: string;
  summary: string;
  requestedAt: number;
}

export interface FeedLine {
  t: number;
  tag: string;
  color: string;
  text: string;
  approval?: ApprovalInfo;
  resolvedNote?: string;
}

export interface DashState {
  version: string;
  llmModel: string;
  wa: WaStatus;
  bridge: "active" | "inactive";
  feed: FeedLine[];
  pendingPromptId: string | null;
  input: string;
  cursor: number;
  messages: number;
  tools: number;
  startedAt: number;
  working: boolean;
  tick: number;
}

export const LOGO = [
  "███████╗███████╗███╗   ██╗██╗████████╗██╗  ██╗",
  "╚══███╔╝██╔════╝████╗  ██║██║╚══██╔══╝██║  ██║",
  "  ███╔╝ █████╗  ██╔██╗ ██║██║   ██║   ███████║",
  " ███╔╝  ██╔══╝  ██║╚██╗██║██║   ██║   ██╔══██║",
  "███████╗███████╗██║ ╚████║██║   ██║   ██║  ██║",
  "╚══════╝╚══════╝╚═╝  ╚═══╝╚═╝   ╚═╝   ╚═╝  ╚═╝",
];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinnerChar = (tick: number): string => SPINNER[tick % SPINNER.length];

/** Lerp between two hex colors. */
function lerpHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function center(line: string, w: number): string {
  const vw = width(line);
  const left = Math.max(0, Math.floor((w - vw) / 2));
  return " ".repeat(left) + line;
}

/** Boot frame: gradient logo + spinner + status lines. */
export function bootFrame(w: number, h: number, status: string[], tick: number): string {
  const lines: string[] = [];
  const logoW = width(LOGO[0]);
  const left = Math.max(0, Math.floor((w - logoW) / 2));
  const pad = " ".repeat(left);
  LOGO.forEach((row, i) => {
    const col = lerpHex(P.purple, P.teal, i / (LOGO.length - 1));
    lines.push(pad + fg(col) + S.bold + row + S.reset);
  });
  lines.push("");
  lines.push(center(fg(P.muted) + "Virat's personal AI agent" + S.reset, w));
  lines.push("");
  lines.push("");
  const spin = fg(P.purple) + S.bold + spinnerChar(tick) + S.reset;
  for (const s of status.slice(-3)) {
    lines.push(center(`${spin}  ${fg(P.text)}${s}${S.reset}`, w));
  }
  // Vertically center the block.
  const top = Math.max(0, Math.floor((h - lines.length) / 2) - 1);
  const out = Array(top).fill("").concat(lines);
  while (out.length < h) out.push("");
  return out.slice(0, h).join("\n");
}

/** Pairing-code frame: big readable code. */
export function pairingFrame(w: number, h: number, code: string, tick: number): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(center(fg(P.yellow) + S.bold + "WhatsApp pairing" + S.reset, w));
  lines.push(center(fg(P.muted) + "WhatsApp → Linked devices → Link a device → Link with phone number" + S.reset, w));
  lines.push("");
  lines.push("");
  const big = S.bold + fg(P.teal) + code.split("").join(" ") + S.reset;
  const boxW = width(code) * 2 + 8;
  const bl = Math.max(0, Math.floor((w - boxW) / 2));
  const bp = " ".repeat(bl);
  lines.push(bp + fg(P.border) + BOX.tl + rule(boxW - 2) + BOX.tr + S.reset);
  lines.push(bp + fg(P.border) + BOX.v + S.reset + " ".repeat(boxW - 2) + fg(P.border) + BOX.v + S.reset);
  lines.push(bp + fg(P.border) + BOX.v + S.reset + center(big, boxW - 2) + fg(P.border) + BOX.v + S.reset);
  lines.push(bp + fg(P.border) + BOX.v + S.reset + " ".repeat(boxW - 2) + fg(P.border) + BOX.v + S.reset);
  lines.push(bp + fg(P.border) + BOX.bl + rule(boxW - 2) + BOX.br + S.reset);
  lines.push("");
  lines.push("");
  lines.push(center(`${fg(P.purple)}${spinnerChar(tick)}${S.reset}  ${fg(P.muted)}waiting for link…${S.reset}`, w));
  const top = Math.max(0, Math.floor((h - lines.length) / 2));
  const out = Array(top).fill("").concat(lines);
  while (out.length < h) out.push("");
  return out.slice(0, h).join("\n");
}

/** QR frame: centered QR ascii art. */
export function qrFrame(w: number, h: number, qrAscii: string[], tick: number): string {
  const lines: string[] = [];
  lines.push(center(fg(P.yellow) + S.bold + "Scan to link WhatsApp" + S.reset, w));
  lines.push(center(fg(P.muted) + "WhatsApp → Linked devices → Link a device" + S.reset, w));
  lines.push("");
  const qw = Math.max(...qrAscii.map(width));
  const qp = " ".repeat(Math.max(0, Math.floor((w - qw) / 2)));
  for (const row of qrAscii) lines.push(qp + row);
  lines.push("");
  lines.push(center(`${fg(P.purple)}${spinnerChar(tick)}${S.reset}  ${fg(P.muted)}waiting for scan…${S.reset}`, w));
  const top = Math.max(0, Math.floor((h - lines.length) / 2));
  const out = Array(top).fill("").concat(lines);
  while (out.length < h) out.push("");
  return out.slice(0, h).join("\n");
}

// ---------------------------------------------------------------- dashboard

function pill(dotColor: string, label: string): string {
  return fg(dotColor) + "●" + S.reset + " " + fg(P.muted) + label + S.reset;
}

function waPill(wa: WaStatus): string {
  if (wa === "connected") return pill(P.green, "WhatsApp");
  if (wa === "connecting") return pill(P.yellow, "WhatsApp…");
  return pill(P.red, "WhatsApp");
}

function fmtTime(t: number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function fmtClock(): string {
  return fmtTime(Date.now());
}

function approvalCardLines(ap: ApprovalInfo, innerW: number): string[] {
  const cardW = Math.min(innerW - 4, 62);
  const out: string[] = [];
  const b = fg(P.yellow);
  const bd = fg(P.border);
  out.push(
    "  " + b + BOX.tl + rule(cardW - 2) + BOX.tr + S.reset,
  );
  const title = b + S.bold + "⚠ Approval needed" + S.reset;
  out.push("  " + b + BOX.v + S.reset + " " + padEnd(title, cardW - 4) + " " + b + BOX.v + S.reset);
  const tool = `${S.bold}Tool:${S.reset} ${truncate(ap.toolName, cardW - 12)}`;
  out.push("  " + b + BOX.v + S.reset + " " + padEnd(tool, cardW - 4) + " " + b + BOX.v + S.reset);
  for (const wl of wrap(ap.summary || "(no details)", cardW - 6)) {
    out.push("  " + b + BOX.v + S.reset + " " + padEnd(fg(P.muted) + wl + S.reset, cardW - 4) + " " + b + BOX.v + S.reset);
  }
  const keys = `${fg(P.green)}${S.bold}[y]${S.reset} approve   ${fg(P.red)}${S.bold}[n]${S.reset} deny`;
  const keyPlain = "[y] approve   [n] deny";
  const idShort = truncate(ap.id, 18);
  const spacer = " ".repeat(Math.max(1, cardW - 4 - keyPlain.length - width(idShort) - 1));
  out.push(
    "  " + b + BOX.v + S.reset + " " + keys + spacer + fg(P.faint) + idShort + S.reset + " " + b + BOX.v + S.reset,
  );
  out.push("  " + b + BOX.bl + rule(cardW - 2) + BOX.br + S.reset);
  return out;
}

function feedLineRows(fl: FeedLine, innerW: number): string[] {
  if (fl.approval) return approvalCardLines(fl.approval, innerW);
  const time = fg(P.faint) + fmtTime(fl.t) + S.reset;
  const tag = fg(fl.color) + S.bold + padEnd(fl.tag, 7) + S.reset;
  const prefix = `${time} ${tag} `;
  const prefixW = 9 + 8; // "HH:MM:SS " + tag padded
  const rows: string[] = [];
  const wrapped = wrap(fl.text, innerW - prefixW - 1);
  wrapped.forEach((wl, i) => {
    rows.push(i === 0 ? prefix + wl : " ".repeat(prefixW) + fg(P.faint) + wl + S.reset);
  });
  return rows.length ? rows : [prefix];
}

/**
 * Render the input row. Returns the row text (without cursor glyph —
 * the caller places the real terminal cursor) and the 0-based cursor
 * column within the row content.
 */
function inputRow(
  input: string,
  cursor: number,
  innerW: number,
  promptActive: boolean,
): { text: string; cursorCol: number } {
  const prompt = promptActive
    ? fg(P.yellow) + S.bold + "y/n ❯ " + S.reset
    : fg(P.purple) + S.bold + "❯ " + S.reset;
  const promptW = promptActive ? 6 : 2;
  const maxChars = innerW - promptW - 1;
  let visible = input;
  let cur = Math.max(0, Math.min(cursor, input.length));
  if (input.length > maxChars && maxChars > 4) {
    const start = Math.max(0, Math.min(cur - Math.floor(maxChars / 2), input.length - maxChars));
    visible = input.slice(start, start + maxChars);
    cur = cur - start;
  }
  return { text: prompt + visible, cursorCol: promptW + cur };
}

export interface DashboardFrame {
  frame: string;
  /** 1-based terminal coordinates for the real cursor. */
  curRow: number;
  curCol: number;
}

export function dashboardFrame(st: DashState, w: number, h: number): DashboardFrame {
  const innerW = w - 4; // account for "│ " and " │"
  const v = fg(P.border) + BOX.v + S.reset;

  // -- header --
  const title = `${S.bold}${fg(P.purple)}ZENITH${S.reset} ${fg(P.faint)}v${st.version}${S.reset}`;
  const pills = [
    waPill(st.wa),
    pill(st.bridge === "active" ? P.teal : P.faint, "Bridge"),
    pill(P.purple, st.llmModel.length > 14 ? st.llmModel.slice(0, 14) + "…" : st.llmModel),
  ].join("  ");
  const clock = st.working
    ? fg(P.purple) + S.bold + spinnerChar(st.tick) + S.reset + " " + fg(P.muted) + "working" + S.reset
    : fg(P.faint) + fmtClock() + S.reset;
  const leftPart = `┌─ ${title} `;
  const rightPart = ` ${pills}  ${clock} ─┐`;
  const fill = Math.max(0, w - width(leftPart) - width(rightPart));
  const header = leftPart + fg(P.border) + rule(fill) + S.reset + rightPart;

  // -- feed rows --
  const feedH = Math.max(1, h - 4);
  let rows: string[] = [];
  for (const fl of st.feed) rows.push(...feedLineRows(fl, innerW));
  // Keep the tail that fits; approval cards stick to the bottom.
  rows = rows.slice(-feedH);
  while (rows.length < feedH) rows.unshift("");
  const feedRendered = rows.map((r) => `${v} ${padEnd(truncate(r, innerW), innerW)} ${v}`);

  // -- divider --
  const divider = `${fg(P.border)}${BOX.lT}${rule(w - 2)}${BOX.rT}${S.reset}`;

  // -- input --
  const ir = inputRow(st.input, st.cursor, innerW, !!st.pendingPromptId);
  const inputRendered = `${v} ${padEnd(ir.text, innerW)} ${v}`;

  // -- footer hint --
  const uptimeMin = Math.floor((Date.now() - st.startedAt) / 60000);
  const stats = `${st.messages} msgs · ${st.tools} tools · ${uptimeMin}m up`;
  const hint = st.pendingPromptId
    ? `${fg(P.yellow)}press ${S.bold}y${S.reset}${fg(P.yellow)} / ${S.bold}n${S.reset}${fg(P.yellow)} to resolve ${truncate(st.pendingPromptId, 20)}${S.reset}`
    : `${fg(P.faint)}type ${S.reset}'help'${fg(P.faint)} for commands · ${stats}${S.reset}`;
  const leftF = `└─ ${hint} `;
  const fillF = Math.max(0, w - width(leftF) - 2);
  const footer = leftF + fg(P.border) + rule(fillF) + "┘" + S.reset;

  const frame = [header, ...feedRendered, divider, inputRendered, footer].join("\n");
  // Input row is second-to-last (1-based row h-1); content starts after "│ ".
  return { frame, curRow: h - 1, curCol: 3 + ir.cursorCol };
}

/** Small helper: one-line status for non-dashboard moments. */
export function statusLine(text: string): string {
  return fg(P.muted) + text + S.reset;
}
