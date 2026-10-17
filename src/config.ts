/**
 * Config loader. Reads config.yaml (or VIRAT_AGENT_CONFIG path),
 * overlays documented env vars, validates the minimum required fields.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import type { AgentConfig } from "./core/types.js";

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export function loadConfig(): AgentConfig {
  const path = resolve(process.env.VIRAT_AGENT_CONFIG ?? "./config.yaml");
  if (!existsSync(path)) {
    throw new Error(
      `Config not found at ${path}. Copy config.example.yaml to config.yaml and fill it in.`,
    );
  }
  const raw = YAML.parse(readFileSync(path, "utf8")) as Record<string, any>;

  const ownerPhone = str(raw.owner?.phone).replace(/\D/g, "");
  if (!ownerPhone) throw new Error("config: owner.phone is required (digits only).");
  const ownerLid = str(raw.owner?.lid).replace(/\D/g, "") || undefined;
  const secondaryPhones = Array.isArray(raw.owner?.secondaryPhones)
    ? raw.owner.secondaryPhones.map((p: unknown) => str(p).replace(/\D/g, "")).filter(Boolean)
    : [];
  const secondaryLids = Array.isArray(raw.owner?.secondaryLids)
    ? raw.owner.secondaryLids.map((l: unknown) => str(l).replace(/\D/g, "")).filter(Boolean)
    : [];

  const llmProvider = raw.llm?.provider === "openai-compatible" ? "openai-compatible" : "ollama";

  const config: AgentConfig = {
    owner: { phone: ownerPhone, lid: ownerLid, secondaryPhones, secondaryLids },
    llm: {
      provider: llmProvider,
      model: str(raw.llm?.model, "llama3.1:8b"),
      baseUrl: str(raw.llm?.baseUrl, "http://127.0.0.1:11434"),
      apiKey: str(raw.llm?.apiKey) || process.env.VIRAT_AGENT_LLM_KEY || undefined,
      maxToolIterations: Number(raw.llm?.maxToolIterations) || 8,
      timeoutMs: Number(raw.llm?.timeoutMs) || 120000,
    },
    whatsapp: {
      sessionDir: str(raw.whatsapp?.sessionDir, "./data/wa-session"),
      printQr: raw.whatsapp?.printQr !== false,
    },
    permissions: {
      global: {
        allow: Array.isArray(raw.permissions?.global?.allow)
          ? raw.permissions.global.allow
          : [],
        deny: Array.isArray(raw.permissions?.global?.deny)
          ? raw.permissions.global.deny
          : [],
      },
      requireApproval: Array.isArray(raw.permissions?.requireApproval)
        ? raw.permissions.requireApproval
        : [],
    },
    memory: { dir: str(raw.memory?.dir, "./data/memory") },
    gateway: {
      host: str(raw.gateway?.host, "127.0.0.1"),
      port: Number(raw.gateway?.port) || 18789,
      secret:
        str(raw.gateway?.secret) ||
        process.env.VIRAT_AGENT_GATEWAY_SECRET ||
        "change-me",
    },
    sandbox: {
      roots: Array.isArray(raw.sandbox?.roots) && raw.sandbox.roots.length > 0
        ? raw.sandbox.roots.map((r: string) => resolve(str(r, "./data/workspace")))
        : [resolve("./data/workspace")],
    },
  };
  return config;
}
