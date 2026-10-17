# STATUS.md — honest build status (2026-10-16)

## What was built
Complete TypeScript codebase at `~/workspace/virat-agent/` (~1,800 lines):
config, agent loop, 3-layer permission pipeline, WeakSet authority, 6-stage
tool gate, WhatsApp channel (Baileys), raw-http gateway, memory manager,
6 starter tools, README. Committed locally, NOT pushed to GitHub (per instruction).

## What was tested LIVE ✅
- `npx tsc --noEmit` — clean, zero errors
- Security smoke tests (`node smoke-test.mjs`) — all 4 pass:
  1. forged authority object rejected
  2. stale generation rejected, fresh accepted after rotation
  3. policy: deny wins, unknown tools denied (closed by default)
  4. gate: unknown tool blocked, forged auth blocked, valid call executes,
     loop guard trips on 3rd identical call
- Config loader — loads example config, validates owner.phone
- Agent construction — builds with registry + memory, no errors
- Gateway boot — listens, `/health` returns ok, `/rpc` status works,
  wrong secret → 401

## What was NOT tested live ⚠️
- **WhatsApp pairing** — Baileys QR flow not exercised (needs a real phone scan).
  Code follows Baileys v6 documented API; risk: API drift.
- **LLM loop end-to-end** — ✅ TESTED 2026-10-17: agent.handleMessage() ran against live deepseek-v4.1-flash via OpenAI-compatible router; agent replied in Hinglish correctly.
- **Approval flow over real WhatsApp** — logic unit-tested implicitly via
  `handleApprovalReply` (owner-only check), but not over a live chat.
- **Reminders delivery** — timer logic written; long-wait delivery not observed.
- `npm start` full boot — not run (would block on WhatsApp pairing).

## Known limitations (by design)
- Single agent instance (OpenClaw supports many; out of scope for v0.1).
- Policy is 3 layers, not OpenClaw's 8 (documented simplification).
- web_search uses DuckDuckGo instant API — good for quick facts, not deep research.
- exec_shell blocklist is heuristic, not a sandbox — approval gate is the real defense.
- No Tailscale/proxy auth on the gateway — bind to 127.0.0.1 and use the secret.

## Before first real run
1. `cp config.example.yaml config.yaml`, set `owner.phone` (your WhatsApp digits).
2. Install Ollama + `ollama pull llama3.1:8b` (or point config at an OpenAI-compatible endpoint).
3. `npm install && npm start`, scan the QR.
4. Send "hello" on WhatsApp. If it replies, you're live.
