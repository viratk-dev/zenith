/**
 * Agent core: the main loop.
 *   message -> build context (memory + system prompt) -> LLM -> tool calls
 *   (EVERY one through the permission gate) -> final reply
 *
 * One-way dependency: agent imports permissions/, memory/, tools/, core/llm.
 * It never imports gateway/ or channels/ (finding #10).
 */
import { randomUUID } from "node:crypto";
import { mintRunAuthority, type RunAuthority } from "../permissions/authority.js";
import { resolvePolicy, type ResolvedPolicy } from "../permissions/policy.js";
import { ToolGate } from "../permissions/gate.js";
import { MemoryManager } from "../memory/manager.js";
import { ToolRegistry, tool } from "../tools/registry.js";
import { registerStarterTools } from "../tools/starter.js";
import { registerProTools } from "../tools/pro.js";
import type {
  AgentConfig,
  ChatMessage,
  LlmProvider,
  ToolContext,
  ToolManifest,
  ToolResult,
} from "./types.js";
import { createProvider } from "./llm.js";

const SYSTEM_PROMPT = `You are Zenith — Virat's personal AI assistant. You are helpful, direct, and warm.
Virat is 16, from Bihar, India. He builds AI tools, automates social media, and runs an agency.
Reply in the same language Virat uses (often Hinglish). Keep replies short and useful.

You have SKILLS (expert playbooks): use the read_skill tool to load one before that kind of task.
Coding & building:
- coding: agentic code generation — plan, write, run, verify, fix loop.
- g-stack: Garry Tan's role-based gears — plan, write, review, QA, ship as separate modes.
- web-builder: website generation with premium design.
- frontend: frontend implementation standards.
- github: GitHub repos, files, PRs.
Design & taste:
- ui-ux: UI/UX design intelligence.
- virat-design: Virat's signature editorial design system.
- taste: design judgment — what to leave out.
- anti-slop: never look AI-generated.
- motion: web animations (Framer Motion, GSAP, scroll).
Video:
- hyperframes: HyperFrames CLI video rendering.
- remotion: programmatic video with Remotion.
- capcut: CapCut editing for Shorts/Reels.
Knowledge & self:
- documents: Word/Excel/PowerPoint/PDF creation.
- research: deep verification — never invent facts.
- memory: save learnings, preferences, corrections.
- self-improve: after every task, save learnings and improve your skills.
- skill-creator: create new skills when needed.
ALWAYS read the relevant skill first. For coding, use BOTH coding and g-stack gears. After each task, run the self-improve loop.

You have tools. Use them when they help. NEVER claim a tool result you didn't get.
If a tool call is blocked, tell Virat plainly what was blocked and why.
For anything destructive, public, or irreversible, the system will ask Virat for approval — mention that you're waiting for his yes/no when that happens.`;

interface Reminder {
  id: string;
  at: number;
  text: string;
  timer: NodeJS.Timeout;
}

export class Agent {
  private llm: LlmProvider;
  private registry = new ToolRegistry();
  private memory: MemoryManager;
  private reminders = new Map<string, Reminder>();
  private liveRuns = new Set<string>();
  private config: AgentConfig;
  /** Called to deliver a message to the owner (wired by the channel). */
  onSendToOwner: (text: string) => Promise<void> = async () => {};
  /** Messages handled — public for TUI status. */
  messageCount = 0;
  /** Tool call counts by name — public for TUI status. */
  toolCounts = new Map<string, number>();

  /** Public tool catalog for the TUI `tools` command. */
  listTools(): ToolManifest[] {
    return this.registry.listManifests();
  }

  constructor(config: AgentConfig) {
    this.config = config;
    this.llm = createProvider(config.llm.provider, {
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs,
    });
    this.memory = new MemoryManager(config.memory.dir);
    registerStarterTools(this.registry);
    registerProTools(this.registry);
    this.wireStatefulTools();
  }

  /** Replace the stub notes/reminders tools with real implementations. */
  private wireStatefulTools(): void {
    const mem = this.memory;
    // Re-register by reaching into the maps (registry has no unregister;
    // we overwrite the handler for the already-registered manifest).
    this.registry.handlers.set(
      "notes",
      tool(async (args) => {
        const action = String(args.action ?? "read");
        if (action === "read") return mem.readMemory();
        if (action === "fact") {
          mem.addFact(String(args.text ?? ""));
          return "fact saved";
        }
        if (action === "log") {
          mem.log(String(args.text ?? ""));
          return "logged";
        }
        if (action === "person") {
          mem.savePerson(String(args.name ?? "unknown"), String(args.text ?? ""));
          return "person note saved";
        }
        throw new Error(`unknown notes action: ${action}`);
      }),
    );
    this.registry.handlers.set(
      "reminders",
      tool(async (args) => {
        const at = Date.parse(String(args.at ?? ""));
        if (Number.isNaN(at)) throw new Error("bad time format, use YYYY-MM-DDTHH:MM");
        const delay = at - Date.now();
        if (delay <= 0) throw new Error("time is in the past");
        const id = randomUUID().slice(0, 8);
        const text = String(args.text ?? "");
        const timer = setTimeout(() => {
          this.reminders.delete(id);
          this.onSendToOwner(`⏰ Reminder: ${text}`).catch(() => {});
          mem.log(`reminder fired: ${text}`);
        }, delay);
        // Unref so a pending reminder doesn't hold the process open by itself.
        timer.unref?.();
        this.reminders.set(id, { id, at, text, timer });
        mem.log(`reminder set for ${args.at}: ${text}`);
        return `reminder ${id} set for ${args.at}`;
      }),
    );
  }

  private buildPolicy(): ResolvedPolicy {
    // 3 layers: global (config) -> agent (none by default) -> session (none by default).
    // Growing to per-agent/session overrides later is a config change, not code.
    return resolvePolicy([
      { allow: this.config.permissions.global.allow, deny: this.config.permissions.global.deny },
      { allow: [], deny: [] },
      { allow: [], deny: [] },
    ]);
  }

  private needsApproval(toolName: string): boolean {
    const m = this.registry.manifests.get(toolName);
    return !!m && (m.requireApproval || this.config.permissions.requireApproval.includes(toolName));
  }

  /**
   * Handle one incoming owner message. Returns the reply text.
   * Every tool call the LLM requests goes through the ToolGate.
   */
  async handleMessage(sessionId: string, fromPhone: string, text: string): Promise<string> {
    const runId = randomUUID();
    this.liveRuns.add(runId);
    this.messageCount += 1;
    // Host-minted authority. The LLM and tool handlers never see this object.
    const auth: RunAuthority = mintRunAuthority(runId, sessionId);

    const ctx: ToolContext = {
      sessionId,
      ownerPhone: this.config.owner.phone,
      sandboxRoots: this.config.sandbox.roots,
      memoryDir: this.config.memory.dir,
      askOwner: async (question: string) => {
        await this.onSendToOwner(`❓ ${question}\nReply YES or NO.`);
        return false; // simplified: real yes/no handled via approvals module for tools
      },
    };

    const gate = new ToolGate({
      runId,
      sessionId,
      policy: this.buildPolicy(),
      manifests: this.registry.manifests,
      handlers: this.registry.handlers,
      ctx,
      sendToOwner: (t) => this.onSendToOwner(t),
      hooks: [
        (call) => this.memory.log(`tool: ${call.name} ${JSON.stringify(call.args).slice(0, 200)}`),
        (call) => {
          this.toolCounts.set(call.name, (this.toolCounts.get(call.name) ?? 0) + 1);
        },
      ],
      isRunLive: () => this.liveRuns.has(runId),
    });

    // Patch manifests with config-level requireApproval before the loop.
    for (const name of this.config.permissions.requireApproval) {
      const m = this.registry.manifests.get(name);
      if (m) m.requireApproval = true;
    }
    void this.needsApproval; // (kept for future per-tool policy extensions)

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content: `Long-term memory:\n${this.memory.readMemory()}\n\nToday so far:\n${this.memory.readToday()}`,
      },
      { role: "user", content: text },
    ];

    try {
      let reply = "";
      for (let i = 0; i < this.config.llm.maxToolIterations; i++) {
        const msg = await this.llm.chat(messages, this.registry.listManifests());
        messages.push(msg);
        if (!msg.toolCall) {
          reply = msg.content;
          break;
        }
        const outcome = await gate.run(auth, msg.toolCall);
        const result: ToolResult = outcome.ok
          ? outcome.result
          : { ok: false, output: "", error: `BLOCKED: ${outcome.blocked}` };
        messages.push({
          role: "tool",
          content: "",
          toolResult: result,
        });
        if (!outcome.ok) {
          // Tell the LLM it was blocked so it can explain instead of retrying blindly.
          messages.push({
            role: "user",
            content: `That tool call was blocked (${outcome.blocked}). Explain to Virat and stop trying that tool.`,
          });
        }
      }
      if (!reply) reply = "I ran out of steps — can you rephrase that?";
      this.memory.log(`Q: ${text.slice(0, 200)} | A: ${reply.slice(0, 200)}`);
      return reply;
    } finally {
      this.liveRuns.delete(runId);
    }
  }

  getMemory(): MemoryManager {
    return this.memory;
  }
}
