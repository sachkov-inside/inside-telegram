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

/** Updates run in lanes (ADR 0002): one per user conversation and one per group. */
const updates: DurableQueue<"telegram_updates"> = {
  table: "telegram_updates",
  key: ["bot_identity", "update_id"],
  order: ["update_id"],
  lane: ["bot_identity", "lane_key"],
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
        lane_key: laneOf(payload),
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
 * A group's membership changes and join requests run in that chat's lane, so they keep their
 * relative order and only one of them at a time waits on the provider lock (ADR 0003). Every
 * other update runs in the lane of the user who sent it; one without a sender runs in no lane.
 */
function laneOf(payload: unknown): string | null {
  const update = record(payload);
  const chat = record(
    record(
      update?.chat_member ??
        update?.my_chat_member ??
        update?.chat_join_request,
    )?.chat,
  );
  const id =
    chat?.id != null && chat.type !== "private"
      ? chat.id
      : [
          "message",
          "edited_message",
          "callback_query",
          "chat_join_request",
          "my_chat_member",
        ]
          .map((kind) => record(record(update?.[kind])?.from)?.id)
          .find((value) => value != null);
  return typeof id === "number" || typeof id === "string" ? String(id) : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
