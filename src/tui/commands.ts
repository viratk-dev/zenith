/**
 * TUI slash-less commands. Each command is `name` + handler.
 * The host (app.ts) implements CommandHost — no import cycle.
 */
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../core/agent.js";
import {
  listPendingApprovals,
  resolveApproval,
  pendingApprovalCount,
} from "../permissions/approvals.js";
import { P, fg, S } from "./ansi.js";

export interface CommandHost {
  log(tag: string, text: string, color?: string): void;
  agent: Agent | null;
  ownerPhone: string;
  version: string;
  llmModel: string;
  waStatus: string;
  bridgeStatus: string;
  startedAt: number;
  setWorking(b: boolean): void;
  clearFeed(): void;
  showQrFromFiles(): Promise<void>;
  restart(): void;
  shutdown(): void;
  render(): void;
}

type Handler = (args: string[], host: CommandHost) => Promise<void> | void;

interface Command {
  help: string;
  run: Handler;
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function dirSize(p: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  try {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) {
        const sub = dirSize(full);
        files += sub.files;
        bytes += sub.bytes;
      } else {
        files += 1;
        try {
          bytes += statSync(full).size;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return { files, bytes };
}

const COMMANDS: Record<string, Command> = {
  help: {
    help: "show this help",
    run(_args, host) {
      const rows = Object.entries(COMMANDS).map(
        ([n, c]) => `  ${fg(P.purple)}${S.bold}${n.padEnd(12)}${S.reset} ${fg(P.muted)}${c.help}${S.reset}`,
      );
      host.log("sys", "Available commands:\n" + rows.join("\n"), P.text);
      host.log("sys", "Tip: when an approval card appears, just press y / n.", P.faint);
    },
  },

  status: {
    help: "detailed status: uptime, messages, tools, approvals",
    run(_args, host) {
      const a = host.agent;
      const tools = a ? [...a.toolCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5) : [];
      const topTools = tools.length ? tools.map(([n, c]) => `${n}×${c}`).join(", ") : "none yet";
      host.log(
        "sys",
        [
          `${S.bold}Zenith v${host.version}${S.reset}`,
          `  uptime      ${fmtUptime(Date.now() - host.startedAt)}`,
          `  whatsapp    ${host.waStatus}`,
          `  bridge      ${host.bridgeStatus}`,
          `  llm         ${host.llmModel}`,
          `  messages    ${a ? a.messageCount : 0} handled`,
          `  top tools   ${topTools}`,
          `  approvals   ${pendingApprovalCount()} pending`,
        ].join("\n"),
        P.text,
      );
    },
  },

  chat: {
    help: "chat <message> — talk to the agent directly (no WhatsApp)",
    async run(args, host) {
      const text = args.join(" ").trim();
      const a = host.agent;
      if (!a) {
        host.log("sys", "agent not ready yet", P.red);
        return;
      }
      if (!text) {
        host.log("sys", "usage: chat <message>", P.yellow);
        return;
      }
      host.log("you", text, P.teal);
      host.setWorking(true);
      try {
        const reply = await a.handleMessage("tui:local", host.ownerPhone, text);
        host.log("zenith", reply, P.text);
      } catch (e) {
        host.log("sys", `error: ${(e as Error).message}`, P.red);
      } finally {
        host.setWorking(false);
      }
    },
  },

  approve: {
    help: "approve <id> — approve a pending action",
    run(args, host) {
      const id = args[0];
      if (!id) {
        host.log("sys", "usage: approve <id>  (see 'pending')", P.yellow);
        return;
      }
      const ok = resolveApproval(id, true);
      host.log("sys", ok ? `approved ${id}` : `no pending approval ${id}`, ok ? P.green : P.red);
    },
  },

  deny: {
    help: "deny <id> — deny a pending action",
    run(args, host) {
      const id = args[0];
      if (!id) {
        host.log("sys", "usage: deny <id>  (see 'pending')", P.yellow);
        return;
      }
      const ok = resolveApproval(id, false);
      host.log("sys", ok ? `denied ${id}` : `no pending approval ${id}`, ok ? P.green : P.red);
    },
  },

  pending: {
    help: "list pending approvals",
    run(_args, host) {
      const list = listPendingApprovals();
      if (!list.length) {
        host.log("sys", "no pending approvals", P.muted);
        return;
      }
      for (const ap of list) {
        const age = Math.floor((Date.now() - ap.requestedAt) / 1000);
        host.log("sys", `${fg(P.yellow)}${ap.id}${S.reset} · ${ap.toolName} · ${age}s ago\n  ${ap.summary.slice(0, 160)}`, P.text);
      }
    },
  },

  skills: {
    help: "list loaded skill playbooks",
    run(_args, host) {
      const dir = "./data/skills";
      if (!existsSync(dir)) {
        host.log("sys", "no skills directory", P.muted);
        return;
      }
      const names = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      host.log("sys", `${S.bold}${names.length} skills:${S.reset} ${names.join(", ")}`, P.text);
    },
  },

  tools: {
    help: "list available tools",
    run(_args, host) {
      const a = host.agent;
      if (!a) {
        host.log("sys", "agent not ready yet", P.red);
        return;
      }
      const list = a.listTools();
      const rows = list.map(
        (t) => `  ${fg(P.purple)}${t.name.padEnd(14)}${S.reset} ${fg(P.muted)}${t.description.slice(0, 80)}${S.reset}`,
      );
      host.log("sys", `${S.bold}${list.length} tools:${S.reset}\n` + rows.join("\n"), P.text);
    },
  },

  memory: {
    help: "show memory stats",
    run(_args, host) {
      const a = host.agent;
      const dir = a ? "./data/memory" : "./data/memory";
      const s = dirSize(dir);
      const kb = (s.bytes / 1024).toFixed(1);
      let todayLines = 0;
      try {
        const d = new Date();
        const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.md`;
        const p = join(dir, today);
        if (existsSync(p)) todayLines = readFileSync(p, "utf8").split("\n").filter(Boolean).length;
      } catch { /* ignore */ }
      host.log(
        "sys",
        [`${S.bold}memory:${S.reset}`, `  dir      ${dir}`, `  files    ${s.files} (${kb} KB)`, `  today    ${todayLines} entries`].join("\n"),
        P.text,
      );
    },
  },

  clear: {
    help: "clear the event feed",
    run(_args, host) {
      host.clearFeed();
    },
  },

  qr: {
    help: "show WhatsApp pairing QR / code again",
    async run(_args, host) {
      await host.showQrFromFiles();
    },
  },

  restart: {
    help: "restart the agent process",
    run(_args, host) {
      host.log("sys", "restarting…", P.yellow);
      setTimeout(() => host.restart(), 400);
    },
  },

  quit: {
    help: "graceful shutdown (also: exit, q)",
    run(_args, host) {
      host.shutdown();
    },
  },
};

// Aliases
COMMANDS["exit"] = COMMANDS["quit"];
COMMANDS["q"] = COMMANDS["quit"];

export function commandNames(): string[] {
  return Object.keys(COMMANDS).sort();
}

/** Parse + run a line. Returns true if it was a command. */
export async function runCommandLine(line: string, host: CommandHost): Promise<boolean> {
  const trimmed = line.trim();
  if (!trimmed) return true;
  const [name, ...args] = trimmed.split(/\s+/);
  const cmd = COMMANDS[name.toLowerCase()];
  if (!cmd) return false;
  try {
    await cmd.run(args, host);
  } catch (e) {
    host.log("sys", `command failed: ${(e as Error).message}`, P.red);
  }
  return true;
}
