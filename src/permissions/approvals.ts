/**
 * Human approval for sensitive actions — replicates the OpenClaw
 * human-approval gate (RE phase 4, stage 4 of the before-tool-call chain).
 *
 * Flow: agent wants to run a sensitive tool -> approval requested ->
 * owner gets a WhatsApp message "Approve? reply YES <id> / NO <id>" ->
 * owner's next message resolves the promise. Timeout (5 min) = denied.
 *
 * Only the OWNER's phone number can approve. Anyone else's "yes" is ignored.
 */

export interface PendingApproval {
  id: string;
  toolName: string;
  summary: string;
  requestedAt: number;
  resolve: (approved: boolean) => void;
}

const pending = new Map<string, PendingApproval>();
let counter = 0;

export function requestApproval(
  toolName: string,
  summary: string,
  sendToOwner: (text: string) => Promise<void>,
  timeoutMs = 5 * 60 * 1000,
): Promise<boolean> {
  const id = `appr_${Date.now().toString(36)}_${(counter++).toString(36)}`;
  return new Promise<boolean>((resolve) => {
    const done = (approved: boolean) => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve(approved);
      }
    };
    pending.set(id, { id, toolName, summary, requestedAt: Date.now(), resolve: done });
    const timer = setTimeout(() => done(false), timeoutMs);
    // Clear the timer when resolved early so we don't leak.
    const originalResolve = done;
    pending.get(id)!.resolve = (approved: boolean) => {
      clearTimeout(timer);
      originalResolve(approved);
    };
    sendToOwner(
      `⚠️ Approval needed\n\nTool: ${toolName}\n${summary}\n\nReply YES ${id} to approve, NO ${id} to deny.\n(Expires in 5 min — no reply = denied)`,
    ).catch(() => done(false));
  });
}

/**
 * Try to match an incoming owner message against a pending approval.
 * Returns true if the message was consumed as an approval reply.
 */
export function handleApprovalReply(fromPhone: string, ownerPhone: string, text: string): boolean {
  if (fromPhone !== ownerPhone) return false; // only the owner can approve
  const m = text.trim().match(/^(yes|no)\s+(appr_[a-z0-9_]+)$/i);
  if (!m) return false;
  const approval = pending.get(m[2]);
  if (!approval) return false;
  approval.resolve(m[1].toLowerCase() === "yes");
  return true;
}

/** For status/debugging: how many approvals are waiting. */
export function pendingApprovalCount(): number {
  return pending.size;
}

/** Resolve a pending approval by ID (for gateway/web app). Returns false if not found. */
export function resolveApproval(id: string, approved: boolean): boolean {
  const approval = pending.get(id);
  if (!approval) return false;
  approval.resolve(approved);
  return true;
}

/** List pending approvals (for gateway/web app). */
export function listPendingApprovals(): Array<{ id: string; toolName: string; summary: string; requestedAt: number }> {
  return [...pending.values()].map(({ id, toolName, summary, requestedAt }) => ({
    id, toolName, summary, requestedAt,
  }));
}
