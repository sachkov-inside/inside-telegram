import {
  AUTHOR_CONTENT_VALIDATION,
  type AuthorContentValidation,
  validateAuthorContent,
} from "./author-content-validation.js";
import { previewFunnel, type FunnelPreview } from "./funnel-preview.js";
import { transactionWithExternalReads } from "../../database/external-reads.js";
import { deliveryOwnerPredicate, nextCursor } from "./communication-queries.js";
import { applyBroadcast, type BroadcastResult } from "./broadcasts.js";
import {
  readStatistics,
  readEntries,
  type StatisticsResult,
  type EntriesResult,
} from "./communication-statistics.js";
import { reconcileFunnels, terminal, deliveryView } from "./funnel-timeline.js";
import {
  communicationLock,
  lockContactRows,
  lockDeliveryContact,
  replayedResult,
  schedulerLock,
} from "./communication-state.js";
import { isDeepStrictEqual } from "node:util";
import { Inject, Injectable } from "@nestjs/common";
import type { Transaction } from "kysely";
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
  AUTHOR_AUTHORIZATION,
  authorizeAuthor,
  type AuthorAuthorization,
} from "./author-authorization.js";
import {
  CommunicationsError,
  type CommunicationsRequest,
  requiredField,
  validateContent,
} from "./communications-contract.js";
import type {
  FunnelDraft,
  FunnelSnapshot,
  IntroSnapshot,
  MessagePart,
  DeliverySnapshot,
} from "./funnel-types.js";

export type FunnelResult =
  | { preview: FunnelPreview }
  | BroadcastResult
  | StatisticsResult
  | EntriesResult
  | { funnel: FunnelSnapshot }
  | { funnels: FunnelSnapshot[]; nextCursor: string | null }
  | { intro: IntroSnapshot }
  | {
      deliveryId: string;
      partId: string;
      outcome: "skipped" | "retry_requested";
    }
  | { deliveries: DeliverySnapshot[]; nextCursor: string | null };

const LIFECYCLE_AFTER = {
  pause: "paused",
  resume: "published",
  archive: "archived",
  restore: "paused",
} as const;

@Injectable()
export class Funnels {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(AUTHOR_AUTHORIZATION)
    private readonly authorization: AuthorAuthorization,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUTHOR_CONTENT_VALIDATION)
    private readonly contentValidation: AuthorContentValidation,
  ) {}
  async execute(
    request: CommunicationsRequest,
    transaction?: Transaction<DatabaseSchema>,
  ): Promise<FunnelResult> {
    if (!("accountRef" in request.actor))
      throw new CommunicationsError("not_implemented");
    const actor = request.actor.accountRef;
    const permission = await authorizeAuthor(this.authorization, {
      kind: "account",
      accountRef: actor,
    });
    if (permission !== "allowed")
      throw new CommunicationsError(
        permission === "denied" ? "forbidden" : "authorization_unavailable",
      );
    const work = async (tx: Transaction<DatabaseSchema>) => {
      await communicationLock(
        tx,
        `communications-operation:${this.config.botIdentity}:${request.operationId}`,
      );
      const prior = await tx
        .selectFrom("communication_operations")
        .selectAll()
        .where("bot_identity", "=", this.config.botIdentity)
        .where("operation_id", "=", request.operationId)
        .executeTakeFirst();
      if (prior) {
        if (
          prior.actor_account_ref !== actor ||
          !isDeepStrictEqual(prior.request, request)
        )
          throw new CommunicationsError("operation_conflict");
        return replayedResult<FunnelResult>(prior);
      }
      await communicationLock(
        tx,
        `communications-definitions:${this.config.botIdentity}`,
      );
      await schedulerLock(tx, this.config.botIdentity);
      const result = await this.apply(tx, request, actor);
      if (
        ![
          "funnels.read",
          "funnels.list",
          "funnels.preview",
          "intro.read",
          "deliveries.read",
          "broadcasts.read",
          "broadcasts.list",
          "statistics.read",
          "entries.read",
        ].includes(request.operation)
      ) {
        await tx
          .insertInto("communication_operations")
          .values({
            bot_identity: this.config.botIdentity,
            operation_id: request.operationId,
            actor_account_ref: actor,
            request: JSON.stringify(request),
            result: JSON.stringify(result),
            created_at: this.clock.now(),
          })
          .execute();
      }
      return result;
    };
    return transaction
      ? work(transaction)
      : transactionWithExternalReads(this.database, work);
  }
  private async apply(
    tx: Transaction<DatabaseSchema>,
    request: CommunicationsRequest,
    actor: string,
  ): Promise<FunnelResult> {
    const { operation, payload, expectedRevision } = request;
    const bot = this.config.botIdentity;
    if (operation.startsWith("broadcasts."))
      return applyBroadcast(tx, request, bot, actor, this.clock.now());
    if (operation === "statistics.read")
      return readStatistics(tx, request, bot, actor);
    if (operation === "entries.read")
      return readEntries(tx, request, bot, actor);
    if (operation === "intro.read" || operation === "intro.save") {
      const row = await tx
        .selectFrom("communication_intro")
        .selectAll()
        .where("bot_identity", "=", bot)
        .executeTakeFirst();
      if (row && row.owner_account_ref !== actor)
        throw new CommunicationsError("not_found");
      const old = row?.snapshot;
      if (operation === "intro.read") {
        if (!old) throw new CommunicationsError("not_found");
        return { intro: old };
      }
      if ((old?.revision ?? 0) !== expectedRevision)
        throw new CommunicationsError("revision_conflict");
      if (old && old.introId !== payload.introId)
        throw new CommunicationsError("revision_conflict");
      validateParts(requiredField(payload.parts));
      const intro: IntroSnapshot = {
        introId: requiredField(payload.introId),
        revision: expectedRevision + 1,
        parts: requiredField(payload.parts),
      };
      await tx
        .insertInto("communication_intro")
        .values({
          bot_identity: bot,
          owner_account_ref: actor,
          snapshot: JSON.stringify(intro),
        })
        .onConflict((c) =>
          c
            .column("bot_identity")
            .doUpdateSet({ snapshot: JSON.stringify(intro) }),
        )
        .execute();
      return { intro };
    }
    if (operation === "funnels.list") {
      let query = tx
        .selectFrom("communication_funnels")
        .selectAll()
        .where("bot_identity", "=", bot)
        .where("owner_account_ref", "=", actor);
      if (payload.cursor)
        query = query.where("funnel_id", ">", requireCursor(payload.cursor));
      const rows = await query.orderBy("funnel_id").limit(101).execute();
      return {
        funnels: rows.slice(0, 100).map(funnelView),
        nextCursor: nextCursor(rows, 100, (row) => row.funnel_id),
      };
    }
    if (operation === "deliveries.read") {
      let query = tx
        .selectFrom("communication_deliveries as d")
        .leftJoin("communication_funnels as f", "f.funnel_id", "d.funnel_id")
        .leftJoin(
          "communication_broadcasts as b",
          "b.broadcast_id",
          "d.broadcast_id",
        )
        .leftJoin(
          "communication_intro as i",
          "i.bot_identity",
          "d.bot_identity",
        )
        .selectAll("d")
        .where("d.bot_identity", "=", bot)
        .where(deliveryOwnerPredicate(actor));
      if (payload.funnelId)
        query = query.where("d.funnel_id", "=", payload.funnelId);
      if (payload.deliveryId)
        query = query.where("d.delivery_id", "=", payload.deliveryId);
      if (payload.broadcastId)
        query = query.where("d.broadcast_id", "=", payload.broadcastId);
      if (payload.cursor)
        query = query.where(
          "d.delivery_id",
          ">",
          requireCursor(payload.cursor),
        );
      const rows = await query.orderBy("d.delivery_id").limit(101).execute();
      return {
        deliveries: rows.slice(0, 100).map(deliveryView),
        nextCursor: nextCursor(rows, 100, (row) => row.delivery_id),
      };
    }
    if (operation === "delivery.resolve") {
      // The decision is serialized with this contact's own commands, claim and result.
      await lockDeliveryContact(tx, bot, requiredField(payload.deliveryId));
      const row = await tx
        .selectFrom("communication_deliveries as d")
        .leftJoin("communication_funnels as f", "f.funnel_id", "d.funnel_id")
        .leftJoin(
          "communication_broadcasts as b",
          "b.broadcast_id",
          "d.broadcast_id",
        )
        .leftJoin(
          "communication_intro as i",
          "i.bot_identity",
          "d.bot_identity",
        )
        .selectAll("d")
        .where("d.delivery_id", "=", requiredField(payload.deliveryId))
        .where("d.bot_identity", "=", bot)
        .where(deliveryOwnerPredicate(actor))
        .executeTakeFirst();
      if (!row) throw new CommunicationsError("not_found");
      if (row.revision !== expectedRevision || row.completed_at)
        throw new CommunicationsError("revision_conflict");
      const parts = row.parts;
      const part = parts.find((p) => p.partId === payload.partId);
      if (!part || !["unknown", "failed"].includes(part.state))
        throw new CommunicationsError("revision_conflict");
      if (payload.action === "retry") {
        if (
          row.cancel_requested ||
          part.attempts.length >= 90 ||
          (part.state === "unknown" && !payload.duplicateRiskAccepted)
        )
          throw new CommunicationsError("revision_conflict");
        part.state = "pending";
        part.diagnosticCode = payload.duplicateRiskAccepted
          ? "explicit_retry_duplicate_risk"
          : "explicit_retry";
      } else {
        part.state = "skipped";
        part.diagnosticCode = "operator_skip";
      }
      const updated = await tx
        .updateTable("communication_deliveries")
        .set({
          parts: JSON.stringify(parts),
          revision: row.revision + 1,
          completed_at: terminal(parts) ? this.clock.now() : null,
          due_at: this.clock.now(),
          attempt_id: null,
          locked_at: null,
        })
        .where("delivery_id", "=", row.delivery_id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (updated.completed_at)
        await reconcileFunnels(tx, bot, this.clock.now(), {
          contactId: updated.contact_id,
        });
      return {
        deliveryId: updated.delivery_id,
        partId: part.partId,
        outcome: payload.action === "retry" ? "retry_requested" : "skipped",
      };
    }
    if (
      ![
        "funnels.rollback",
        "funnels.preview",
        "funnels.save",
        "funnels.read",
        "funnels.publish",
        "funnels.lifecycle",
      ].includes(operation)
    )
      throw new CommunicationsError("not_implemented");
    const existing = await tx
      .selectFrom("communication_funnels")
      .selectAll()
      .where("funnel_id", "=", requiredField(payload.funnelId))
      .executeTakeFirst();
    if (
      existing &&
      (existing.bot_identity !== bot || existing.owner_account_ref !== actor)
    )
      throw new CommunicationsError("not_found");
    if (operation === "funnels.read") {
      if (!existing) throw new CommunicationsError("not_found");
      return { funnel: funnelView(existing) };
    }
    if ((existing?.revision ?? 0) !== expectedRevision)
      throw new CommunicationsError("revision_conflict");
    if (operation === "funnels.save") {
      const draft: FunnelDraft = {
        funnelId: requiredField(payload.funnelId),
        name: requiredField(payload.name),
        steps: requiredField(payload.steps),
        sources: requiredField(payload.sources),
        isDefault: requiredField(payload.isDefault),
        entryResponse: requiredField(payload.entryResponse),
      };
      unique([draft.entryResponse.stepId, ...draft.steps.map((s) => s.stepId)]);
      const allParts = [draft.entryResponse, ...draft.steps].flatMap(
        (s) => s.parts,
      );
      validateParts(allParts);
      unique(draft.sources.map((s) => s.sourceId));
      unique(draft.sources.map((s) => s.code));
      // Legacy auth tokens own the complete 43–64 character base64url namespace.
      if (draft.sources.some((s) => s.code.length >= 43))
        throw new CommunicationsError("malformed");
      const revision = expectedRevision + 1;
      await tx
        .insertInto("communication_funnels")
        .values({
          funnel_id: draft.funnelId,
          bot_identity: bot,
          owner_account_ref: actor,
          revision,
          published_revision: null,
          lifecycle: "draft",
          draft: JSON.stringify(draft),
          published: null,
          is_default: false,
        })
        .onConflict((c) =>
          c
            .column("funnel_id")
            .doUpdateSet({ revision, draft: JSON.stringify(draft) }),
        )
        .execute();
      for (const source of draft.sources) {
        const reserved = await tx
          .selectFrom("communication_sources")
          .selectAll()
          .where("bot_identity", "=", bot)
          .where((eb) =>
            eb.or([
              eb("source_id", "=", source.sourceId),
              eb("code", "=", source.code),
            ]),
          )
          .execute();
        if (
          reserved.some(
            (r) =>
              r.funnel_id !== draft.funnelId ||
              r.source_id !== source.sourceId ||
              r.code !== source.code,
          )
        )
          throw new CommunicationsError("revision_conflict");
        await tx
          .insertInto("communication_sources")
          .values({
            bot_identity: bot,
            source_id: source.sourceId,
            code: source.code,
            funnel_id: draft.funnelId,
          })
          .onConflict((c) => c.doNothing())
          .execute();
      }
      return {
        funnel: {
          ...draft,
          revision,
          publishedRevision: existing?.published_revision ?? null,
          lifecycle: existing?.lifecycle ?? "draft",
        },
      };
    }
    if (!existing) throw new CommunicationsError("not_found");
    if (operation === "funnels.preview") {
      return {
        preview: await previewFunnel(
          tx,
          bot,
          existing.draft,
          existing.published,
          existing.revision,
        ),
      };
    }
    if (operation === "funnels.lifecycle") {
      const action = payload.action;
      if (
        (action !== "pause" &&
          action !== "resume" &&
          action !== "archive" &&
          action !== "restore") ||
        (!existing.published && action !== "archive" && action !== "restore")
      )
        throw new CommunicationsError("revision_conflict");
      const lifecycle: "draft" | "published" | "paused" | "archived" =
        !existing.published && action === "restore"
          ? "draft"
          : LIFECYCLE_AFTER[action];
      await tx
        .updateTable("communication_funnels")
        .set({ lifecycle, revision: expectedRevision + 1 })
        .where("funnel_id", "=", existing.funnel_id)
        .execute();
      return {
        funnel: {
          ...funnelView(existing),
          lifecycle,
          revision: expectedRevision + 1,
        },
      };
    }
    let draft = existing.draft;
    const rollback = operation === "funnels.rollback";
    if (rollback) {
      const publication = await tx
        .selectFrom("communication_publications")
        .select("snapshot")
        .where("funnel_id", "=", existing.funnel_id)
        .where("revision", "=", requiredField(payload.publishedRevision))
        .executeTakeFirst();
      if (!publication) throw new CommunicationsError("not_found");
      draft = publication.snapshot;
      // Validate the immutable historical snapshot under the definition lock. Receipts and
      // expectedRevision were checked first, so replay never re-publishes changed content.
      const validation = await validateAuthorContent(
        this.contentValidation,
        { kind: "account", accountRef: actor },
        [draft.entryResponse, ...draft.steps].flatMap((step) => step.parts),
      );
      if (validation.status !== "ok")
        throw new CommunicationsError(
          validation.status === "denied"
            ? "forbidden"
            : "authorization_unavailable",
        );
      if (validation.targetErrors.length)
        throw new CommunicationsError("unsupported_content");
    }
    const previous = existing.published;
    const intro = await tx
      .selectFrom("communication_intro")
      .select("snapshot")
      .where("bot_identity", "=", bot)
      .executeTakeFirst();
    if (!intro) throw new CommunicationsError("revision_conflict");
    const now = this.clock.now();
    const historicalSteps = await tx
      .selectFrom("communication_step_ids")
      .selectAll()
      .where("funnel_id", "=", draft.funnelId)
      .execute();
    if (
      previous &&
      (previous.entryResponse.stepId !== draft.entryResponse.stepId ||
        draft.steps.some((s) => s.stepId === previous.entryResponse.stepId))
    )
      throw new CommunicationsError("revision_conflict");
    for (const step of [draft.entryResponse, ...draft.steps]) {
      const saved = await tx
        .selectFrom("communication_step_ids")
        .selectAll()
        .where("funnel_id", "=", draft.funnelId)
        .where("step_id", "=", step.stepId)
        .executeTakeFirst();
      if (
        saved &&
        !rollback &&
        previous &&
        ![previous.entryResponse, ...previous.steps].some(
          (s) => s.stepId === step.stepId,
        )
      )
        throw new CommunicationsError("revision_conflict");
      if (
        historicalSteps.some(
          (s) =>
            s.step_id !== step.stepId &&
            s.part_ids.some((id) => step.parts.some((p) => p.partId === id)),
        )
      )
        throw new CommunicationsError("revision_conflict");
      const partIds = [
        ...new Set([
          ...(saved?.part_ids ?? []),
          ...step.parts.map((p) => p.partId),
        ]),
      ];
      await tx
        .insertInto("communication_step_ids")
        .values({
          funnel_id: draft.funnelId,
          step_id: step.stepId,
          first_published_at: now,
          part_ids: JSON.stringify(partIds),
        })
        .onConflict((c) =>
          c
            .columns(["funnel_id", "step_id"])
            .doUpdateSet({ part_ids: JSON.stringify(partIds) }),
        )
        .execute();
    }
    if (draft.isDefault)
      await tx
        .updateTable("communication_funnels")
        .set({ is_default: false })
        .where("bot_identity", "=", bot)
        .where("is_default", "=", true)
        .execute();
    const revision = expectedRevision + 1;
    await tx
      .insertInto("communication_publications")
      .values({
        funnel_id: draft.funnelId,
        revision,
        snapshot: JSON.stringify(draft),
        published_at: now,
      })
      .execute();
    await tx
      .updateTable("communication_funnels")
      .set({
        revision,
        published_revision: revision,
        published: JSON.stringify(draft),
        ...(rollback ? { draft: JSON.stringify(draft) } : {}),
        lifecycle: "published",
        is_default: draft.isDefault,
      })
      .where("funnel_id", "=", draft.funnelId)
      .execute();
    if (rollback) {
      // Only never-attempted deletion cancellations can return. Sent, skipped and
      // subscriber suppression remain durable markers across every revision.
      const revivable = tx
        .selectFrom("communication_deliveries")
        .where("funnel_id", "=", draft.funnelId)
        .where("cancel_requested", "=", true);
      await lockContactRows(
        tx,
        (await revivable.select("contact_id").execute()).map(
          (d) => d.contact_id,
        ),
      );
      const cancelled = await revivable.selectAll().execute();
      for (const delivery of cancelled) {
        const parts = delivery.parts;
        if (
          draft.steps.some((s) => s.stepId === delivery.step_id) &&
          parts.every(
            (p) =>
              p.state === "cancelled" &&
              p.diagnosticCode === "step_deleted" &&
              p.attempts.length === 0,
          )
        )
          await tx
            .updateTable("communication_deliveries")
            .set({
              completed_at: null,
              cancel_requested: false,
              parts: JSON.stringify(
                parts.map((p) => ({
                  ...p,
                  state: "pending",
                  diagnosticCode: null,
                })),
              ),
              revision: delivery.revision + 1,
            })
            .where("delivery_id", "=", delivery.delivery_id)
            .execute();
      }
    }
    await reconcileFunnels(tx, bot, now, { funnelId: draft.funnelId });
    return {
      funnel: {
        ...draft,
        revision,
        publishedRevision: revision,
        lifecycle: "published",
      },
    };
  }
}
function funnelView(row: {
  draft: FunnelDraft;
  revision: number;
  published_revision: number | null;
  lifecycle: FunnelSnapshot["lifecycle"];
}): FunnelSnapshot {
  return {
    ...row.draft,
    revision: row.revision,
    publishedRevision: row.published_revision,
    lifecycle: row.lifecycle,
  };
}
function unique(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length)
    throw new CommunicationsError("malformed");
}
function validateParts(parts: readonly MessagePart[]): void {
  unique(parts.map((p) => p.partId));
  for (const part of parts) validateContent(part.content);
}
function requireCursor(cursor: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      cursor,
    )
  )
    throw new CommunicationsError("malformed");
  return cursor;
}
