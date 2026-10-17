/**
 * Unforgeable host-only authority — replicates OpenClaw RE finding #1
 * (agents/admitted-run-context.ts) and #6 (lifecycle generations).
 *
 * RULE: Authority objects are created ONLY by host functions in this module
 * and registered in a module-private WeakSet. There is NO code path by which
 * agent-executed code (LLM output, tool handlers, channel code) can mint
 * authority. The gate (gate.ts) is the only consumer.
 *
 * Each registry rotation bumps a generation counter; authority carries its
 * generation and validation rejects stale generations (finding #6).
 */

export interface RunAuthority {
  readonly runId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly issuedAt: number;
  /** Opaque brand — never inspected by value, only by WeakSet membership. */
  readonly __brand: "virat-agent-authority";
}

// Module-private. Nothing outside this file can reach it.
const VALID_AUTHORITIES = new WeakSet<object>();
let generation = 0;

/** Host-only: rotate the registry (e.g. on config reload). Invalidates old authority. */
export function rotateAuthorityGeneration(): number {
  generation += 1;
  return generation;
}

/** Host-only: mint authority for one admitted agent run. Called by the gateway. */
export function mintRunAuthority(runId: string, sessionId: string): RunAuthority {
  const auth: RunAuthority = Object.freeze({
    runId,
    sessionId,
    generation,
    issuedAt: Date.now(),
    __brand: "virat-agent-authority" as const,
  });
  VALID_AUTHORITIES.add(auth);
  return auth;
}

/**
 * Validate authority. Throws unless ALL hold:
 *  - object is in the host-only WeakSet (unforgeable)
 *  - generation is current (not stale/revoked)
 *  - runId/sessionId match the expected run
 */
export function assertAuthority(
  auth: unknown,
  expectedRunId: string,
  expectedSessionId: string,
): asserts auth is RunAuthority {
  if (typeof auth !== "object" || auth === null || !VALID_AUTHORITIES.has(auth)) {
    throw new Error("SECURITY: forged or unknown authority object rejected");
  }
  const a = auth as RunAuthority;
  if (a.generation !== generation) {
    throw new Error("SECURITY: stale authority generation rejected");
  }
  if (a.runId !== expectedRunId || a.sessionId !== expectedSessionId) {
    throw new Error("SECURITY: authority does not match this run/session");
  }
}
