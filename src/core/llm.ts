/**
 * LLM provider interface + implementations.
 *
 * Default is FREE: local Ollama (no API key). Swap to any OpenAI-compatible
 * endpoint (OpenRouter, etc.) via config — no code changes needed.
 */
import type { ChatMessage, LlmProvider, ToolManifest } from "./types.js";

function toolManifestsToOpenAI(tools: ToolManifest[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, v]) => [
            k,
            { type: v.type, description: v.description },
          ]),
        ),
        required: Object.entries(t.parameters)
          .filter(([, v]) => v.required)
          .map(([k]) => k),
      },
    },
  }));
}

function openAIMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCall) {
      return {
        role: "assistant" as const,
        content: m.content || null,
        tool_calls: [
          {
            id: `call_${Date.now()}`,
            type: "function" as const,
            function: {
              name: m.toolCall.name,
              arguments: JSON.stringify(m.toolCall.args),
            },
          },
        ],
      };
    }
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        tool_call_id: `call_${Date.now()}`,
        content: m.toolResult?.ok
          ? m.toolResult.output
          : `ERROR: ${m.toolResult?.error ?? "unknown"}`,
      };
    }
    return { role: m.role as "system" | "user" | "assistant", content: m.content };
  });
}

async function chatOnce(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  messages: ChatMessage[],
  tools: ToolManifest[],
  timeoutMs: number,
): Promise<ChatMessage> {
  const doFetch = async (attempt: number): Promise<ChatMessage> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: openAIMessages(messages),
        tools: toolManifestsToOpenAI(tools),
        tool_choice: "auto",
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Retry on rate limits (429 / 402 FREE_LIMIT): Pollinations free tier
      // allows ~1 request per 30s. Parse "Retry after Ns" if present.
      if (res.status === 429 || res.status === 402) {
        const m = text.match(/retry after (\d+)s/i);
        const waitMs = m ? (parseInt(m[1], 10) + 2) * 1000 : 32000;
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, waitMs));
          return doFetch(attempt + 1);
        }
      }
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as any;
    const choice = data.choices?.[0]?.message;
    if (!choice) throw new Error("LLM returned no choices");
    const tc = choice.tool_calls?.[0];
    if (tc?.function) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }
      return {
        role: "assistant",
        content: choice.content ?? "",
        toolCall: { name: tc.function.name, args },
      };
    }
    return { role: "assistant", content: choice.content ?? "" };
  } finally {
    clearTimeout(timer);
  }
  };
  return doFetch(0);
}

/** Local Ollama — free, no key. Requires `ollama serve` + a pulled model. */
export function createOllamaProvider(
  baseUrl: string,
  model: string,
  timeoutMs: number,
): LlmProvider {
  return {
    name: `ollama/${model}`,
    chat: (messages, tools) => chatOnce(baseUrl, undefined, model, messages, tools, timeoutMs),
  };
}

/** Any OpenAI-compatible API (OpenRouter, etc.). */
export function createOpenAICompatibleProvider(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  timeoutMs: number,
): LlmProvider {
  return {
    name: `openai-compatible/${model}`,
    chat: (messages, tools) => chatOnce(baseUrl, apiKey, model, messages, tools, timeoutMs),
  };
}

export function createProvider(
  kind: "ollama" | "openai-compatible",
  opts: { baseUrl: string; apiKey?: string; model: string; timeoutMs: number },
): LlmProvider {
  return kind === "ollama"
    ? createOllamaProvider(opts.baseUrl, opts.model, opts.timeoutMs)
    : createOpenAICompatibleProvider(opts.baseUrl, opts.apiKey, opts.model, opts.timeoutMs);
}
