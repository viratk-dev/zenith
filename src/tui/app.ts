/**
 * TuiApp — the Zenith terminal UI.
 *
 * Modes: boot (animated logo) -> qr/pairing (if linking needed) -> dashboard.
 * All component logs are routed here via log(); status via setWa/setBridge.
 * Launched from index.ts only when stdout is a TTY.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import qrcode from "qrcode-terminal";
import type { Agent } from "../core/agent.js";
import { listPendingApprovals, resolveApproval } from "../permissions/approvals.js";
import { S, P } from "./ansi.js";
import {
  bootFrame,
  qrFrame,
  pairingFrame,
  dashboardFrame,
  spinnerChar,
  type DashState,
  type FeedLine,
  type WaStatus,
} from "./screen.js";
import { LineEditor } from "./input.js";
import { runCommandLine, type CommandHost } from "./commands.js";

export interface TuiOptions {
  version?: string;
  llmModel: string;
  ownerPhone: string;
}

type Mode = "boot" | "qr" | "pairing" | "dashboard";

const FEED_CAP = 300;
const TAG_COLORS: Record<string, string> = {
  wa: P.teal,
  you: P.teal,
  zenith: P.text,
  agent: P.purple,
  bridge: P.faint,
  sys: P.muted,
  gw: P.faint,
};

export class TuiApp implements CommandHost {
  agent: Agent | null = null;
  readonly ownerPhone: string;
  readonly version: string;
  readonly llmModel: string;
  readonly startedAt = Date.now();

  private mode: Mode = "boot";
  private bootStatus: string[] = ["initializing…"];
  private feed: FeedLine[] = [];
  private wa: WaStatus = "connecting";
  private bridge: "active" | "inactive" = "inactive";
  private working = false;
  private tick = 0;
  private editor: LineEditor;
  private qrAscii: string[] = [];
  private pairingCode = "";
  private pendingPromptId: string | null = null;
  private knownApprovals = new Set<string>();
  private dashboardSeen = false;
  private pollStarted = false;
  private timers: NodeJS.Timeout[] = [];
  private stdinHandler: ((d: Buffer) => void) | null = null;
  private exited = false;

  constructor(opts: TuiOptions) {
    this.version = opts.version ?? "0.1.0";
    this.llmModel = opts.llmModel;
    this.ownerPhone = opts.ownerPhone;
    this.editor = new LineEditor({
      onChange: () => this.render(),
      onSubmit: (line) => void this.handleSubmit(line),
      onQuit: () => this.shutdown(),
      onClear: () => this.render(),
    });
  }

  // ------------------------------------------------------------ boot sequence

  /** Show the animated boot screen. Call before slow startup steps. */
  showBoot(status = "initializing…"): void {
    this.mode = "boot";
    this.bootStatus = [status];
    this.attachTerminal();
    this.startTicker();
    this.render();
  }

  setBootStatus(status: string): void {
    this.bootStatus.push(status);
    if (this.mode === "boot") this.render();
  }

  /** Raw QR string from the WhatsApp channel. */
  showQrData(qrData: string): void {
    if (qrData.startsWith("PAIRING-CODE:")) {
      this.showPairingCode(qrData.slice("PAIRING-CODE:".length));
      return;
    }
    try {
      qrcode.generate(qrData, { small: true }, (ascii: string) => {
        this.qrAscii = ascii.split("\n").filter((l) => l.length > 0);
        this.mode = "qr";
        this.render();
      });
    } catch {
      this.log("sys", "could not render QR", P.red);
    }
  }

  showPairingCode(code: string): void {
    this.pairingCode = code;
    this.mode = "pairing";
    try {
      // Persist for the `qr` command later.
      mkdirSync("./data", { recursive: true });
      writeFileSync("./data/pairing-code.txt", code);
    } catch { /* best-effort */ }
    this.render();
  }

  /** Switch to the dashboard; starts input + approval polling. */
  showDashboard(): void {
    this.mode = "dashboard";
    this.dashboardSeen = true;
    if (!this.pollStarted) {
      this.pollStarted = true;
      this.timers.push(setInterval(() => this.pollApprovals(), 600));
    }
    this.render();
  }

  // ------------------------------------------------------------ state updates

  attachAgent(agent: Agent): void {
    this.agent = agent;
  }

  log(tag: string, text: string, color?: string): void {
    const c = color ?? TAG_COLORS[tag] ?? P.muted;
    for (const line of String(text).split("\n").slice(0, 12)) {
      this.feed.push({ t: Date.now(), tag, color: c, text: line });
    }
    while (this.feed.length > FEED_CAP) this.feed.shift();
    if (this.mode === "dashboard") this.render();
  }

  setWa(s: WaStatus): void {
    if (this.wa === s) return;
    this.wa = s;
    if (s === "connected" && (this.mode === "qr" || this.mode === "pairing")) {
      // Link completed while the QR screen was up — go to the dashboard.
      this.showDashboard();
      this.log("sys", "whatsapp connected", P.green);
      return;
    }
    if (this.mode === "dashboard") {
      this.log("sys", `whatsapp ${s}`, s === "connected" ? P.green : P.yellow);
    } else {
      this.render();
    }
  }

  setBridge(active: boolean): void {
    this.bridge = active ? "active" : "inactive";
    if (this.mode === "dashboard") this.render();
  }

  setWorking(b: boolean): void {
    this.working = b;
    if (this.mode === "dashboard") this.render();
  }

  get waStatus(): string {
    return this.wa;
  }

  get bridgeStatus(): string {
    return this.bridge;
  }

  clearFeed(): void {
    this.feed = [];
    this.render();
  }

  async showQrFromFiles(): Promise<void> {
    if (existsSync("./data/pairing-code.txt")) {
      const code = readFileSync("./data/pairing-code.txt", "utf8").trim();
      this.log("sys", `pairing code: ${code}`, P.teal);
      return;
    }
    if (existsSync("./data/qr.txt")) {
      const qr = readFileSync("./data/qr.txt", "utf8").trim();
      this.showQrData(qr);
      // Return to dashboard after a moment is manual; user can wait.
      this.log("sys", "QR shown above — dashboard resumes on next render", P.muted);
      return;
    }
    this.log("sys", "no saved QR/pairing code (already linked?)", P.yellow);
  }

  // ------------------------------------------------------------ input

  private async handleSubmit(line: string): Promise<void> {
    const t = line.trim();
    // Inline y/n approval shortcut.
    if (this.pendingPromptId && /^(y|yes|n|no)$/i.test(t)) {
      const id = this.pendingPromptId;
      const ok = /^(y|yes)$/i.test(t);
      const done = resolveApproval(id, ok);
      this.log("sys", done ? (ok ? `approved ${id}` : `denied ${id}`) : `approval ${id} already gone`, done ? (ok ? P.green : P.yellow) : P.red);
      this.pendingPromptId = null;
      this.render();
      return;
    }
    this.pendingPromptId = null;
    if (!t) {
      this.render();
      return;
    }
    const wasCommand = await runCommandLine(t, this);
    if (!wasCommand) {
      // Bare text = talk to the agent directly.
      const a = this.agent;
      if (!a) {
        this.log("sys", "agent not ready yet", P.red);
        return;
      }
      this.log("you", t, P.teal);
      this.setWorking(true);
      try {
        const reply = await a.handleMessage("tui:local", this.ownerPhone, t);
        this.log("zenith", reply, P.text);
      } catch (e) {
        this.log("sys", `error: ${(e as Error).message}`, P.red);
      } finally {
        this.setWorking(false);
      }
    }
    this.render();
  }

  private pollApprovals(): void {
    if (this.mode !== "dashboard") return;
    const list = listPendingApprovals();
    const ids = new Set(list.map((a) => a.id));
    // New approvals -> cards.
    for (const ap of list) {
      if (!this.knownApprovals.has(ap.id)) {
        this.knownApprovals.add(ap.id);
        this.feed.push({
          t: Date.now(),
          tag: "approval",
          color: P.yellow,
          text: "",
          approval: { id: ap.id, toolName: ap.toolName, summary: ap.summary, requestedAt: ap.requestedAt },
        });
        this.pendingPromptId = ap.id;
        this.log("sys", `approval ${ap.id} (${ap.toolName}) — press y/n`, P.yellow);
      }
    }
    // Resolved approvals -> drop cards.
    let changed = false;
    for (const id of [...this.knownApprovals]) {
      if (!ids.has(id)) {
        this.knownApprovals.delete(id);
        const idx = this.feed.findIndex((f) => f.approval?.id === id);
        if (idx >= 0) {
          this.feed.splice(idx, 1);
          changed = true;
        }
        if (this.pendingPromptId === id) this.pendingPromptId = null;
      }
    }
    if (changed) {
      while (this.feed.length > FEED_CAP) this.feed.shift();
      this.render();
    }
  }

  // ------------------------------------------------------------ terminal

  private attachTerminal(): void {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    this.stdinHandler = (d: Buffer) => {
      // Any key dismisses the QR / pairing screens once the dashboard exists.
      if (this.mode === "qr" || this.mode === "pairing") {
        if (this.dashboardSeen) {
          this.mode = "dashboard";
          this.render();
        }
        return;
      }
      if (this.mode !== "dashboard") return; // ignore keys during boot
      this.editor.handleData(d);
    };
    stdin.on("data", this.stdinHandler);
    process.on("SIGWINCH", () => this.render());
    process.on("SIGINT", () => {
      // In raw mode Ctrl+C arrives as data; SIGINT is a fallback.
      this.shutdown();
    });
  }

  private startTicker(): void {
    this.timers.push(
      setInterval(() => {
        this.tick += 1;
        // Animate spinner during boot/qr/pairing and while working.
        if (this.mode !== "dashboard" || this.working) this.render();
      }, 120),
    );
  }

  render(): void {
    if (this.exited) return;
    const w = process.stdout.columns || 80;
    const h = process.stdout.rows || 24;
    let frame: string;
    let cur: { row: number; col: number } | null = null;
    if (this.mode === "boot") {
      frame = bootFrame(w, h, this.bootStatus, this.tick);
    } else if (this.mode === "qr") {
      frame = qrFrame(w, h, this.qrAscii, this.tick);
    } else if (this.mode === "pairing") {
      frame = pairingFrame(w, h, this.pairingCode, this.tick);
    } else {
      const st: DashState = {
        version: this.version,
        llmModel: this.llmModel,
        wa: this.wa,
        bridge: this.bridge,
        feed: this.feed,
        pendingPromptId: this.pendingPromptId,
        input: this.editor.text,
        cursor: this.editor.cursor,
        messages: this.agent?.messageCount ?? 0,
        tools: this.agent ? [...this.agent.toolCounts.values()].reduce((a, b) => a + b, 0) : 0,
        startedAt: this.startedAt,
        working: this.working,
        tick: this.tick,
      };
      const d = dashboardFrame(st, w, h);
      frame = d.frame;
      cur = { row: d.curRow, col: d.curCol };
    }
    process.stdout.write(S.hideCursor + "\x1b[H" + frame);
    if (cur) {
      process.stdout.write(`\x1b[${cur.row};${cur.col}H` + S.showCursor);
    }
  }

  // ------------------------------------------------------------ lifecycle

  restart(): void {
    this.log("sys", "restarting process…", P.yellow);
    this.render();
    setTimeout(() => {
      const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: "inherit",
      });
      child.unref();
      this.hardExit(0);
    }, 600);
  }

  shutdown(): void {
    if (this.exited) return;
    this.hardExit(0, "\nZenith stopped. Bye!\n");
  }

  private hardExit(code: number, msg?: string): void {
    this.exited = true;
    for (const t of this.timers) clearInterval(t);
    try {
      if (this.stdinHandler) process.stdin.off("data", this.stdinHandler);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch { /* ignore */ }
    process.stdout.write(S.showCursor + "\n");
    if (msg) process.stdout.write(msg);
    process.exit(code);
  }

  /** Current spinner glyph (for hosts that want it). */
  get spinner(): string {
    return spinnerChar(this.tick);
  }
}
