/**
 * WhatsApp channel via Baileys (@whiskeysockets/baileys) — free, no API key.
 *
 * First run: a QR code prints in the terminal. Scan it with
 * WhatsApp > Linked devices > Link a device. Session persists in
 * config.whatsapp.sessionDir so you only pair once.
 *
 * Security: ONLY the owner's phone number is ever answered. Messages from
 * anyone else are ignored (and logged). Approval replies (YES/NO <id>)
 * are consumed by the approvals module before reaching the agent.
 */
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import { HttpsProxyAgent } from "https-proxy-agent";
import { handleApprovalReply } from "../../permissions/approvals.js";

export interface WhatsAppChannelOpts {
  sessionDir: string;
  printQr: boolean;
  ownerPhone: string; // digits only, e.g. "919999999999"
  /** Owner's WhatsApp LID (learned from Baileys; falls back to auto-detect). */
  ownerLid?: string;
  /** Extra phone numbers allowed to command the agent (e.g. owner's 2nd SIM). */
  allowedSenders?: string[];
  /** Extra WhatsApp LIDs allowed (same as above, for LID-addressed messages). */
  allowedSenderLids?: string[];
  onMessage: (fromPhone: string, text: string) => Promise<string | null>;
  onLog: (line: string) => void;
  /** Called with the raw QR string when pairing is needed (for remote QR display). */
  onQr?: (qrData: string) => void;
  /** Fires on WhatsApp connect/disconnect (used by the TUI status pills). */
  onConnectionChange?: (connected: boolean) => void;
}

function toJid(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

function fromJid(jid: string | undefined | null): string {
  return (jid ?? "").split("@")[0].replace(/\D/g, "");
}

function extractText(msg: any): string | null {
  const m = msg.message;
  if (!m) return null;
  if (typeof m.conversation === "string") return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  return null;
}

export class WhatsAppChannel {
  private sock: WASocket | null = null;
  private pairCodeRequested = false;
  /** IDs of messages the agent sent itself — skipped on echo (loop guard). */
  private sentIds = new Set<string>();
  /** Owner's LID (WhatsApp Linked Identity), auto-detected or from config. */
  private ownerLid: string | null = null;

  constructor(private opts: WhatsAppChannelOpts) {}

  async sendToOwner(text: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");
    const sent = await this.sock.sendMessage(toJid(this.opts.ownerPhone), { text });
    if (sent?.key?.id) this.sentIds.add(sent.key.id);
  }

  /**
   * Request a phone-number pairing code (no QR scan needed).
   * The owner enters this code in WhatsApp > Linked devices > Link a device
   * > "Link with phone number instead".
   */
  async requestPairingCode(phone: string): Promise<string> {
    if (!this.sock) throw new Error("WhatsApp socket not started");
    const digits = phone.replace(/\D/g, "");
    const code = await (this.sock as any).requestPairingCode(digits);
    // Format as XXXX-XXXX for readability.
    return code.length === 8
      ? `${code.slice(0, 4)}-${code.slice(4)}`
      : code;
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.sessionDir);

    const connect = () => {
      // Route the WhatsApp WebSocket through the env proxy when one is set
      // (this environment requires it; without it TLS fails).
      const proxyUrl =
        process.env.HTTPS_PROXY || process.env.https_proxy || "";
      const socketOpts: Record<string, unknown> = {
        auth: state,
        // We print the QR ourselves for a nicer terminal experience.
        printQRInTerminal: false,
      };
      if (proxyUrl) {
        socketOpts.agent = new HttpsProxyAgent(proxyUrl);
      }
      this.sock = makeWASocket(socketOpts as any);

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && this.opts.printQr) {
          this.opts.onLog("Scan this QR with WhatsApp > Linked devices:");
          qrcode.generate(qr, { small: true });
          try { this.opts.onQr?.(qr); } catch { /* qr hook is best-effort */ }
          // Phone-number pairing (no QR scan needed): if PAIR_PHONE is set,
          // request the code now — the socket is ready at this point.
          if (process.env.PAIR_PHONE && !this.pairCodeRequested) {
            this.pairCodeRequested = true;
            this.requestPairingCode(process.env.PAIR_PHONE)
              .then((code) => {
                this.opts.onLog(`Pairing code for ${process.env.PAIR_PHONE}: ${code}`);
                this.opts.onQr?.(`PAIRING-CODE:${code}`);
              })
              .catch((e) => this.opts.onLog(`pairing code failed: ${(e as Error).message}`));
          }
        }
        if (connection === "open") {
          this.opts.onLog("WhatsApp connected.");
          try { this.opts.onConnectionChange?.(true); } catch { /* status hook is best-effort */ }
          // Auto-detect owner's LID for self-chat matching (WhatsApp privacy IDs).
          try {
            const me = (this.sock as any)?.user;
            const lid = me?.lid
              ? String(me.lid).split("@")[0].split(":")[0]
              : null;
            if (lid) {
              this.ownerLid = lid;
              this.opts.onLog(`owner LID detected: ${lid}`);
            } else if (this.opts.ownerLid) {
              this.ownerLid = this.opts.ownerLid;
            }
          } catch { /* LID detect is best-effort */ }
        }
        if (connection === "close") {
          const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          try { this.opts.onConnectionChange?.(false); } catch { /* status hook is best-effort */ }
          this.opts.onLog(
            loggedOut
              ? "WhatsApp logged out — delete the session dir and re-pair."
              : `WhatsApp disconnected (${code}), reconnecting in 5s…`,
          );
          if (!loggedOut) setTimeout(connect, 5000);
        }
      });

      this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
          try {
            if (!msg.message) continue;
            // Skip messages the agent itself sent (loop guard for self-chat).
            if (msg.key.id && this.sentIds.has(msg.key.id)) continue;
            const ownerJid = toJid(this.opts.ownerPhone);
            const remoteJid = msg.key.remoteJid || "";
            // Self-chat can arrive as phone JID or LID JID (WhatsApp privacy).
            const ownerLidJid = this.ownerLid ? `${this.ownerLid}@lid` : null;
            const isSelfChat =
              remoteJid === ownerJid || (ownerLidJid !== null && remoteJid === ownerLidJid);
            const from = fromJid(msg.key.remoteJid);
            // Allowed senders: owner + configured extra numbers (2nd SIM etc.)
            // Matches on phone digits AND on LID (WhatsApp privacy IDs).
            const allowedPhones = new Set(
              [this.opts.ownerPhone, ...(this.opts.allowedSenders || [])].map((p) =>
                p.replace(/\D/g, "")
              )
            );
            const allowedLids = new Set([
              ...(this.ownerLid ? [this.ownerLid] : []),
              ...(this.opts.allowedSenderLids || []).map((l) =>
                l.replace(/\D/g, "")
              ),
            ]);
            const fromLid = remoteJid.endsWith("@lid") ? from : null;
            // Debug: log raw addressing for non-owner messages once.
            if (!isSelfChat && !allowedPhones.has(from)) {
              this.opts.onLog(
                `debug msg: remoteJid=${remoteJid} fromMe=${msg.key.fromMe} ` +
                `participant=${msg.key.participant || "-"} text=${(extractText(msg) || "").slice(0, 30)}`
              );
            }
            // Accept: (a) owner's self-notes (fromMe in self-chat),
            // (b) messages from owner or allowed sender numbers/LIDs.
            const isOwnerMsg =
              (msg.key.fromMe && isSelfChat) ||
              allowedPhones.has(from) ||
              (fromLid !== null && allowedLids.has(fromLid));
            const text = extractText(msg);
            if (!text || !isOwnerMsg) {
              if (text && !isOwnerMsg)
                this.opts.onLog(`ignored message from non-owner ${from}`);
              continue;
            }
            // Approval replies are consumed here, never reach the agent.
            if (handleApprovalReply(from, this.opts.ownerPhone, text)) {
              this.opts.onLog(`consumed approval reply: ${text.slice(0, 40)}`);
              continue;
            }
            const reply = await this.opts.onMessage(from, text);
            if (reply) {
              const sent = await this.sock!.sendMessage(msg.key.remoteJid!, { text: reply });
              if (sent?.key?.id) this.sentIds.add(sent.key.id);
            }
          } catch (e) {
            this.opts.onLog(`message handling error: ${(e as Error).message}`);
          }
        }
      });
    };

    connect();
  }
}
