/**
 * Ordered tool-policy pipeline — replicates OpenClaw RE finding #2
 * (agents/tool-policy-pipeline.ts), simplified from 8 layers to 3:
 *
 *   global (config) -> agent (per-run overrides) -> session (per-chat overrides)
 *
 * Each layer may allow or deny a tool. Composition rule: DENY ALWAYS WINS.
 * A tool runs only if allowed by at least one layer and denied by none.
 * Tools not mentioned anywhere default to DENY (closed by default).
 */

export interface PolicyLayer {
  allow: string[];
  deny: string[];
}

export interface ResolvedPolicy {
  /** Final allow-list after composing all layers */
  allow: Set<string>;
  /** Final deny-list after composing all layers */
  deny: Set<string>;
}

export function resolvePolicy(layers: PolicyLayer[]): ResolvedPolicy {
  const allow = new Set<string>();
  const deny = new Set<string>();
  // Order matters: later layers can only ADD denies, never remove them.
  for (const layer of layers) {
    for (const t of layer.allow) allow.add(t);
    for (const t of layer.deny) deny.add(t);
  }
  // Deny wins: strip denied tools from the allow set.
  for (const t of deny) allow.delete(t);
  return { allow, deny };
}

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export function decideTool(
  toolName: string,
  policy: ResolvedPolicy,
): PolicyDecision {
  if (policy.deny.has(toolName)) {
    return { allowed: false, reason: `denied by policy layer` };
  }
  if (!policy.allow.has(toolName)) {
    return { allowed: false, reason: `not in allow-list (closed by default)` };
  }
  return { allowed: true };
}
