import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { sql, type Selectable, type Transaction } from "kysely";
import type { Database, DatabaseSchema } from "../../database/database.js";
import type { Clock } from "../identity-linking/clock.js";
import { lockIdentityLinkAccount } from "../identity-linking/identity-link-account-lock.js";
import {
  deferTelegramSlot,
  reserveTelegramSlot,
} from "../outbound/telegram-transport-slots.js";
import type {
  TelegramMessages,
  TelegramDeliveryResult,
} from "../outbound/telegram-messages.js";
import {
  digest,
  parseNotification,
  type Category,
  type DeliveryEnvelope,
  type DispatchRequest,
  type DispatchResponse,
  type NotificationCommand,
  type NotificationResult,
  type ResultState,
} from "./notification-contract.js";
import type { NotificationTables } from "./notification-storage.js";
type Tx = Transaction<DatabaseSchema>;
type CommandRow = Selectable<NotificationTables["notification_commands"]>;
import type { NotificationAuthorization } from "./notification-ports.js";
export class NotificationProvider {
  constructor(
    private readonly db: Database,
    private readonly bot: string,
    private readonly clock: Clock,
    private readonly authorization: NotificationAuthorization,
    private readonly transport: TelegramMessages,
    private readonly quarantineKey: Buffer,
  ) {
    if (quarantineKey.length !== 32)
      throw new Error("Notification quarantine requires a 32-byte key");
  }

  // The caller acknowledges only after this transaction commits, including on replay/quarantine.
  async receive(
    bytes: Buffer,
    envelope: DeliveryEnvelope,
    category: Category,
  ): Promise<NotificationResult | undefined> {
    const c = parseNotification(bytes, envelope, category);
    return this.db.transaction().execute(async (tx) => {
      if (!c) {
        await this.quarantine(tx, bytes, "invalid_envelope");
        return;
      }
      const hash = digest(c);
      await lock(tx, `operation:${c.operationId}`);
      await lock(tx, c.deliveryRef);
      const replay = await tx
        .selectFrom("notification_commands")
        .selectAll()
        .where("operation_id", "=", c.operationId)
        .executeTakeFirst();
      if (replay) {
        if (
          replay.payload_digest !== hash ||
          replay.bot_identity !== this.bot
        ) {
          await this.quarantine(tx, bytes, "payload_conflict");
          return;
        }
        await this.enqueue(tx, replay.result);
        return replay.result;
      }
      const delivery = await tx
        .selectFrom("notification_deliveries")
        .selectAll()
        .where("delivery_ref", "=", c.deliveryRef)
        .executeTakeFirst();
      if (delivery) {
        const previous = await tx
          .selectFrom("notification_commands")
          .selectAll()
          .where("operation_id", "=", delivery.latest_operation)
          .executeTakeFirstOrThrow();
        const old = previous.command;
        // A revision cannot change the business delivery, recipient or category, nor release an uncertain effect.
        if (
          c.commandRevision <= old.commandRevision ||
          c.notificationRef !== old.notificationRef ||
          digest(c.binding) !== digest(old.binding) ||
          c.content.category !== old.content.category ||
          c.content.kind !== old.content.kind ||
          previous.bot_identity !== this.bot ||
          !["accepted", "retrying", "suppressed"].includes(previous.state)
        ) {
          await this.quarantine(tx, bytes, "operation_conflict");
          return;
        }
        const unsafe = await tx
          .selectFrom("notification_attempts")
          .select("attempt_ref")
          .where("operation_id", "=", old.operationId)
          .where("outcome", "in", ["started", "unknown", "sent"])
          .executeTakeFirst();
        if (unsafe) {
          await this.quarantine(tx, bytes, "operation_conflict");
          return;
        }
        if (previous.state !== "suppressed")
          await this.record(tx, previous, {
            state: "suppressed",
            reason: "superseded",
          });
        await tx
          .updateTable("notification_deliveries")
          .set({ latest_operation: c.operationId })
          .where("delivery_ref", "=", c.deliveryRef)
          .execute();
      } else {
        await tx
          .insertInto("notification_deliveries")
          .values({
            delivery_ref: c.deliveryRef,
            latest_operation: c.operationId,
            result_revision: 0,
          })
          .execute();
      }
      const now = this.clock.now();
      const result = await this.newResult(tx, c, hash, { state: "accepted" });
      await tx
        .insertInto("notification_commands")
        .values({
          operation_id: c.operationId,
          delivery_ref: c.deliveryRef,
          bot_identity: this.bot,
          command_revision: c.commandRevision,
          payload_digest: hash,
          command: c,
          result,
          state: "accepted",
          category,
          available_at: now,
          retry_count: 0,
          created_at: now,
        })
        .execute();
      await this.enqueue(tx, result);
      return result;
    });
  }

  async processCategory(category: Category, limit = 10): Promise<void> {
    const due = await this.db
      .selectFrom("notification_commands")
      .selectAll()
      .where("bot_identity", "=", this.bot)
      .where("category", "=", category)
      .where("state", "in", ["accepted", "retrying"])
      .where("available_at", "<=", this.clock.now())
      .orderBy("available_at")
      .limit(limit)
      .execute();
    for (const row of due) await this.dispatch(row);
  }

  private async dispatch(row: CommandRow): Promise<void> {
    const c = row.command;
    const request: DispatchRequest = {
      contractVersion: "inside.notification-dispatch.v1",
      operationId: randomUUID(),
      deliveryOperationId: c.operationId,
      deliveryRef: c.deliveryRef,
      commandRevision: c.commandRevision,
      payloadDigest: row.payload_digest,
      attemptRef: randomUUID(),
    };
    const requestedAt = this.clock.now();
    let permit: DispatchResponse | undefined;
    if (Date.parse(c.notAfter) > requestedAt.getTime()) {
      try {
        permit = await this.authorization.authorize(request);
      } catch {
        /* unavailable: no I/O */
      }
    }
    const receivedAt = this.clock.now();
    const started = await this.db.transaction().execute(async (tx) => {
      await lock(tx, c.deliveryRef);
      const current = await tx
        .selectFrom("notification_commands")
        .selectAll()
        .where("operation_id", "=", c.operationId)
        .executeTakeFirstOrThrow();
      const delivery = await tx
        .selectFrom("notification_deliveries")
        .selectAll()
        .where("delivery_ref", "=", c.deliveryRef)
        .executeTakeFirstOrThrow();
      if (
        delivery.latest_operation !== c.operationId ||
        !["accepted", "retrying"].includes(current.state) ||
        current.available_at > this.clock.now()
      )
        return;
      if (Date.parse(c.notAfter) <= this.clock.now().getTime()) {
        await this.record(tx, current, {
          state: "suppressed",
          reason: "expired",
        });
        return;
      }
      if (
        !permit ||
        !Object.entries(request).every(
          ([k, v]) => permit[k as keyof DispatchRequest] === v,
        ) ||
        permit.status === "error"
      ) {
        await this.retry(tx, current, "source_unavailable", null);
        return;
      }
      if (permit.status === "denied") {
        await this.record(tx, current, {
          state: "suppressed",
          reason:
            permit.reason === "not_found" ||
            permit.reason === "payload_conflict"
              ? "binding_conflict"
              : permit.reason,
        });
        return;
      }
      const until = Date.parse(permit.validUntil);
      if (!(
        until > this.clock.now().getTime() &&
        until <= receivedAt.getTime() + 5000 &&
        until <= Date.parse(c.notAfter)
      )) {
        await this.retry(tx, current, "source_unavailable", null);
        return;
      }
      // Platform authorizes linkRef/revision; the provider independently resolves only its verified Account/identity.
      await lockIdentityLinkAccount(tx, c.binding.accountRef);
      const link = await tx
        .selectFrom("platform_links")
        .selectAll()
        .where("account_ref", "=", c.binding.accountRef)
        .where("bot_identity", "=", this.bot)
        .where("telegram_identity_ref", "=", c.binding.telegramIdentityRef)
        .forUpdate()
        .executeTakeFirst();
      if (!link) {
        await this.record(tx, current, {
          state: "suppressed",
          reason: "binding_conflict",
        });
        return;
      }
      const contact = await tx
        .selectFrom("bot_contacts")
        .selectAll()
        .where("bot_identity", "=", this.bot)
        .where("telegram_user_id", "=", link.telegram_user_id)
        .forUpdate()
        .executeTakeFirst();
      if (!contact || contact.contactability !== "reachable") {
        await this.record(tx, current, {
          state: "failed",
          reason: "recipient_unreachable",
          attemptRef:
            current.result.state === "retrying"
              ? current.result.attemptRef
              : null,
        });
        return;
      }
      if (
        !(await reserveTelegramSlot(
          tx,
          this.bot,
          contact.private_chat_id,
          this.clock.now(),
          c.content.category,
        ))
      )
        return;
      const now = this.clock.now();
      if (until <= now.getTime() || Date.parse(c.notAfter) <= now.getTime())
        return;
      await tx
        .insertInto("notification_attempts")
        .values({
          attempt_ref: request.attemptRef,
          operation_id: c.operationId,
          permit_ref: permit.permitRef,
          started_at: now,
          outcome: "started",
          receipt_ref: null,
          provider_message_id: null,
        })
        .execute();
      await this.record(tx, current, {
        state: "unknown",
        reason: "interrupted_attempt",
        attemptRef: request.attemptRef,
      });
      return { chatId: contact.private_chat_id, validUntil: until };
    });
    if (!started) return;
    // Commit/lock latency must not turn an expired permit into an external call.
    if (this.clock.now().getTime() >= started.validUntil) {
      await this.db.transaction().execute(async (tx) => {
        await lock(tx, c.deliveryRef);
        const current = await tx
          .selectFrom("notification_commands")
          .selectAll()
          .where("operation_id", "=", c.operationId)
          .executeTakeFirstOrThrow();
        await tx
          .updateTable("notification_attempts")
          .set({ outcome: "not_sent" })
          .where("attempt_ref", "=", request.attemptRef)
          .execute();
        await this.record(tx, current, {
          state: "suppressed",
          reason: "expired",
        });
      });
      return;
    }
    let outcome: TelegramDeliveryResult;
    try {
      outcome = await this.transport.sendText({
        chatId: started.chatId,
        text: c.text,
      });
    } catch {
      outcome = { kind: "transport_unknown" };
    }
    await this.settle(
      c.operationId,
      request.attemptRef,
      row.payload_digest,
      outcome,
    );
  }

  // Internal provider evidence only. No public recovery endpoint can manufacture a retry permit.
  async settle(
    operationId: string,
    attemptRef: string,
    payloadDigest: string,
    outcome: TelegramDeliveryResult,
  ): Promise<void> {
    const row = await this.db
      .selectFrom("notification_commands")
      .selectAll()
      .where("operation_id", "=", operationId)
      .executeTakeFirstOrThrow();
    await this.db.transaction().execute(async (tx) => {
      await lock(tx, row.delivery_ref);
      const current = await tx
        .selectFrom("notification_commands")
        .selectAll()
        .where("operation_id", "=", operationId)
        .executeTakeFirstOrThrow();
      if (
        current.payload_digest !== payloadDigest ||
        current.bot_identity !== this.bot ||
        current.result.state !== "unknown" ||
        current.result.attemptRef !== attemptRef
      )
        throw new Error("Notification attempt correlation conflict");
      const attempt = await tx
        .selectFrom("notification_attempts")
        .selectAll()
        .where("attempt_ref", "=", attemptRef)
        .where("operation_id", "=", operationId)
        .executeTakeFirstOrThrow();
      if (!["started", "unknown"].includes(attempt.outcome))
        throw new Error("Notification attempt already settled");
      let state: ResultState;
      let evidence: "sent" | "not_sent" | "rejected" | "unknown";
      let receipt: string | null = null;
      if (outcome.kind === "delivered") {
        receipt = randomUUID();
        evidence = "sent";
        state = { state: "sent", attemptRef, receiptRef: receipt };
      } else if (
        outcome.kind === "api_retryable" &&
        outcome.providerErrorCode === 429
      ) {
        evidence = "not_sent";
        const delay = Math.max(1000, (outcome.retryAfterSeconds ?? 1) * 1000);
        await deferTelegramSlot(
          tx,
          this.bot,
          new Date(this.clock.now().getTime() + delay),
        );
        state = this.retryState(current, "rate_limited", attemptRef, delay);
      } else if (
        outcome.kind === "api_rejected" &&
        outcome.providerErrorCode < 500
      ) {
        evidence = "rejected";
        state = {
          state: "failed",
          reason:
            outcome.providerErrorCode === 403
              ? "recipient_unreachable"
              : "provider_rejected",
          attemptRef,
        };
      } else {
        evidence = "unknown";
        state = { state: "unknown", reason: "lost_response", attemptRef };
      }
      await tx
        .updateTable("notification_attempts")
        .set({
          outcome: evidence,
          receipt_ref: receipt,
          provider_message_id:
            outcome.kind === "delivered" ? outcome.providerMessageId : null,
        })
        .where("attempt_ref", "=", attemptRef)
        .execute();
      await this.record(tx, current, state);
    });
  }

  private retryState(
    row: CommandRow,
    reason: "source_unavailable" | "rate_limited",
    attemptRef: string | null,
    minimumDelay = 0,
  ): ResultState {
    if (row.retry_count >= 3)
      return { state: "failed", reason: "retry_exhausted", attemptRef };
    const next = new Date(
      this.clock.now().getTime() +
        Math.max(minimumDelay, [1000, 5000, 30000][row.retry_count]!),
    );
    if (next.getTime() >= Date.parse(row.command.notAfter))
      return { state: "suppressed", reason: "expired" };
    return {
      state: "retrying",
      reason,
      attemptRef,
      nextAttemptAt: next.toISOString(),
    };
  }
  private async retry(
    tx: Tx,
    row: CommandRow,
    reason: "source_unavailable",
    attemptRef: null,
  ) {
    // A preflight failure after a known not_sent attempt still carries that exact attempt.
    const previous =
      row.result.state === "retrying" ? row.result.attemptRef : attemptRef;
    await this.record(tx, row, this.retryState(row, reason, previous));
  }
  private async newResult(
    tx: Tx,
    c: NotificationCommand,
    payloadDigest: string,
    state: ResultState,
  ): Promise<NotificationResult> {
    const d = await tx
      .updateTable("notification_deliveries")
      .set({ result_revision: sql`result_revision + 1` })
      .where("delivery_ref", "=", c.deliveryRef)
      .returning("result_revision")
      .executeTakeFirstOrThrow();
    return {
      contractVersion: "inside.notification-result.v1",
      messageId: randomUUID(),
      operationId: c.operationId,
      deliveryRef: c.deliveryRef,
      commandRevision: c.commandRevision,
      payloadDigest,
      resultRevision: d.result_revision,
      channel: "telegram",
      recordedAt: this.clock.now().toISOString(),
      ...state,
    };
  }
  private async record(tx: Tx, row: CommandRow, state: ResultState) {
    const result = await this.newResult(
      tx,
      row.command,
      row.payload_digest,
      state,
    );
    await tx
      .updateTable("notification_commands")
      .set({
        state: state.state,
        result,
        ...(state.state === "retrying"
          ? {
              retry_count: row.retry_count + 1,
              available_at: new Date(state.nextAttemptAt),
            }
          : {}),
      })
      .where("operation_id", "=", row.operation_id)
      .execute();
    await this.enqueue(tx, result);
  }
  private async enqueue(tx: Tx, result: NotificationResult) {
    await tx
      .insertInto("notification_result_outbox")
      .values({
        message_id: result.messageId,
        result,
        published_at: null,
        created_at: this.clock.now(),
      })
      .onConflict((c) =>
        c.column("message_id").doUpdateSet({ published_at: null }),
      )
      .execute();
  }
  private async quarantine(tx: Tx, bytes: Buffer, reason: string) {
    await lock(tx, "quarantine-capacity");
    const payloads = await tx
      .selectFrom("notification_quarantine")
      .select(tx.fn.countAll().as("count"))
      .where("encrypted_payload", "is not", null)
      .executeTakeFirstOrThrow();
    if (Number(payloads.count) >= 10000)
      throw new Error("Notification quarantine capacity exhausted");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.quarantineKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(bytes.subarray(0, 16384)),
      cipher.final(),
    ]);
    await tx
      .insertInto("notification_quarantine")
      .values({
        digest: createHash("sha256").update(bytes).digest("hex"),
        reason,
        encrypted_payload: Buffer.concat([
          iv,
          cipher.getAuthTag(),
          encrypted,
        ]).toString("base64"),
        created_at: this.clock.now(),
      })
      .execute();
  }
  async expireQuarantinePayloads(): Promise<void> {
    await this.db
      .updateTable("notification_quarantine")
      .set({ encrypted_payload: null })
      .where(
        "created_at",
        "<",
        new Date(this.clock.now().getTime() - 7 * 86400000),
      )
      .where("encrypted_payload", "is not", null)
      .execute();
  }
  async publishResults(
    publish: (result: NotificationResult) => Promise<void>,
    limit = 25,
  ): Promise<void> {
    for (let i = 0; i < limit; i++) {
      const found = await this.db.transaction().execute(async (tx) => {
        const item = await tx
          .selectFrom("notification_result_outbox")
          .selectAll()
          .where("published_at", "is", null)
          .orderBy("created_at")
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!item) return false;
        await publish(item.result);
        await tx
          .updateTable("notification_result_outbox")
          .set({ published_at: this.clock.now() })
          .where("message_id", "=", item.message_id)
          .execute();
        return true;
      });
      if (!found) return;
    }
  }
}
async function lock(tx: Tx, key: string) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`notification:${key}`}, 0))`.execute(
    tx,
  );
}
