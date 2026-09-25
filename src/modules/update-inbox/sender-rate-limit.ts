import type { SenderRate } from "../../config/application-config.js";

/**
 * `admitted` runs the request. `notify` refuses it and tells the sender once per window;
 * `silent` refuses it without a reply.
 */
export type SenderAdmission = "admitted" | "notify" | "silent";

interface SenderWindow {
  admitted: { readonly updateId: string; readonly at: number }[];
  notice?: { readonly updateId: string; readonly at: number };
}

/** Counts each sender's requests in process memory; a restart starts every window afresh. */
export class SenderRateLimit {
  private readonly senders = new Map<string, SenderWindow>();
  private sweptAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly policy: SenderRate) {}

  /** Senders with a request or notice still inside the window. */
  get trackedSenders(): number {
    return this.senders.size;
  }

  admit(sender: string, updateId: string, receivedAt: Date): SenderAdmission {
    const at = receivedAt.getTime();
    const since = at - this.policy.windowMs;
    if (this.sweptAt <= since) this.forgetIdle(since, at);
    const window = this.senders.get(sender) ?? { admitted: [] };
    this.senders.set(sender, window);
    window.admitted = window.admitted.filter((request) => request.at > since);
    // A retried update keeps its first decision, so its work and notice stay idempotent.
    if (window.admitted.some((request) => request.updateId === updateId))
      return "admitted";
    if (window.notice?.updateId === updateId) return "notify";
    if (window.admitted.length < this.policy.requests) {
      window.admitted.push({ updateId, at });
      return "admitted";
    }
    if (window.notice !== undefined && window.notice.at > since)
      return "silent";
    window.notice = { updateId, at };
    return "notify";
  }

  /** Drops senders with nothing left in the window, at most once per window. */
  private forgetIdle(since: number, at: number): void {
    for (const [sender, window] of this.senders)
      if (
        window.admitted.every((request) => request.at <= since) &&
        (window.notice === undefined || window.notice.at <= since)
      )
        this.senders.delete(sender);
    this.sweptAt = at;
  }
}
