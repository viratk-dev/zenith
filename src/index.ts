/**
 * virat-agent entry point.
 * Boot order: config -> agent -> WhatsApp channel -> gateway -> KV bridge.
 * `npm install && npm start` — pair WhatsApp via the printed QR, then chat.
 *
 * When stdout is a TTY (interactive terminal), the premium TUI launches
 * (src/tui/). Otherwise (piped, logged, systemd) it keeps the classic
 * plain console.log behavior. Set NO_TUI=1 to force plain mode.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import type { AgentConfig } from "./core/types.js";
import { Agent } from "./core/agent.js";
import { WhatsAppChannel } from "./channels/whatsapp/channel.js";
import { Gateway } from "./gateway/server.js";

/** Load .env (gitignored) into process.env — no dependency needed. */
function loadDotEnv(): void {
  const p = "./.env";
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

function ensureDirs(config: AgentConfig): void {
  for (const dir of [
    config.memory.dir,
    config.whatsapp.sessionDir,
    ...config.sandbox.roots,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

/** Classic headless path — unchanged behavior for pipes/logs/systemd. */
async function runPlain(config: AgentConfig): Promise<void> {
  const agent = new Agent(config);

  const wa = new WhatsAppChannel({
    sessionDir: config.whatsapp.sessionDir,
    printQr: config.whatsapp.printQr,
    ownerPhone: config.owner.phone,
    ownerLid: config.owner.lid,
    allowedSenders: config.owner.secondaryPhones || [],
    allowedSenderLids: config.owner.secondaryLids || [],
    onLog: (line) => console.log(`[wa] ${line}`),
    // Save raw QR for remote display (e.g. send as image to owner).
    // Also handles PAIRING-CODE:xxxx-xxxx from phone-number pairing.
    onQr: (qrData) => {
      if (qrData.startsWith("PAIRING-CODE:")) {
        const code = qrData.slice("PAIRING-CODE:".length);
        writeFileSync("./data/pairing-code.txt", code);
        console.log(`[wa] pairing code saved: ${code}`);
      } else {
        writeFileSync("./data/qr.txt", qrData);
        console.log("[wa] QR saved to ./data/qr.txt");
      }
    },
    onMessage: async (_from, text) => {
      const sessionId = `wa:${config.owner.phone}`;
      return agent.handleMessage(sessionId, config.owner.phone, text);
    },
  });

  // Agent -> owner messages go out over WhatsApp.
  agent.onSendToOwner = (text) => wa.sendToOwner(text);

  await wa.start();

  const gateway = new Gateway(config, agent);
  await gateway.listen();

  // KV bridge: connects the Zenith web app (via Upstash Redis).
  const { startBridge } = await import("./bridge/kv-bridge.js");
  startBridge(agent, (s) => console.log(s));

  console.log("virat-agent is running. Send it a WhatsApp message to begin.");
}

/** Interactive terminal UI path. */
async function runTui(config: AgentConfig): Promise<void> {
  const { TuiApp } = await import("./tui/app.js");
  const tui = new TuiApp({
    version: appVersion(),
    llmModel: config.llm.model,
    ownerPhone: config.owner.phone,
  });

  tui.showBoot("loading config…");
  const agent = new Agent(config);
  tui.attachAgent(agent);

  tui.setBootStatus("starting WhatsApp…");
  const wa = new WhatsAppChannel({
    sessionDir: config.whatsapp.sessionDir,
    printQr: false, // TUI renders the QR itself
    ownerPhone: config.owner.phone,
    ownerLid: config.owner.lid,
    allowedSenders: config.owner.secondaryPhones || [],
    allowedSenderLids: config.owner.secondaryLids || [],
    onLog: (line) => tui.log("wa", line),
    onConnectionChange: (up) => tui.setWa(up ? "connected" : "disconnected"),
    onQr: (qrData) => {
      // Persist (plain path compatibility) + show in TUI.
      if (qrData.startsWith("PAIRING-CODE:")) {
        writeFileSync("./data/pairing-code.txt", qrData.slice("PAIRING-CODE:".length));
      } else {
        writeFileSync("./data/qr.txt", qrData);
      }
      tui.showQrData(qrData);
    },
    onMessage: async (_from, text) => {
      const sessionId = `wa:${config.owner.phone}`;
      tui.log("wa", `from ${_from}: ${text.slice(0, 120)}`);
      const reply = await agent.handleMessage(sessionId, config.owner.phone, text);
      tui.log("agent", `reply sent (${reply.length} chars)`);
      return reply;
    },
  });

  // Agent -> owner messages go out over WhatsApp.
  agent.onSendToOwner = (text) => wa.sendToOwner(text);

  await wa.start();

  tui.setBootStatus("starting gateway…");
  const gateway = new Gateway(config, agent);
  await gateway.listen();
  tui.log("gw", `listening on ${config.gateway.host}:${config.gateway.port}`);

  tui.setBootStatus("starting web bridge…");
  const { startBridge } = await import("./bridge/kv-bridge.js");
  let bridgeOk = false;
  try {
    startBridge(agent, (s) => tui.log("bridge", s));
    bridgeOk = true;
  } catch (e) {
    tui.log("bridge", `bridge failed: ${(e as Error).message}`);
  }
  tui.setBridge(bridgeOk);

  tui.showDashboard();
  tui.log("sys", "Zenith is running. Type 'help' for commands, or just chat.");

  // Park forever — the TUI owns the process lifetime (quit/restart exit explicitly).
  await new Promise<void>(() => {});
}

async function main(): Promise<void> {
  const config = loadConfig();
  ensureDirs(config);
  const useTui = process.stdout.isTTY === true && process.env.NO_TUI !== "1";
  if (useTui) {
    await runTui(config);
  } else {
    await runPlain(config);
  }
}

main().catch((e) => {
  console.error("fatal:", (e as Error).message);
  process.exit(1);
});
