/**
 * Pro tools for Zenith: surgical file editing, directory listing,
 * and the skills system (coding, documents, web-builder, self-improve).
 *
 * Skills live as markdown in ./data/skills/<name>.md. The agent loads them
 * on demand via read_skill, and improves them via skill_update (self-improvement).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, join } from "node:path";
import { ToolRegistry, tool } from "./registry.js";
import type { ToolManifest, ToolContext } from "../core/types.js";

function sandboxResolve(p: string, ctx: ToolContext): string {
  const abs = resolve(p);
  for (const root of ctx.sandboxRoots) {
    const rel = relative(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  }
  throw new Error(`path escapes sandbox: ${p}`);
}

/** Skills directory (inside sandbox). */
export function skillsDir(ctx: ToolContext): string {
  const dir = join(ctx.sandboxRoots[0], "data", "skills");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MANIFESTS: ToolManifest[] = [
  {
    name: "file_edit",
    description:
      "Surgically replace exact text in a file (old_text must match exactly once). For code fixes without rewriting whole files. Needs owner approval.",
    parameters: {
      path: { type: "string", description: "Path to file", required: true },
      old_text: { type: "string", description: "Exact text to find", required: true },
      new_text: { type: "string", description: "Replacement text", required: true },
    },
    permission: "write",
    requireApproval: true,
  },
  {
    name: "file_list",
    description: "List files/directories inside the sandbox workspace (2 levels deep). For exploring project structure.",
    parameters: {
      path: { type: "string", description: "Directory path (default: workspace root)" },
    },
    permission: "read",
    requireApproval: false,
  },
  {
    name: "read_skill",
    description:
      "Load a skill playbook: 'coding' (agentic code generation workflow), 'documents' (Word/Excel/PowerPoint/PDF creation), 'web-builder' (website generation), 'self-improve' (self-improvement loop). Call with no args to list skills. ALWAYS read the relevant skill before doing that kind of task.",
    parameters: {
      name: { type: "string", description: "Skill name, or empty to list" },
    },
    permission: "read",
    requireApproval: false,
  },
  {
    name: "skill_update",
    description:
      "Update the agent's own skill playbook (self-improvement). Use when you learn a better way to do something — write the improved guidance so future you does it right. Only for data/skills/*.md.",
    parameters: {
      name: { type: "string", description: "Skill name", required: true },
      content: { type: "string", description: "Full new skill content (markdown)", required: true },
    },
    permission: "write",
    requireApproval: false,
  },
];

export function registerProTools(registry: ToolRegistry): void {
  // file_edit
  registry.register(
    MANIFESTS[0],
    tool(async (args, ctx) => {
      const p = sandboxResolve(String(args.path ?? ""), ctx);
      if (!existsSync(p)) throw new Error("file not found");
      const oldText = String(args.old_text ?? "");
      const newText = String(args.new_text ?? "");
      if (!oldText) throw new Error("old_text is required");
      const content = readFileSync(p, "utf8");
      const idx = content.indexOf(oldText);
      if (idx === -1) throw new Error("old_text not found in file");
      if (content.indexOf(oldText, idx + 1) !== -1)
        throw new Error("old_text matches multiple times — be more specific");
      writeFileSync(p, content.slice(0, idx) + newText + content.slice(idx + oldText.length));
      return `edited ${p}`;
    }),
  );

  // file_list
  registry.register(
    MANIFESTS[1],
    tool(async (args, ctx) => {
      const p = args.path ? sandboxResolve(String(args.path), ctx) : ctx.sandboxRoots[0];
      if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error("not a directory");
      const out: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 2) return;
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith(".")) continue;
          const full = join(dir, entry);
          const rel = relative(ctx.sandboxRoots[0], full);
          try {
            out.push(statSync(full).isDirectory() ? `${rel}/` : rel);
            if (statSync(full).isDirectory()) walk(full, depth + 1);
          } catch { /* skip unreadable */ }
        }
      };
      walk(p, 0);
      return out.slice(0, 200).join("\n") || "(empty)";
    }),
  );

  // read_skill
  registry.register(
    MANIFESTS[2],
    tool(async (args, ctx) => {
      const dir = skillsDir(ctx);
      const name = String(args.name ?? "").trim();
      if (!name) {
        const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
        return files.length > 0
          ? "Available skills:\n" + files.map((f) => `- ${f.replace(/\.md$/, "")}`).join("\n")
          : "No skills installed.";
      }
      const p = join(dir, `${name}.md`);
      if (!existsSync(p)) throw new Error(`skill not found: ${name}`);
      return readFileSync(p, "utf8").slice(0, 15000);
    }),
  );

  // skill_update (self-improvement — sandboxed to data/skills/)
  registry.register(
    MANIFESTS[3],
    tool(async (args, ctx) => {
      const name = String(args.name ?? "").trim().replace(/[^a-z0-9-]/gi, "");
      if (!name) throw new Error("skill name is required");
      const dir = skillsDir(ctx);
      const p = join(dir, `${name}.md`);
      writeFileSync(p, String(args.content ?? ""));
      return `skill updated: ${name}`;
    }),
  );
}
