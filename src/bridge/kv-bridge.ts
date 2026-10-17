/**
 * KV Bridge — connects Zenith to the web app via Upstash Redis (REST).
 *
 * Flow:
 *   Web app  --LPUSH zenith:inbox {from,text}-->  Bridge  --agent.handleMessage()-->
 *   Bridge   --LPUSH zenith:outbox:{from} reply-->  Web app (polls)
 *
 *   Approvals: Bridge pushes pending approvals to zenith:appr_push:{from},
 *   web app resolves via zenith:appr_resolve {id, yes}.
 *
 * Env: UPSTASH_URL, UPSTASH_TOKEN. Poll interval 3s.
 */
import { Agent } from "../core/agent.js";
import { listPendingApprovals, resolveApproval } from "../permissions/approvals.js";

const URL = process.env.UPSTASH_URL?.replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_TOKEN;
const POLL_MS = 3000;

async function redis(path: string, body?: unknown[]): Promise<any> {
  if (!URL || !TOKEN) throw new Error("UPSTASH_URL/UPSTASH_TOKEN not set");
  const hasBody = body && body.length > 0;
  const res = await fetch(`${URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`upstash HTTP ${res.status}`);
  return res.json();
}

const parse = (v: unknown): any => {
  if (!v) return null;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return { text: v }; }
  }
  return v;
};

export function startBridge(agent: Agent, onLog: (s: string) => void): void {
  if (!URL || !TOKEN) {
    onLog("[bridge] UPSTASH_URL/TOKEN not set — web app bridge disabled.");
    return;
  }
  const seenApprovals = new Set<string>();
  onLog("[bridge] KV bridge started (web app link active).");

  const loop = async () => {
    try {
      // 1. Inbox: new chat messages from web app
      const inbox = await redis("/rpop/zenith:inbox");
      const msg = parse(inbox.result);
      if (msg?.text && msg?.from) {
        onLog(`[bridge] web msg from ${msg.from}: ${String(msg.text).slice(0, 60)}`);
        try {
          const reply = await agent.handleMessage(`bridge:${msg.from}`, String(msg.from), String(msg.text));
          if (reply) {
            await redis(`/lpush/zenith:outbox:${msg.from}`, [{ text: reply, ts: Date.now() }]);
          }
        } catch (e) {
          await redis(`/lpush/zenith:outbox:${msg.from}`, [
            { text: `Error: ${(e as Error).message.slice(0, 200)}`, ts: Date.now() },
          ]);
        }
      }

      // 2. Push new pending approvals to web app
      for (const a of listPendingApprovals()) {
        if (!seenApprovals.has(a.id)) {
          seenApprovals.add(a.id);
          // Push to each known owner phone's approval queue
          for (const phone of [process.env.ZENITH_OWNER_PHONE, process.env.ZENITH_SECONDARY_PHONE].filter(Boolean)) {
            await redis(`/lpush/zenith:appr_push:${phone}`, [a]);
          }
        }
      }
      // Cleanup seen set when approvals resolve
      for (const id of [...seenApprovals]) {
        if (!listPendingApprovals().some((a) => a.id === id)) seenApprovals.delete(id);
      }

      // 3. Approval resolutions from web app
      const res = await redis("/rpop/zenith:appr_resolve");
      const r = parse(res.result);
      if (r?.id) {
        const ok = resolveApproval(String(r.id), r.yes === true);
        onLog(`[bridge] approval ${r.id} -> ${r.yes ? "YES" : "NO"} (${ok ? "resolved" : "not found"})`);
      }
    } catch (e) {
      onLog(`[bridge] poll error: ${(e as Error).message.slice(0, 120)}`);
    } finally {
      setTimeout(loop, POLL_MS);
    }
  };
  loop();
}
