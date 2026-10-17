/**
 * Security smoke tests — run with: node dist-test/smoke.mjs
 * (compiled separately; not part of the shipped build)
 *
 * Verifies the properties replicated from OpenClaw RE:
 *  1. Forged authority is rejected
 *  2. Stale generation authority is rejected
 *  3. Policy: deny wins, closed by default
 *  4. Gate: unknown tool blocked, disallowed tool blocked, loop guard trips
 */
import assert from "node:assert";
import {
  mintRunAuthority,
  assertAuthority,
  rotateAuthorityGeneration,
} from "./dist/permissions/authority.js";
import { resolvePolicy, decideTool } from "./dist/permissions/policy.js";
import { ToolGate } from "./dist/permissions/gate.js";

// 1. forged authority rejected
{
  const fake = Object.freeze({ runId: "r1", sessionId: "s1", generation: 0, issuedAt: 1, __brand: "virat-agent-authority" });
  assert.throws(() => assertAuthority(fake, "r1", "s1"), /forged/);
  console.log("ok 1: forged authority rejected");
}

// 2. stale generation rejected
{
  const auth = mintRunAuthority("r2", "s2");
  assert.doesNotThrow(() => assertAuthority(auth, "r2", "s2"));
  rotateAuthorityGeneration();
  assert.throws(() => assertAuthority(auth, "r2", "s2"), /stale/);
  const fresh = mintRunAuthority("r2", "s2");
  assert.doesNotThrow(() => assertAuthority(fresh, "r2", "s2"));
  console.log("ok 2: stale generation rejected, fresh accepted");
}

// 3. policy: deny wins, closed by default
{
  const p = resolvePolicy([
    { allow: ["a", "b"], deny: [] },
    { allow: [], deny: ["a"] },
  ]);
  assert.equal(decideTool("a", p).allowed, false); // denied
  assert.equal(decideTool("b", p).allowed, true); // allowed
  assert.equal(decideTool("zzz", p).allowed, false); // closed by default
  console.log("ok 3: deny wins, closed by default");
}

// 4. gate blocks unknown/disallowed tools and loop-guards
{
  const auth = mintRunAuthority("r4", "s4");
  const policy = resolvePolicy([{ allow: ["echo"], deny: [] }, { allow: [], deny: [] }, { allow: [], deny: [] }]);
  const gate = new ToolGate({
    runId: "r4",
    sessionId: "s4",
    policy,
    manifests: new Map([["echo", { name: "echo", description: "e", parameters: {}, permission: "read", requireApproval: false }]]),
    handlers: new Map([["echo", async (args) => ({ ok: true, output: "hi" })]]),
    ctx: { sessionId: "s4", ownerPhone: "1", sandboxRoots: [], memoryDir: "/tmp", askOwner: async () => false },
    sendToOwner: async () => {},
    hooks: [],
    isRunLive: () => true,
  });
  const bad1 = await gate.run(auth, { name: "nope", args: {} });
  assert.equal(bad1.ok, false);
  const bad2 = await gate.run({ forged: true }, { name: "echo", args: {} });
  assert.equal(bad2.ok, false);
  const good = await gate.run(auth, { name: "echo", args: {} });
  assert.equal(good.ok, true);
  // loop guard: same call 3x
  await gate.run(auth, { name: "echo", args: {} });
  const looped = await gate.run(auth, { name: "echo", args: {} });
  assert.equal(looped.ok, false);
  assert.match(looped.blocked ?? "", /loop-guard/);
  console.log("ok 4: gate blocks unknown/forged, allows valid, loop-guards");
}

console.log("\nAll security smoke tests passed.");
