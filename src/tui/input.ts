/**
 * Raw-mode line editor with history, Emacs-ish keys, and arrow support.
 * Emits onChange (re-render) and onSubmit (Enter).
 */

export interface EditorCallbacks {
  onChange: () => void;
  onSubmit: (line: string) => void;
  onQuit: () => void;
  onClear: () => void;
}

const MAX_HISTORY = 100;

export class LineEditor {
  buffer = "";
  cursor = 0;
  private history: string[] = [];
  private hIdx = -1; // -1 = not browsing; else index into history
  private draft = ""; // saved buffer while browsing history

  constructor(private cb: EditorCallbacks) {}

  get text(): string {
    return this.buffer;
  }

  setText(t: string): void {
    this.buffer = t;
    this.cursor = t.length;
    this.hIdx = -1;
    this.cb.onChange();
  }

  clear(): void {
    this.buffer = "";
    this.cursor = 0;
    this.hIdx = -1;
    this.cb.onChange();
  }

  private pushHistory(line: string): void {
    if (!line.trim()) return;
    if (this.history[this.history.length - 1] !== line) {
      this.history.push(line);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.hIdx = -1;
  }

  submit(): void {
    const line = this.buffer;
    this.pushHistory(line);
    this.buffer = "";
    this.cursor = 0;
    this.draft = "";
    this.cb.onSubmit(line);
  }

  private browseHistory(dir: 1 | -1): void {
    if (this.history.length === 0) return;
    if (this.hIdx === -1) {
      if (dir === 1) return;
      this.draft = this.buffer;
      this.hIdx = this.history.length - 1;
    } else {
      const next = this.hIdx + dir;
      if (next < 0) return;
      if (next >= this.history.length) {
        this.hIdx = -1;
        this.buffer = this.draft;
        this.cursor = this.buffer.length;
        this.cb.onChange();
        return;
      }
      this.hIdx = next;
    }
    this.buffer = this.history[this.hIdx];
    this.cursor = this.buffer.length;
    this.cb.onChange();
  }

  private killWordBack(): void {
    const before = this.buffer.slice(0, this.cursor);
    const m = before.match(/^(.*?\S)\s*\S*$/);
    const cut = m ? m[1].length : 0;
    this.buffer = this.buffer.slice(0, cut) + this.buffer.slice(this.cursor);
    this.cursor = cut;
    this.hIdx = -1;
    this.cb.onChange();
  }

  /** Feed raw stdin bytes. Returns true if handled (always true). */
  handleData(data: Buffer): boolean {
    let i = 0;
    while (i < data.length) {
      const b = data[i];

      // Escape sequences: \x1b [ <params> <final>
      if (b === 0x1b) {
        if (data[i + 1] === 0x5b) {
          // CSI
          let j = i + 2;
          let params = "";
          while (j < data.length && data[j] >= 0x30 && data[j] <= 0x3f) {
            params += String.fromCharCode(data[j]);
            j++;
          }
          const fin = j < data.length ? String.fromCharCode(data[j]) : "";
          i = j + 1;
          this.handleCsi(params, fin);
          continue;
        }
        if (data[i + 1] === 0x4f) {
          // SS3 (Home/End on some terminals): \x1bOH / \x1bOF
          const fin = String.fromCharCode(data[i + 2] ?? 0);
          i += 3;
          if (fin === "H") {
            this.cursor = 0;
            this.cb.onChange();
          } else if (fin === "F") {
            this.cursor = this.buffer.length;
            this.cb.onChange();
          }
          continue;
        }
        // Bare ESC — treat as cancel.
        i += 1;
        this.clear();
        continue;
      }

      // Control characters.
      if (b < 0x20 || b === 0x7f) {
        i += 1;
        this.handleControl(b);
        continue;
      }

      // Printable (may be multi-byte UTF-8) — decode one char.
      let len = 1;
      if (b >= 0xf0) len = 4;
      else if (b >= 0xe0) len = 3;
      else if (b >= 0xc0) len = 2;
      const ch = data.slice(i, i + len).toString("utf8");
      i += len;
      this.insert(ch);
    }
    return true;
  }

  private handleCsi(_params: string, fin: string): void {
    switch (fin) {
      case "A": this.browseHistory(-1); break; // Up
      case "B": this.browseHistory(1); break;  // Down
      case "C": // Right
        if (this.cursor < this.buffer.length) {
          this.cursor += 1;
          this.cb.onChange();
        }
        break;
      case "D": // Left
        if (this.cursor > 0) {
          this.cursor -= 1;
          this.cb.onChange();
        }
        break;
      case "H": this.cursor = 0; this.cb.onChange(); break; // Home
      case "F": this.cursor = this.buffer.length; this.cb.onChange(); break; // End
      case "~":
        // Delete key is "\x1b[3~"
        if (_params === "3" && this.cursor < this.buffer.length) {
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
          this.cb.onChange();
        }
        break;
    }
  }

  private handleControl(b: number): void {
    switch (b) {
      case 0x0d: // Enter (CR)
      case 0x0a: // LF
        this.submit();
        break;
      case 0x7f: // Backspace (DEL)
      case 0x08: // Backspace (BS)
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
          this.cursor -= 1;
          this.hIdx = -1;
          this.cb.onChange();
        }
        break;
      case 0x01: this.cursor = 0; this.cb.onChange(); break; // Ctrl+A
      case 0x05: this.cursor = this.buffer.length; this.cb.onChange(); break; // Ctrl+E
      case 0x0b: // Ctrl+K — kill to end
        this.buffer = this.buffer.slice(0, this.cursor);
        this.hIdx = -1;
        this.cb.onChange();
        break;
      case 0x15: // Ctrl+U — kill whole line
        this.clear();
        break;
      case 0x17: this.killWordBack(); break; // Ctrl+W
      case 0x0c: this.cb.onClear(); break; // Ctrl+L
      case 0x03: // Ctrl+C
        if (this.buffer.length > 0) this.clear();
        else this.cb.onQuit();
        break;
      case 0x04: // Ctrl+D
        if (this.buffer.length === 0) this.cb.onQuit();
        break;
    }
  }

  private insert(ch: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + ch + this.buffer.slice(this.cursor);
    this.cursor += ch.length;
    this.hIdx = -1;
    this.cb.onChange();
  }
}
