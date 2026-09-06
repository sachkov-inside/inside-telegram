export { relativeDue } from "./funnel-timeline.js";
import { reconcileFunnels, terminal, started } from "./funnel-timeline.js";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { DATABASE, type Database } from "../../database/database.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { CLOCK, type Clock } from "../identity-linking/clock.js";
import {
  reserveTelegramSlot,
  deferTelegramSlot,
} from "../outbound/telegram-transport-slots.js";
import type { TelegramDeliveryResult } from "../outbound/telegram-messages.js";
import {
  COMMUNICATION_TRANSPORT,
  type CommunicationTransport,
} from "./communication-delivery.js";
import { communicationLock } from "./communication-state.js";
import type { FunnelDraft, MessagePart, DeliveryPart } from "./funnel-types.js";
@Injectable()
export class FunnelScheduler {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(COMMUNICATION_TRANSPORT)
    private readonly transport: CommunicationTransport,
  ) {}
  async assertConfigured(): Promise<void> {
    if (!this.config.marketingEnabled) return;
    const defaultFunnel = await this.database
      .selectFrom("communication_funnels")
      .select("funnel_id")
      .where("bot_identity", "=", this.config.botIdentity)
      .where("is_default", "=", true)
      .where("lifecycle", "=", "published")
      .executeTakeFirst();
    const intro = await this.database
      .selectFrom("communication_intro")
      .select("bot_identity")
      .where("bot_identity", "=", this.config.botIdentity)
      .executeTakeFirst();
    if (!defaultFunnel || !intro)
      throw new Error(
        "Marketing requires a published default funnel and common intro",
      );
  }
  async processAvailable(limit = 25): Promise<number> {
    if (!this.config.marketingEnabled) return 0;
    let processed = 0;
    for (; processed < limit; processed++) {
      const claimed = await this.claim();
      if (!claimed) break;
      let result: TelegramDeliveryResult;
      try {
        result = await this.transport.send({
          chatId: claimed.chatId,
          content: claimed.content,
          offerStart: claimed.delivery.kind === "fallback",
        });
      } catch {
        result = { kind: "transport_unknown" };
      }
      await this.record(
        claimed.delivery.delivery_id,
        claimed.attemptId,
        result,
      );
    }
    return processed;
  }
  private async claim() {
    return this.database.transaction().execute(async (tx) => {
      await communicationLock(
        tx,
        `communications-scheduler:${this.config.botIdentity}`,
      );
      const now = this.clock.now();
      const stale = await tx
        .selectFrom("communication_deliveries")
        .selectAll()
        .where("bot_identity", "=", this.config.botIdentity)
        .where("locked_at", "<=", new Date(now.getTime() - 60_000))
        .where("completed_at", "is", null)
        .execute();
      for (const delivery of stale) {
        const parts = delivery.parts as DeliveryPart[];
        const part = parts.find((p) => p.state === "in_flight");
        if (!part) continue;
        part.state = "unknown";
        part.diagnosticCode = "worker_lost";
        part.attempts.push({
          attemptId: delivery.attempt_id!,
          attemptedAt: delivery.locked_at!.toISOString(),
          outcome: "unknown",
          diagnosticCode: "worker_lost",
          duplicateRiskAccepted: false,
        });
        await tx
          .updateTable("communication_deliveries")
          .set({
            parts: JSON.stringify(parts),
            revision: delivery.revision + 1,
          })
          .where("delivery_id", "=", delivery.delivery_id)
          .execute();
      }
      await reconcileFunnels(tx, this.config.botIdentity, now);
      // A marketing backlog must never reserve capacity ahead of a ready service response.
      const service = await tx
        .selectFrom("start_response_deliveries")
        .select("id")
        .where("bot_identity", "=", this.config.botIdentity)
        .where("state", "in", ["pending", "retry_scheduled"])
        .where("available_at", "<=", now)
        .executeTakeFirst();
      if (service) return undefined;
      const candidates = await tx
        .selectFrom("communication_deliveries as d")
        .innerJoin(
          "communication_contacts as c",
          "c.contact_id",
          "d.contact_id",
        )
        .innerJoin("bot_contacts as b", (j) =>
          j
            .onRef("b.bot_identity", "=", "c.bot_identity")
            .onRef("b.telegram_user_id", "=", "c.telegram_user_id"),
        )
        .selectAll("d")
        .select(["b.private_chat_id", "c.marketing_enabled"])
        .where("d.bot_identity", "=", this.config.botIdentity)
        .where("d.completed_at", "is", null)
        .where("d.due_at", "<=", now)
        .where("d.cancel_requested", "=", false)
        .where((eb) =>
          eb.or([
            eb("c.marketing_enabled", "=", true),
            eb("d.kind", "in", ["entry", "fallback"]),
          ]),
        )
        .where("b.contactability", "=", "reachable")
        .orderBy("d.due_at")
        .orderBy("d.created_at")
        .orderBy("d.delivery_id")
        .execute();
      for (const delivery of candidates) {
        const parts = delivery.parts as DeliveryPart[];
        const part = parts.find(
          (p) =>
            !["sent", "skipped", "cancelled", "suppressed"].includes(p.state),
        );
        if (!part || part.state !== "pending") continue;
        if (delivery.funnel_id) {
          const funnel = await tx
            .selectFrom("communication_funnels")
            .selectAll()
            .where("funnel_id", "=", delivery.funnel_id)
            .forShare()
            .executeTakeFirstOrThrow();
          if (funnel.lifecycle !== "published") continue;
          if (delivery.kind === "step" && !started(delivery)) {
            const draft = funnel.published as FunnelDraft;
            const history = await tx
              .selectFrom("communication_deliveries")
              .selectAll()
              .where("contact_id", "=", delivery.contact_id)
              .where("funnel_id", "=", delivery.funnel_id)
              .execute();
            if (
              history.some(
                (d) => d.kind === "step" && !d.completed_at && started(d),
              )
            )
              continue;
            const next = draft.steps.find(
              (s) =>
                !history.some(
                  (d) =>
                    d.kind === "step" &&
                    d.step_id === s.stepId &&
                    d.completed_at,
                ),
            );
            if (next?.stepId !== delivery.step_id) continue;
          }
          const intro = await tx
            .selectFrom("communication_deliveries")
            .select("completed_at")
            .where("dedup_key", "=", `intro:${delivery.contact_id}`)
            .executeTakeFirst();
          if (delivery.marketing_enabled && !intro?.completed_at) continue;
        }
        // Re-read under shared row locks; stop/block updates serialize with the dispatch intent.
        const eligibility = await tx
          .selectFrom("communication_contacts as c")
          .innerJoin("bot_contacts as b", (j) =>
            j
              .onRef("b.bot_identity", "=", "c.bot_identity")
              .onRef("b.telegram_user_id", "=", "c.telegram_user_id"),
          )
          .select(["c.marketing_enabled", "b.contactability"])
          .where("c.contact_id", "=", delivery.contact_id)
          .forShare(["c", "b"])
          .executeTakeFirstOrThrow();
        if (
          (!eligibility.marketing_enabled &&
            !["entry", "fallback"].includes(delivery.kind)) ||
          eligibility.contactability !== "reachable"
        )
          continue;
        if (
          !(await reserveTelegramSlot(
            tx,
            this.config.botIdentity,
            delivery.private_chat_id,
            now,
          ))
        )
          continue;
        if (part.attempts.length >= 90) continue;
        const attemptId = randomUUID();
        part.state = "in_flight";
        await tx
          .updateTable("communication_deliveries")
          .set({
            parts: JSON.stringify(parts),
            attempt_id: attemptId,
            locked_at: now,
            revision: delivery.revision + 1,
          })
          .where("delivery_id", "=", delivery.delivery_id)
          .execute();
        const content = (delivery.snapshot as MessagePart[]).find(
          (p) => p.partId === part.partId,
        )!.content;
        return {
          delivery,
          attemptId,
          chatId: delivery.private_chat_id,
          content,
        };
      }
      return undefined;
    });
  }
  async record(
    deliveryId: string,
    attemptId: string,
    result: TelegramDeliveryResult,
  ): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      await communicationLock(
        tx,
        `communications-scheduler:${this.config.botIdentity}`,
      );
      const delivery = await tx
        .selectFrom("communication_deliveries")
        .selectAll()
        .where("delivery_id", "=", deliveryId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (delivery.attempt_id !== attemptId) return;
      const parts = delivery.parts as DeliveryPart[];
      const part = parts.find(
        (p) =>
          p.state === "in_flight" ||
          (p.state === "unknown" &&
            p.attempts.some((a) => a.attemptId === attemptId)),
      );
      if (!part) return;
      const now = this.clock.now();
      const code =
        result.kind === "api_rejected" || result.kind === "api_retryable"
          ? `telegram_${result.providerErrorCode}`
          : result.kind === "transport_unknown"
            ? "transport_unknown"
            : null;
      part.attempts.push({
        attemptId,
        attemptedAt: now.toISOString(),
        outcome:
          result.kind === "delivered"
            ? "sent"
            : result.kind === "api_rejected"
              ? "api_rejected"
              : result.kind === "api_retryable"
                ? "retryable"
                : "unknown",
        diagnosticCode: code,
        duplicateRiskAccepted:
          part.diagnosticCode === "explicit_retry_duplicate_risk",
      });
      part.diagnosticCode = code;
      part.state =
        result.kind === "delivered"
          ? "sent"
          : result.kind === "transport_unknown"
            ? "unknown"
            : result.kind === "api_retryable" && part.attempts.length < 3
              ? "pending"
              : "failed";
      if (
        delivery.cancel_requested &&
        ["pending", "failed"].includes(part.state)
      ) {
        part.state = "cancelled";
        part.diagnosticCode = "cancel_requested";
      }
      const due =
        result.kind === "api_retryable"
          ? new Date(
              now.getTime() + Math.max(result.retryAfterSeconds ?? 5, 1) * 1000,
            )
          : now;
      if (result.kind === "api_retryable" && result.providerErrorCode === 429)
        await deferTelegramSlot(tx, this.config.botIdentity, due);
      await tx
        .updateTable("communication_deliveries")
        .set({
          parts: JSON.stringify(parts),
          revision: delivery.revision + 1,
          due_at: due,
          locked_at: null,
          attempt_id: part.state === "unknown" ? attemptId : null,
          completed_at: terminal(parts) ? now : null,
        })
        .where("delivery_id", "=", deliveryId)
        .execute();
    });
  }
}
