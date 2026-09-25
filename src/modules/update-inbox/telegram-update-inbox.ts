import { Inject, Injectable } from "@nestjs/common";

import { DATABASE, type Database } from "../../database/database.js";
import {
  claimNext,
  retryDelay,
  settle,
  type DurableQueue,
  type Lease,
} from "../../database/durable-queue.js";

const MAX_PROCESS_ATTEMPTS = 5;

/** One lane per sender: a sender's updates run in order, other senders run in parallel. */
const updates: DurableQueue<"telegram_updates"> = {
  table: "telegram_updates",
  key: ["bot_identity", "update_id"],
  order: ["update_id"],
  lane: ["bot_identity", "ordering_key"],
  ready: ["pending"],
  leased: "processing",
  due: "available_at",
  attempts: "process_attempt_count",
  leasedAt: "locked_at",
  leaseMs: 60_000,
  retry: { initialMs: 1000, maxMs: 16_000 },
};

export interface ClaimedTelegramUpdate {
  readonly botIdentity: string;
  readonly lease: Lease<"telegram_updates">;
  readonly payload: unknown;
  readonly processAttemptCount: number;
  readonly receivedAt: Date;
  readonly updateId: string;
}

@Injectable()
export class TelegramUpdateInbox {
  private readonly listeners = new Set<() => void>();

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** Calls `listener` after each newly accepted update so a worker can start at once. */
  onAccepted(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async accept(
    botIdentity: string,
    updateId: string,
    payload: unknown,
    receivedAt: Date,
  ): Promise<"accepted" | "duplicate"> {
    const inserted = await this.database
      .insertInto("telegram_updates")
      .values({
        available_at: receivedAt,
        bot_identity: botIdentity,
        failure_code: null,
        locked_at: null,
        ordering_key: senderOf(payload),
        payload,
        process_attempt_count: 0,
        processed_at: null,
        received_at: receivedAt,
        state: "pending",
        update_id: updateId,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning("update_id")
      .executeTakeFirst();
    if (!inserted) return "duplicate";
    for (const listener of this.listeners) listener();
    return "accepted";
  }

  async claimNext(now: Date): Promise<ClaimedTelegramUpdate | undefined> {
    const claimed = await claimNext(
      this.database,
      updates,
      now,
      {
        available_at: now,
        failure_code: "worker_lease_expired",
        locked_at: null,
        state: "pending",
      },
      {
        select: ["bot_identity", "payload", "received_at", "update_id"],
        where: (eb) => eb("payload", "is not", null),
      },
    );
    if (!claimed) return undefined;
    return {
      botIdentity: claimed.row.bot_identity,
      lease: claimed,
      payload: claimed.row.payload,
      processAttemptCount: claimed.attempt,
      receivedAt: claimed.row.received_at,
      updateId: claimed.row.update_id,
    };
  }

  /** Returns false when this worker no longer holds the update. */
  async markProcessed(
    update: ClaimedTelegramUpdate,
    processedAt: Date,
  ): Promise<boolean> {
    return settle(this.database, updates, update.lease, {
      failure_code: null,
      locked_at: null,
      payload: null,
      processed_at: processedAt,
      state: "processed",
    });
  }

  async markFailed(
    update: ClaimedTelegramUpdate,
    failedAt: Date,
    failureCode: string,
  ): Promise<"failed" | "retry_scheduled" | "lease_lost"> {
    const exhausted = update.processAttemptCount >= MAX_PROCESS_ATTEMPTS;
    const settled = await settle(
      this.database,
      updates,
      update.lease,
      exhausted
        ? {
            failure_code: failureCode,
            locked_at: null,
            payload: null,
            processed_at: failedAt,
            state: "failed",
          }
        : {
            available_at: new Date(
              failedAt.getTime() +
                retryDelay(updates, update.processAttemptCount),
            ),
            failure_code: failureCode,
            locked_at: null,
            state: "pending",
          },
    );
    if (!settled) return "lease_lost";
    return exhausted ? "failed" : "retry_scheduled";
  }
}

/**
 * The Telegram user an update concerns: the member whose status changed, otherwise the user who
 * acted, otherwise the chat. An update without one runs in no lane.
 */
function senderOf(payload: unknown): string | null {
  const update = record(payload);
  const id =
    record(record(record(update?.chat_member)?.new_chat_member)?.user)?.id ??
    [
      "callback_query",
      "chat_join_request",
      "my_chat_member",
      "message",
      "edited_message",
    ]
      .map((kind) => record(record(update?.[kind])?.from)?.id)
      .find((value) => value !== undefined) ??
    record(record(update?.message ?? update?.edited_message)?.chat)?.id;
  return typeof id === "number" || typeof id === "string" ? String(id) : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
