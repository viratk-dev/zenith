/**
 * Shared types for virat-agent.
 * One-way dependency rule (from OpenClaw RE finding #10):
 * gateway -> core -> permissions -> config. Nothing imports "up".
 */

export type PermissionLevel = "read" | "write" | "sensitive";

export interface ToolManifest {
  /** Unique tool name, e.g. "web_search" */
  name: string;
  /** Human-readable description shown to the LLM */
  description: string;
  /** JSON-schema-ish parameter description (kept simple on purpose) */
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  /** Minimum permission level needed to run this tool */
  permission: PermissionLevel;
  /** If true, ALWAYS needs owner approval even when policy allows it */
  requireApproval: boolean;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

/** What a tool handler is allowed to see. No authority objects leak here. */
export interface ToolContext {
  sessionId: string;
  ownerPhone: string;
  sandboxRoots: string[];
  memoryDir: string;
  /** Ask the owner a yes/no question over WhatsApp. Resolves true/false. */
  askOwner: (question: string) => Promise<boolean>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
}

export interface LlmProvider {
  name: string;
  chat(messages: ChatMessage[], tools: ToolManifest[]): Promise<ChatMessage>;
}

export interface AgentConfig {
  owner: { phone: string; lid?: string; secondaryPhones?: string[]; secondaryLids?: string[] };
  llm: {
    provider: "ollama" | "openai-compatible";
    model: string;
    baseUrl: string;
    apiKey?: string;
    maxToolIterations: number;
    timeoutMs: number;
  };
  whatsapp: { sessionDir: string; printQr: boolean };
  permissions: {
    global: { allow: string[]; deny: string[] };
    requireApproval: string[];
  };
  memory: { dir: string };
  gateway: { host: string; port: number; secret: string };
  sandbox: { roots: string[] };
}
