/**
 * Gateway — replicates OpenClaw RE finding #4 (gateway/server-http.ts):
 * raw node:http with a tiny RPC dispatcher. No Express, no Fastify.
 *
 * The gateway is a THIN SHELL (finding #10): it authenticates the caller,
 * routes the message to the agent, and returns the reply. All intelligence
 * lives in core/agent. Dependency direction is strictly one-way.
 *
 * RPC methods (POST /rpc, JSON body { method, params, secret }):
 *   - "chat"   { from, text }        -> agent reply (owner only)
 *   - "status" {}                    -> { ok, uptime, pendingApprovals }
 *   - "approve"{ id, yes }           -> resolve a pending approval (owner only)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Agent } from "../core/agent.js";
import { pendingApprovalCount } from "../permissions/approvals.js";
import type { AgentConfig } from "../core/types.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => {
      chunks.push(c);
      if (chunks.length > 100) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export class Gateway {
  private server = createServer(this.handle.bind(this));
  private startedAt = Date.now();

  constructor(
    private config: AgentConfig,
    private agent: Agent,
  ) {}

  private checkSecret(params: any): boolean {
    return typeof params?.secret === "string" && params.secret === this.config.gateway.secret;
  }

  private checkOwner(from: string): boolean {
    const digits = String(from ?? "").replace(/\D/g, "");
    const allowed = [
      this.config.owner.phone,
      ...(this.config.owner.secondaryPhones || []),
    ].map((p) => p.replace(/\D/g, ""));
    return allowed.includes(digits);
  }

  private json(res: ServerResponse, code: number, obj: unknown): void {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(JSON.stringify(obj));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      return this.json(res, 200, { ok: true, uptime: Date.now() - this.startedAt });
    }
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    let body: any;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return this.json(res, 400, { ok: false, error: "bad json" });
    }
    if (!this.checkSecret(body)) {
      return this.json(res, 401, { ok: false, error: "bad secret" });
    }
    try {
      switch (body.method) {
        case "status":
          return this.json(res, 200, {
            ok: true,
            uptime: Date.now() - this.startedAt,
            pendingApprovals: pendingApprovalCount(),
          });
        case "pending": {
          const from = String(body.params?.from ?? "");
          if (!this.checkOwner(from)) {
            return this.json(res, 403, { ok: false, error: "not the owner" });
          }
          const { listPendingApprovals } = await import("../permissions/approvals.js");
          return this.json(res, 200, { ok: true, approvals: listPendingApprovals() });
        }
        case "chat": {
          const from = String(body.params?.from ?? "");
          const text = String(body.params?.text ?? "");
          if (!this.checkOwner(from)) {
            return this.json(res, 403, { ok: false, error: "not the owner" });
          }
          const reply = await this.agent.handleMessage(`rpc:${from}`, from, text);
          return this.json(res, 200, { ok: true, reply });
        }
        case "approve": {
          const from = String(body.params?.from ?? "");
          if (!this.checkOwner(from)) {
            return this.json(res, 403, { ok: false, error: "not the owner" });
          }
          const { resolveApproval } = await import("../permissions/approvals.js");
          const ok = resolveApproval(String(body.params?.id ?? ""), body.params?.yes === true);
          return this.json(res, 200, { ok });
        }
        default:
          return this.json(res, 404, { ok: false, error: "unknown method" });
      }
    } catch (e) {
      return this.json(res, 500, { ok: false, error: (e as Error).message });
    }
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.gateway.port, this.config.gateway.host, () => {
        console.log(
          `gateway listening on http://${this.config.gateway.host}:${this.config.gateway.port}`,
        );
        resolve();
      });
    });
  }
}
