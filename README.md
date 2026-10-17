# ⚡ Zenith

**Your personal AI agent — controlled from WhatsApp, on any device.**

Zenith runs on your machine and you talk to it like a coworker over WhatsApp. It can search the web, read and write files, run code, set reminders, manage notes — and it asks for your approval before doing anything sensitive.

Free and open-source. No paid APIs required.

```
WhatsApp (your phone)  <-->  Zenith (your machine)
                                    |
                        Agent loop: message → AI → tools → reply
                                    |
                    Permission gate (every tool call passes here)
```

---

## ✨ Features

| | |
|---|---|
| 💬 **WhatsApp control** | Chat naturally — no app to install on your phone |
| 🧠 **18 built-in skills** | Coding, web building, design, video, research, documents… |
| 🛠️ **11 tools** | Web search, file ops, code execution, reminders, notes |
| 🔐 **Approval system** | Sensitive actions need your YES/NO on WhatsApp |
| 📱 **Web app** | Optional PWA dashboard — chat, code view, approvals |
| 🖥️ **Premium terminal UI** | Beautiful interactive dashboard when run locally |
| 🆓 **100% free** | Pollinations.ai (no key) or local Ollama |

---

## 🚀 Quickstart

**Requirements:** Node.js 18+

**One command:**
```bash
npx github:viratk-dev/zenith
```

That's it. First run opens a 2-minute setup wizard (phone number → AI model → WhatsApp pairing), then Zenith starts.

**Or manual:**
```bash
git clone https://github.com/viratk-dev/zenith.git
cd zenith
npm install
npm run setup
npm start
```

On first run, pair WhatsApp:
- **QR mode:** WhatsApp → Linked devices → Link a device → scan the QR
- **Code mode:** WhatsApp → Linked devices → Link with phone number → enter the 8-character code

Then just send a WhatsApp message to your linked number. Zenith replies. 🎉

---

## 💻 Terminal UI

When run in a terminal, Zenith shows a premium interactive dashboard:

```
┌─ ⚡ ZENITH ───────────────────────────── ● WhatsApp  ● AI  ● Bridge ─┐
│ 10:24:01  💬 You: remind me in 1 hour to drink water                  │
│ 10:24:03  🔧 tool: reminders.create({"in":"1h",...})                 │
│ 10:24:03  ⚠️  Approval needed: send reminder? [y/n]                   │
│ 10:24:05  ✓ Approved — reminder set                                  │
├──────────────────────────────────────────────────────────────────────┤
│ zenith> █                                                            │
└──────────────────────────────────────────────────────────────────────┘
```

Type `help` for commands: `chat`, `status`, `approve`, `pending`, `skills`, `tools`, `qr`, `quit`…

---

## 📱 Web App (optional)

A mobile + desktop PWA that talks to Zenith through Upstash Redis:

1. Deploy `web/` to Vercel (static)
2. Create a free Upstash Redis database
3. Open the app → Settings → paste Redis URL + token + your phone

---

## ⚙️ Configuration

`npm run setup` generates `config.yaml`. Key options:

```yaml
owner:
  phone: "919296933126"      # only this number controls Zenith

llm:
  provider: "openai-compatible"
  baseUrl: "https://text.pollinations.ai/openai"  # free, no key
  model: "openai"

permissions:
  requireApproval: ["exec_shell", "file_write", "file_edit"]
```

---

## 🏗️ Architecture

```
src/
├── core/          agent loop, LLM client, types
├── tui/           premium terminal UI
├── channels/      WhatsApp (Baileys)
├── tools/         11 tools: search, files, shell, notes, reminders…
├── permissions/   authority, policy, approval gate
├── gateway/       local HTTP RPC (127.0.0.1:18789)
├── bridge/        web-app link via Upstash Redis
├── memory/        markdown memory system
└── config.ts      config loader + validation
```

**Security model** (inspired by OpenClaw's design):
- Unforgeable tool authority (WeakSet — tools can't be faked by the LLM)
- 3-layer permission policy (global → channel → session)
- Human approval gate for sensitive tools (5-min timeout = deny)
- Filesystem sandbox — file tools can't escape `data/workspace`

---

## 🤝 Contributing

PRs welcome! Run `npm run typecheck` before submitting.

## 📄 License

MIT — see [LICENSE](LICENSE).

---

<p align="center">Built with ⚡ by <a href="https://github.com/viratk-dev">Virat Kumar</a></p>
