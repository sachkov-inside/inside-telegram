import { hasDueReply } from "../outbound/start-response-delivery-queue.js";
import { enqueueBroadcastAuthorMenu } from "./author-delivery-menu.js";
import { completeBroadcasts, launchDueBroadcasts } from "./broadcasts.js";
import { trackedContent } from "./communication-tracking.js";
import { updateMarketingAvailability } from "./marketing-preferences.js";
export { relativeDue } from "./funnel-timeline.js";
import { reconcileFunnels, terminal, started } from "./funnel-timeline.js";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql, type Selectable, type Transaction } from "kysely";
import {
  DATABASE,
  type Database,
  type DatabaseSchema,
} from "../../database/database.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { CLOCK, type Clock } from "../../shared/clock.js";
import {
  admitTelegramSlot,
  chatLaneBusy,
  deferTelegramSlot,
} from "../outbound/telegram-transport-slots.js";
import type { TelegramDeliveryResult } from "../outbound/telegram-messages.js";
import type { TemplateContent } from "./communications-contract.js";
import {
  COMMUNICATION_TRANSPORT,
  type CommunicationTransport,
} from "./communication-delivery.js";
import {
  lockDeliveryContact,
  schedulerLock,
  tryContactLock,
} from "./communication-state.js";
import type {
  FunnelDraft,
  MessagePart,
  BroadcastPart,
  DeliveryPart,
} from "./funnel-types.js";
import { reportFailure } from "../../shared/failure-diagnostics.js";
const REPLY_KINDS = ["intro", "entry", "fallback"] as const;
const BACKLOG_KINDS = ["step", "broadcast"] as const;
type Queue = typeof REPLY_KINDS | typeof BACKLOG_KINDS;
type QueuePosition = { due_at: Date; created_at: Date; delivery_id: string };
type DueDelivery = Selectable<DatabaseSchema["communication_deliveries"]> & {
  private_chat_id: string;
  marketing_enabled: boolean;
};
type Claim = {
  delivery: DueDelivery;
  attemptId: string;
  chatId: string;
  content: TemplateContent;
};
// `capacity_busy`: the bot's shared lane or fairness turn refuses every chat, so stop scanning.
// `released`: a locked contact turned out unsendable; commit now so its /start never waits
// for the rest of the scan.
type CandidateOutcome =
  | { kind: "claimed"; claim: Claim }
  | { kind: "skipped" }
  | { kind: "capacity_busy" }
  | { kind: "released" };
const STALE_CLAIM_MS = 60_000;
// A claim reads due work in index pages and gives up after a bounded scan, whatever the backlog.
const CLAIM_PAGE = 50;
const CLAIM_SCAN_LIMIT = 500;
@Injectable()
export class FunnelScheduler {
  private resumeAfter = new Map<Queue, QueuePosition>();
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
    // A released claim freed a contact that proved unsendable; it only retries, within bounds.
    for (
      let attempts = 0;
      processed < limit && attempts < 2 * limit;
      attempts++
    ) {
      const outcome = await this.claim();
      if (outcome.kind === "released") continue;
      if (outcome.kind !== "claimed") break;
      const claimed = outcome.claim;
      let result: TelegramDeliveryResult;
      try {
        result = await this.transport.send({
          chatId: claimed.chatId,
          content: claimed.content,
          offerStart: claimed.delivery.kind === "fallback",
        });
      } catch (error) {
        reportFailure("communications.funnel-send", error, {
          delivery_id: claimed.delivery.delivery_id,
        });
        result = { kind: "transport_unknown" };
      }
      await this.record(
        claimed.delivery.delivery_id,
        claimed.attemptId,
        result,
      );
      processed++;
    }
    return processed;
  }
  // Once per cycle and outside claims: recover lost claims, launch armed broadcasts and complete
  // finished ones. Funnel timelines are replanned by the events that change them, so no claim
  // scans the audience.
  private async plan(): Promise<void> {
    const bot = this.config.botIdentity;
    await this.database.transaction().execute(async (tx) => {
      await schedulerLock(tx, bot);
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
        .where("d.locked_at", "<=", new Date(now.getTime() - STALE_CLAIM_MS))
        .orderBy("d.locked_at")
        .limit(CLAIM_PAGE)
        .execute();
      for (const { delivery_id, telegram_user_id } of stale) {
        // A contact busy with /start keeps its lock; the next cycle recovers the claim.
        if (!(await tryContactLock(tx, bot, telegram_user_id))) continue;
        const delivery = await tx
          .selectFrom("communication_deliveries")
          .selectAll()
          .where("delivery_id", "=", delivery_id)
          .where("completed_at", "is", null)
          .where("locked_at", "<=", new Date(now.getTime() - STALE_CLAIM_MS))
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
    });
    // A separate transaction: a large launch must not hold the recovered contacts' locks.
    await this.database.transaction().execute(async (tx) => {
      await schedulerLock(tx, bot);
      const now = this.clock.now();
      await launchDueBroadcasts(tx, bot, now);
      await completeBroadcasts(tx, bot);
    });
  }
  // Eligibility that SQL can decide, shared by the bounded scan and the locked reread.
  private dueDeliveries(tx: Transaction<DatabaseSchema>, now: Date) {
    return (
      tx
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
        .where("d.bot_identity", "=", this.config.botIdentity)
        .where("d.completed_at", "is", null)
        .where("d.due_at", "<=", now)
        .where("d.cancel_requested", "=", false)
        // A part awaiting its result or an operator decision holds the whole delivery.
        .where(
          sql<boolean>`not (d.parts @> '[{"state":"in_flight"}]' or d.parts @> '[{"state":"unknown"}]' or d.parts @> '[{"state":"failed"}]')`,
        )
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
        )
    );
  }
  private async claim(): Promise<CandidateOutcome> {
    // Scan positions advance only when the claim transaction commits.
    const resumeAfter = new Map(this.resumeAfter);
    const outcome = await this.database.transaction().execute(async (tx) => {
      await schedulerLock(tx, this.config.botIdentity);
      const now = this.clock.now();
      // A marketing backlog must never reserve capacity ahead of a ready service response.
      if (await hasDueReply(tx, this.config.botIdentity, now))
        return { kind: "capacity_busy" } as const;
      // Replies to a contact's own /start go ahead of the funnel and broadcast backlog.
      for (const queue of [REPLY_KINDS, BACKLOG_KINDS]) {
        const outcome = await this.claimFrom(tx, resumeAfter, queue, now);
        if (outcome.kind !== "skipped") return outcome;
      }
      return { kind: "skipped" } as const;
    });
    this.resumeAfter = resumeAfter;
    return outcome;
  }
  // Scans one queue in due order, at most CLAIM_SCAN_LIMIT rows per claim. When that many rows
  // at the head cannot be sent (a lane waiting for an earlier step, an intro not yet sent), the
  // next claims continue after them and wrap at the end, so the head never stalls the queue.
  private async claimFrom(
    tx: Transaction<DatabaseSchema>,
    resumeAfter: Map<Queue, QueuePosition>,
    queue: Queue,
    now: Date,
  ): Promise<CandidateOutcome> {
    const resumed = resumeAfter.get(queue);
    let after = resumed;
    let fromHead = !resumed;
    for (let scanned = 0; scanned < CLAIM_SCAN_LIMIT;) {
      let query = this.dueDeliveries(tx, now)
        .select([
          "d.delivery_id",
          "d.due_at",
          "d.created_at",
          "c.telegram_user_id",
        ])
        // Literal kinds let PostgreSQL match the partial queue index.
        .where(
          sql<boolean>`d.kind in (${sql.join(queue.map((k) => sql.lit(k)))})`,
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
        const outcome = await this.claimCandidate(tx, candidate, now);
        if (outcome.kind === "claimed" && resumed)
          resumeAfter.set(queue, candidate);
        if (outcome.kind !== "skipped") return outcome;
      }
      scanned += page.length;
      if (page.length < CLAIM_PAGE) {
        // The end of the queue: the next claim starts from its head again.
        resumeAfter.delete(queue);
        if (fromHead) return { kind: "skipped" };
        fromHead = true;
        after = undefined;
        continue;
      }
      after = page.at(-1);
    }
    if (after) resumeAfter.set(queue, after);
    return { kind: "skipped" };
  }
  private async claimCandidate(
    tx: Transaction<DatabaseSchema>,
    candidate: { delivery_id: string; telegram_user_id: string },
    now: Date,
  ): Promise<CandidateOutcome> {
    const read = () =>
      this.dueDeliveries(tx, now)
        .selectAll("d")
        .select(["b.private_chat_id", "c.marketing_enabled"])
        .where("d.delivery_id", "=", candidate.delivery_id)
        .executeTakeFirst();
    // Check before locking, so a skipped contact is normally never held; a contact whose /start,
    // stop or entry is in progress is skipped instead of awaited. The locked reread decides.
    const unlocked = await read();
    if (
      !unlocked ||
      (await chatLaneBusy(
        tx,
        this.config.botIdentity,
        unlocked.private_chat_id,
        now,
      )) ||
      !(await this.nextPart(tx, unlocked, now))
    )
      return { kind: "skipped" };
    if (
      !(await tryContactLock(
        tx,
        this.config.botIdentity,
        candidate.telegram_user_id,
      ))
    )
      return { kind: "skipped" };
    const delivery = await read();
    const part = delivery && (await this.nextPart(tx, delivery, now));
    if (!delivery || !part) return { kind: "released" };
    const admission = await admitTelegramSlot(
      tx,
      this.config.botIdentity,
      delivery.private_chat_id,
      now,
    );
    if (admission === "bot_busy") return { kind: "capacity_busy" };
    if (admission === "chat_busy") return { kind: "released" };
    const attemptId = randomUUID();
    const parts = delivery.parts as DeliveryPart[];
    parts.find((p) => p.partId === part.partId)!.state = "in_flight";
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
      kind: "claimed",
      claim: {
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
      },
    };
  }
  // The part to send now, or undefined while broadcast offsets, the funnel lane or the intro
  // hold this delivery.
  private async nextPart(
    tx: Transaction<DatabaseSchema>,
    delivery: DueDelivery,
    now: Date,
  ): Promise<DeliveryPart | undefined> {
    const part = (delivery.parts as DeliveryPart[]).find(
      (p) => !["sent", "skipped", "cancelled", "suppressed"].includes(p.state),
    );
    if (!part || part.state !== "pending" || part.attempts.length >= 90)
      return undefined;
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
    return part;
  }
  async record(
    deliveryId: string,
    attemptId: string,
    result: TelegramDeliveryResult,
  ): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      await schedulerLock(tx, this.config.botIdentity);
      await lockDeliveryContact(tx, this.config.botIdentity, deliveryId);
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
      // A finished response or step opens the contact's next step.
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
