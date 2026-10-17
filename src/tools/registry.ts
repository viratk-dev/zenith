/**
 * Tool registry: plugin-style tools with manifests.
 * Replicates OpenClaw's drop-in tool pattern (RE "Extension Points"):
 * register a manifest + handler and the tool is available to the agent
 * (subject to the permission gate — registration never implies permission).
 */
import type { ToolContext, ToolHandler, ToolManifest, ToolResult } from "../core/types.js";

export class ToolRegistry {
  readonly manifests = new Map<string, ToolManifest>();
  readonly handlers = new Map<string, ToolHandler>();

  register(manifest: ToolManifest, handler: ToolHandler): void {
    if (this.manifests.has(manifest.name)) {
      throw new Error(`tool "${manifest.name}" already registered`);
    }
    this.manifests.set(manifest.name, manifest);
    this.handlers.set(manifest.name, handler);
  }

  /** Manifests only — safe to show the LLM. Handlers never leak. */
  listManifests(): ToolManifest[] {
    return [...this.manifests.values()];
  }
}

/** Helper: wrap a simple sync/async function as a tool handler with error capture. */
export function tool(
  fn: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string,
): ToolHandler {
  return async (args, ctx): Promise<ToolResult> => {
    try {
      const output = await fn(args, ctx);
      return { ok: true, output: String(output).slice(0, 20000) };
    } catch (e) {
      return { ok: false, output: "", error: (e as Error).message };
    }
  };
}
