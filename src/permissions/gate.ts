/**
 * Before-tool-call gate — replicates OpenClaw RE finding #3
 * (agents/agent-tools.before-tool-call.policy.ts).
 *
 * ORDER IS LOAD-BEARING. Do not reorder these stages — the source this is
 * derived from explicitly documents that reordering breaks security invariants:
 *
 *   1. admitSingleToolCallLoop  — infinite-loop prevention (same tool+args twice in a row)
 *   2. ownerProbes              — session still owned by the owner? run still live?
 *   3. trustedPolicies          — 3-layer policy pipeline evaluation (deny wins)
 *   4. approvals                — human approval for sensitive/requireApproval tools
 *   5. hooks                    — plugin before_tool_call hooks (logging/audit)
 *   6. finalApproval            — last-chance owner check right before execution
 *        -> execute
 *
 * The gate is the ONLY path from "LLM wants a tool" to "tool executes".
 * Tool handlers are never called directly by agent code.
 */
import { assertAuthority, type RunAuthority } from "./authority.js";
import { decideTool, type ResolvedPolicy } from "./policy.js";
import { requestApproval } from "./approvals.js";
import type { ToolCall, ToolContext, ToolHandler, ToolManifest, ToolResult } from "../core/types.js";

export interface GateDeps {
  runId: string;
  sessionId: string;
  policy: ResolvedPolicy;
  manifests: Map<string, ToolManifest>;
  handlers: Map<string, ToolHandler>;
  ctx: ToolContext;
  sendToOwner: (text: string) => Promise<void>;
  hooks: Array<(call: ToolCall) => void | Promise<void>>;
  isRunLive: () => boolean;
}

export type GateOutcome =
  | { ok: true; result: ToolResult }
  | { ok: false; blocked: string };

export class ToolGate {
  private lastCallKey: string | null = null;
  private repeatCount = 0;

  constructor(private deps: GateDeps) {}

  async run(auth: unknown, call: ToolCall): Promise<GateOutcome> {
    const d = this.deps;

    // ---- Stage 0: authority must be host-minted, current, and for this run.
    // Agent code can never reach past here with forged authority.
    try {
      assertAuthority(auth, d.runId, d.sessionId);
    } catch (e) {
      return { ok: false, blocked: `authority: ${(e as Error).message}` };
    }

    // ---- Stage 1: loop admission — same tool+args 3x in a row = stop.
    const key = `${call.name}:${JSON.stringify(call.args)}`;
    if (key === this.lastCallKey) {
      this.repeatCount += 1;
      if (this.repeatCount >= 2) {
        return { ok: false, blocked: "loop-guard: same tool call repeated, stopping" };
      }
    } else {
      this.lastCallKey = key;
      this.repeatCount = 0;
    }

    // ---- Stage 2: owner probes — run still live?
    if (!d.isRunLive()) {
      return { ok: false, blocked: "run no longer live" };
    }

    // ---- Stage 3: trusted policy evaluation (deny wins, closed by default).
    const manifest = d.manifests.get(call.name);
    if (!manifest) {
      return { ok: false, blocked: `unknown tool "${call.name}"` };
    }
    const decision = decideTool(call.name, d.policy);
    if (!decision.allowed) {
      return { ok: false, blocked: `policy: ${decision.reason}` };
    }

    // ---- Stage 4: human approval for sensitive tools.
    const needsApproval = manifest.requireApproval || manifest.permission === "sensitive";
    if (needsApproval) {
      const approved = await requestApproval(
        call.name,
        `Arguments: ${JSON.stringify(call.args).slice(0, 500)}`,
        d.sendToOwner,
      );
      if (!approved) {
        return { ok: false, blocked: "owner denied or approval timed out" };
      }
    }

    // ---- Stage 5: plugin hooks (audit logging etc.). Hooks cannot approve.
    for (const hook of d.hooks) {
      await hook(call);
    }

    // ---- Stage 6: final approval — re-check liveness right before execution.
    if (!d.isRunLive()) {
      return { ok: false, blocked: "run died during approval" };
    }

    const handler = d.handlers.get(call.name);
    if (!handler) {
      return { ok: false, blocked: `no handler for "${call.name}"` };
    }
    try {
      const result = await handler(call.args, d.ctx);
      return { ok: true, result };
    } catch (e) {
      return { ok: true, result: { ok: false, output: "", error: (e as Error).message } };
    }
  }
}
