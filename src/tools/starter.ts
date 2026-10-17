/**
 * The 6 starter tools. Each declares its manifest (name, description,
 * parameters, permission level, approval requirement). The permission GATE
 * — not the tool itself — decides whether it may run.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { ToolRegistry, tool } from "./registry.js";
import type { ToolManifest, ToolContext } from "../core/types.js";

/** Resolve a path and ensure it stays inside one of the sandbox roots. */
function sandboxResolve(p: string, ctx: ToolContext): string {
  const abs = resolve(p);
  for (const root of ctx.sandboxRoots) {
    const rel = relative(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  }
  throw new Error(`path escapes sandbox: ${p}`);
}

const MANIFESTS: ToolManifest[] = [
  {
    name: "web_search",
    description: "Search the web for current information. Returns titles, URLs and snippets.",
    parameters: {
      query: { type: "string", description: "Search query", required: true },
      count: { type: "number", description: "Max results (default 5)" },
    },
    permission: "read",
    requireApproval: false,
  },
  {
    name: "http_fetch",
    description: "Fetch a URL and return its text (first 8000 chars). For reading pages/APIs.",
    parameters: {
      url: { type: "string", description: "https URL to fetch", required: true },
    },
    permission: "read",
    requireApproval: false,
  },
  {
    name: "file_read",
    description: "Read a text file inside the sandbox workspace.",
    parameters: {
      path: { type: "string", description: "Path to file", required: true },
    },
    permission: "read",
    requireApproval: false,
  },
  {
    name: "file_write",
    description: "Write/create a text file inside the sandbox workspace. Needs owner approval.",
    parameters: {
      path: { type: "string", description: "Path to file", required: true },
      content: { type: "string", description: "File content", required: true },
    },
    permission: "write",
    requireApproval: true,
  },
  {
    name: "exec_shell",
    description:
      "Run a shell command. DANGEROUS — always needs owner approval. No network exfiltration, no package installs without explicit approval text.",
    parameters: {
      command: { type: "string", description: "Shell command", required: true },
      workdir: { type: "string", description: "Working directory (must be in sandbox)" },
    },
    permission: "sensitive",
    requireApproval: true,
  },
  {
    name: "notes",
    description: "Memory notes: 'read' (MEMORY.md), 'fact' (save a durable fact), 'log' (daily log line), 'person' (save note about someone).",
    parameters: {
      action: { type: "string", description: "'read' | 'fact' | 'log' | 'person'", required: true },
      text: { type: "string", description: "Fact/log/note text", required: true },
      name: { type: "string", description: "Person name (for action=person)" },
    },
    permission: "write",
    requireApproval: false,
  },
  {
    name: "reminders",
    description:
      "Schedule a reminder: the agent will message the owner at the given time. Time format: 'YYYY-MM-DDTHH:MM' (local). Needs owner approval at creation.",
    parameters: {
      at: { type: "string", description: "When, e.g. 2026-10-17T08:00", required: true },
      text: { type: "string", description: "Reminder text", required: true },
    },
    permission: "write",
    requireApproval: true,
  },
];

export function registerStarterTools(registry: ToolRegistry): void {
  // web_search — via DuckDuckGo instant API (free, no key)
  registry.register(
    MANIFESTS[0],
    tool(async (args) => {
      const q = String(args.query ?? "");
      const count = Math.min(Number(args.count) || 5, 10);
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`;
      const res = await fetch(url, { headers: { "User-Agent": "virat-agent/0.1" } });
      if (!res.ok) throw new Error(`search HTTP ${res.status}`);
      const data = (await res.json()) as any;
      const out: string[] = [];
      for (const t of [...(data.RelatedTopics ?? [])].slice(0, count)) {
        const topic = t.Topics ? t.Topics[0] : t;
        if (topic?.Text) out.push(`- ${topic.Text}\n  ${topic.FirstURL ?? ""}`);
      }
      return out.length > 0 ? out.join("\n") : "No results. Try http_fetch on a search engine instead.";
    }),
  );

  // http_fetch
  registry.register(
    MANIFESTS[1],
    tool(async (args) => {
      const url = String(args.url ?? "");
      if (!/^https?:\/\//.test(url)) throw new Error("only http(s) URLs allowed");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: { "User-Agent": "virat-agent/0.1" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        // Strip tags crudely for readability
        return text
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 8000);
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  // file_read (sandboxed)
  registry.register(
    MANIFESTS[2],
    tool(async (args, ctx) => {
      const p = sandboxResolve(String(args.path ?? ""), ctx);
      if (!existsSync(p)) throw new Error("file not found");
      return readFileSync(p, "utf8").slice(0, 20000);
    }),
  );

  // file_write (sandboxed, approval-gated)
  registry.register(
    MANIFESTS[3],
    tool(async (args, ctx) => {
      const p = sandboxResolve(String(args.path ?? ""), ctx);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, String(args.content ?? ""));
      return `wrote ${p}`;
    }),
  );

  // exec_shell (guarded: sandbox workdir, blocklist, timeout)
  const BLOCKED = [/\brm\s+-rf\s+\/( |$)/, /\bmkfs\b/, /:\(\)\s*\{/, /\bdd\s+if=/];
  registry.register(
    MANIFESTS[4],
    tool(async (args, ctx) => {
      const command = String(args.command ?? "");
      if (BLOCKED.some((re) => re.test(command))) {
        throw new Error("command blocked by safety filter");
      }
      const workdir = args.workdir ? sandboxResolve(String(args.workdir), ctx) : ctx.sandboxRoots[0];
      return await new Promise<string>((resolveP, rejectP) => {
        const timer = setTimeout(() => rejectP(new Error("command timed out (30s)")), 30000);
        execFile("bash", ["-lc", command], { cwd: workdir, timeout: 30000 }, (err, stdout, stderr) => {
          clearTimeout(timer);
          if (err) rejectP(new Error(stderr.slice(0, 2000) || err.message));
          else resolveP(stdout.slice(0, 10000));
        });
      });
    }),
  );

  // notes (memory) — wired up by agent.ts via ctx extension; placeholder here
  // is replaced at runtime. We register a stub that the agent overrides.
  registry.register(MANIFESTS[5], tool(async () => "notes tool not wired (agent setup error)"));

  // reminders — in-memory schedule; agent.ts wires the delivery callback
  registry.register(MANIFESTS[6], tool(async () => "reminders tool not wired (agent setup error)"));
}
