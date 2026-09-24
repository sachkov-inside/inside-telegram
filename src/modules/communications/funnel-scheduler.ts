import { enqueueBroadcastAuthorMenu } from "./author-delivery-menu.js";
import { completeBroadcasts, launchDueBroadcasts } from "./broadcasts.js";
import { trackedContent } from "./communication-tracking.js";
import { updateMarketingAvailability } from "./marketing-preferences.js";
export { relativeDue } from "./funnel-timeline.js";
import { reconcileFunnels, terminal, started } from "./funnel-timeline.js";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql, type Transaction } from "kysely";
import {
  DATABASE,
  type Database,
  type DatabaseSchema,
} from "../../database/database.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { CLOCK, type Clock } from "../identity-linking/clock.js";
import {
  admitTelegramSlot,
  deferTelegramSlot,
} from "../outbound/telegram-transport-slots.js";
import type { TelegramDeliveryResult } from "../outbound/telegram-messages.js";
import {
  COMMUNICATION_TRANSPORT,
  type CommunicationTransport,
} from "./communication-delivery.js";
import {
  communicationLock,
  contactLock,
  tryContactLock,
} from "./communication-state.js";
import type {
  FunnelDraft,
  MessagePart,
  BroadcastPart,
  DeliveryPart,
} from "./funnel-types.js";
const REPLY_KINDS = ["intro", "entry", "fallback"] as const;
const BACKLOG_KINDS = ["step", "broadcast"] as const;
// A claim reads due work in index pages and gives up after a bounded scan, whatever the backlog.
const CLAIM_PAGE = 50;
const CLAIM_SCAN_LIMIT = 500;
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
    await this.plan();
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
  // Once per cycle and outside claims: recover lost claims, launch armed broadcasts and complete
  // finished ones. Funnel timelines are replanned by the events that change them, so no claim
  // scans the audience.
  private async plan(): Promise<void> {
    const bot = this.config.botIdentity;
    await this.database.transaction().execute(async (tx) => {
      await communicationLock(tx, `communications-scheduler:${bot}`);
      const now = this.clock.now();
      const stale = await tx
        .selectFrom("communication_deliveries as d")
        .innerJoin(
          "communication_contacts as c",
          "c.contact_id",
          "d.contact_id",
        )
        .select(["d.delivery_id", "c.telegram_user_id"])
        .where("d.bot_identity", "=", bot)
        .where("d.completed_at", "is", null)
        .where("d.locked_at", "<=", new Date(now.getTime() - 60_000))
        .orderBy("d.locked_at")
        .limit(CLAIM_PAGE)
        .execute();
      for (const { delivery_id, telegram_user_id } of stale) {
        // A subscriber busy with /start keeps its lock; the next cycle recovers the claim.
        if (!(await tryContactLock(tx, bot, telegram_user_id))) continue;
        const delivery = await tx
          .selectFrom("communication_deliveries")
          .selectAll()
          .where("delivery_id", "=", delivery_id)
          .where("completed_at", "is", null)
          .where("locked_at", "<=", new Date(now.getTime() - 60_000))
          .executeTakeFirst();
        if (!delivery) continue;
        const parts = delivery.parts as DeliveryPart[];
        const part = parts.find((p) => p.state === "in_flight");
        if (part) {
          part.state = "unknown";
          part.diagnosticCode = "worker_lost";
          part.attempts.push({
            attemptId: delivery.attempt_id!,
            attemptedAt: delivery.locked_at!.toISOString(),
            outcome: "unknown",
            diagnosticCode: "worker_lost",
            duplicateRiskAccepted: false,
          });
        }
        // The attempt ID stays for late evidence; the lease itself is spent.
        await tx
          .updateTable("communication_deliveries")
          .set({
            parts: JSON.stringify(parts),
            revision: delivery.revision + (part ? 1 : 0),
            locked_at: null,
          })
          .where("delivery_id", "=", delivery.delivery_id)
          .execute();
      }
      await launchDueBroadcasts(tx, bot, now);
      await completeBroadcasts(tx, bot);
    });
  }
  // Eligibility that SQL can decide, shared by the bounded scan and the locked reread.
  private dueDeliveries(tx: Transaction<DatabaseSchema>, now: Date) {
    return tx
      .selectFrom("communication_deliveries as d")
      .innerJoin("communication_contacts as c", "c.contact_id", "d.contact_id")
      .innerJoin("bot_contacts as b", (j) =>
        j
          .onRef("b.bot_identity", "=", "c.bot_identity")
          .onRef("b.telegram_user_id", "=", "c.telegram_user_id"),
      )
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
      .where((eb) =>
        eb.or([
          eb("d.broadcast_id", "is", null),
          eb.exists(
            eb
              .selectFrom("communication_broadcasts as r")
              .select("r.broadcast_id")
              .whereRef("r.broadcast_id", "=", "d.broadcast_id")
              .where("r.state", "=", "running"),
          ),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb("d.funnel_id", "is", null),
          eb.exists(
            eb
              .selectFrom("communication_funnels as f")
              .select("f.funnel_id")
              .whereRef("f.funnel_id", "=", "d.funnel_id")
              .where("f.lifecycle", "=", "published"),
          ),
        ]),
      );
  }
  private async claim() {
    return this.database.transaction().execute(async (tx) => {
      await communicationLock(
        tx,
        `communications-scheduler:${this.config.botIdentity}`,
      );
      const now = this.clock.now();
      // A marketing backlog must never reserve capacity ahead of a ready service response.
      const service = await tx
        .selectFrom("start_response_deliveries")
        .select("id")
        .where("bot_identity", "=", this.config.botIdentity)
        .where("state", "in", ["pending", "retry_scheduled"])
        .where("available_at", "<=", now)
        .executeTakeFirst();
      if (service) return undefined;
      // Replies to a subscriber's own /start go ahead of the funnel and broadcast backlog.
      for (const kinds of [REPLY_KINDS, BACKLOG_KINDS]) {
        let after:
          { due_at: Date; created_at: Date; delivery_id: string } | undefined;
        for (
          let scanned = 0;
          scanned < CLAIM_SCAN_LIMIT;
          scanned += CLAIM_PAGE
        ) {
          let query = this.dueDeliveries(tx, now)
            .select([
              "d.delivery_id",
              "d.due_at",
              "d.created_at",
              "c.telegram_user_id",
            ])
            .where(
              sql<boolean>`d.kind in (${sql.join(kinds.map((k) => sql.lit(k)))})`,
            );
          if (after)
            query = query.where(
              sql<boolean>`(d.due_at, d.created_at, d.delivery_id) > (${after.due_at}, ${after.created_at}, ${after.delivery_id}::uuid)`,
            );
          const page = await query
            .orderBy("d.due_at")
            .orderBy("d.created_at")
            .orderBy("d.delivery_id")
            .limit(CLAIM_PAGE)
            .execute();
          for (const candidate of page) {
            const claimed = await this.claimCandidate(tx, candidate, now);
            if (claimed === "bot_busy") return undefined;
            if (claimed) return claimed;
          }
          if (page.length < CLAIM_PAGE) break;
          after = page.at(-1);
        }
      }
      return undefined;
    });
  }
  private async claimCandidate(
    tx: Transaction<DatabaseSchema>,
    candidate: { delivery_id: string; telegram_user_id: string },
    now: Date,
  ) {
    // Skip a subscriber whose /start, stop or entry is in progress instead of waiting for it.
    if (
      !(await tryContactLock(
        tx,
        this.config.botIdentity,
        candidate.telegram_user_id,
      ))
    )
      return undefined;
    const delivery = await this.dueDeliveries(tx, now)
      .selectAll("d")
      .select(["b.private_chat_id", "c.marketing_enabled"])
      .where("d.delivery_id", "=", candidate.delivery_id)
      .executeTakeFirst();
    if (!delivery) return undefined;
    const parts = delivery.parts as DeliveryPart[];
    const part = parts.find(
      (p) => !["sent", "skipped", "cancelled", "suppressed"].includes(p.state),
    );
    if (!part || part.state !== "pending") return undefined;
    if (delivery.broadcast_id) {
      const broadcast = await tx
        .selectFrom("communication_broadcasts")
        .select(["state", "launched_at"])
        .where("broadcast_id", "=", delivery.broadcast_id)
        .executeTakeFirstOrThrow();
      const offset =
        (delivery.snapshot as BroadcastPart[]).find(
          (p) => p.partId === part.partId,
        )?.sendAfterSeconds ?? 0;
      if (
        !broadcast.launched_at ||
        +broadcast.launched_at + offset * 1000 > +now
      )
        return undefined;
    }
    if (delivery.funnel_id) {
      const funnel = await tx
        .selectFrom("communication_funnels")
        .selectAll()
        .where("funnel_id", "=", delivery.funnel_id)
        .forShare()
        .executeTakeFirstOrThrow();
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
          return undefined;
        const next = draft.steps.find(
          (s) =>
            !history.some(
              (d) =>
                d.kind === "step" && d.step_id === s.stepId && d.completed_at,
            ),
        );
        if (next?.stepId !== delivery.step_id) return undefined;
      }
      const intro = await tx
        .selectFrom("communication_deliveries")
        .select("completed_at")
        .where("dedup_key", "=", `intro:${delivery.contact_id}`)
        .executeTakeFirst();
      if (delivery.marketing_enabled && !intro?.completed_at) return undefined;
    }
    const admission = await admitTelegramSlot(
      tx,
      this.config.botIdentity,
      delivery.private_chat_id,
      now,
    );
    if (admission !== "reserved")
      return admission === "bot_busy" ? admission : undefined;
    if (part.attempts.length >= 90) return undefined;
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
      content: await trackedContent(
        tx,
        this.config,
        delivery.delivery_id,
        part.partId,
        content,
        now,
      ),
    };
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
      const owner = await tx
        .selectFrom("communication_deliveries as d")
        .innerJoin(
          "communication_contacts as c",
          "c.contact_id",
          "d.contact_id",
        )
        .select("c.telegram_user_id")
        .where("d.delivery_id", "=", deliveryId)
        .executeTakeFirstOrThrow();
      await contactLock(tx, this.config.botIdentity, owner.telegram_user_id);
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
        const suppressed =
          delivery.kind === "broadcast" &&
          delivery.cancellation_reason === "marketing_unavailable";
        part.state = suppressed ? "suppressed" : "cancelled";
        part.diagnosticCode = suppressed
          ? "marketing_unavailable"
          : "cancel_requested";
      }
      let due =
        result.kind === "api_retryable"
          ? new Date(
              now.getTime() + Math.max(result.retryAfterSeconds ?? 5, 1) * 1000,
            )
          : now;
      if (delivery.broadcast_id && result.kind === "delivered") {
        const next = parts.find(
          (p) =>
            !["sent", "skipped", "cancelled", "suppressed"].includes(p.state),
        );
        const offset =
          (delivery.snapshot as BroadcastPart[]).find(
            (p) => p.partId === next?.partId,
          )?.sendAfterSeconds ?? 0;
        const b = await tx
          .selectFrom("communication_broadcasts")
          .select("launched_at")
          .where("broadcast_id", "=", delivery.broadcast_id)
          .executeTakeFirstOrThrow();
        if (next && b.launched_at)
          due = new Date(Math.max(+now, +b.launched_at + offset * 1000));
      }
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
      if (result.kind === "api_rejected" && result.providerErrorCode === 403) {
        const contact = await tx
          .selectFrom("communication_contacts")
          .select("telegram_user_id")
          .where("contact_id", "=", delivery.contact_id)
          .executeTakeFirstOrThrow();
        await updateMarketingAvailability(
          tx,
          this.config.botIdentity,
          contact.telegram_user_id,
          now,
          false,
        );
        await tx
          .updateTable("bot_contacts")
          .set({ contactability: "blocked", updated_at: now })
          .where("bot_identity", "=", this.config.botIdentity)
          .where("telegram_user_id", "=", contact.telegram_user_id)
          .execute();
      }
      if (delivery.broadcast_id)
        await completeBroadcasts(
          tx,
          this.config.botIdentity,
          delivery.broadcast_id,
        );
      // A finished response or step opens the subscriber's next step.
      else if (terminal(parts))
        await reconcileFunnels(tx, this.config.botIdentity, now, {
          contactId: delivery.contact_id,
        });
      if (
        result.kind === "delivered" &&
        (terminal(parts) || +due > +now) &&
        delivery.broadcast_id
      )
        await enqueueBroadcastAuthorMenu(
          tx,
          this.config.botIdentity,
          delivery.broadcast_id,
          delivery.contact_id,
        );
    });
  }
}
