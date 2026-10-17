/**
 * Persistent memory: MEMORY.md + daily logs + people notes.
 * The agent remembers Virat across sessions. Files are plain markdown
 * so Virat can read/edit them directly too.
 *
 * Layout under memoryDir:
 *   MEMORY.md            — curated long-term facts (append-only via addFact)
 *   2026-10-16.md        — daily log, one file per day
 *   people/<name>.md     — per-person notes
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";

export class MemoryManager {
  constructor(private dir: string) {
    mkdirSync(join(dir, "people"), { recursive: true });
  }

  private todayFile(): string {
    const d = new Date();
    const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.md`;
    return join(this.dir, name);
  }

  /** Append a timestamped line to today's log. */
  log(line: string): void {
    const ts = new Date().toISOString();
    appendFileSync(this.todayFile(), `- [${ts}] ${line}\n`);
  }

  /** Append a durable fact to MEMORY.md (dedupe by exact line). */
  addFact(fact: string): void {
    const path = join(this.dir, "MEMORY.md");
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "# MEMORY.md\n";
    const line = `- ${fact}`;
    if (!existing.includes(line)) {
      writeFileSync(path, existing.replace(/\s+$/, "") + `\n${line}\n`);
    }
  }

  /** Read the curated memory (truncated to maxChars). */
  readMemory(maxChars = 8000): string {
    const path = join(this.dir, "MEMORY.md");
    if (!existsSync(path)) return "(no long-term memory yet)";
    return readFileSync(path, "utf8").slice(0, maxChars);
  }

  /** Read today's log (truncated). */
  readToday(maxChars = 4000): string {
    const path = this.todayFile();
    if (!existsSync(path)) return "(nothing logged today yet)";
    return readFileSync(path, "utf8").slice(-maxChars);
  }

  /** Save/update a note about a person. */
  savePerson(name: string, note: string): void {
    const safe = basename(name).replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    const path = join(this.dir, "people", `${safe}.md`);
    const prev = existsSync(path) ? readFileSync(path, "utf8") : `# ${name}\n`;
    writeFileSync(path, prev.replace(/\s+$/, "") + `\n- ${new Date().toISOString()}: ${note}\n`);
  }

  /** Read a person's notes. */
  readPerson(name: string): string {
    const safe = basename(name).replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    const path = join(this.dir, "people", `${safe}.md`);
    return existsSync(path) ? readFileSync(path, "utf8") : `(no notes on ${name})`;
  }
}
