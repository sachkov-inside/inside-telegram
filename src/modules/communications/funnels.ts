import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  AUTHOR_AUTHORIZATION,
  type AuthorAuthorization,
} from "./author-authorization.js";
import {
  CommunicationsError,
  type CommunicationsRequest,
  validateContent,
} from "./communications-contract.js";
import type {
  FunnelDraft,
  FunnelSnapshot,
  IntroSnapshot,
  MessagePart,
  DeliveryPart,
  DeliverySnapshot,
} from "./funnel-types.js";

export async function communicationLock(
  tx: Transaction<DatabaseSchema>,
  key: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
    tx,
  );
}
export type FunnelResult =
  | { funnel: FunnelSnapshot }
  | { funnels: FunnelSnapshot[]; nextCursor: string | null }
  | { intro: IntroSnapshot }
  | { deliveries: DeliverySnapshot[]; nextCursor: string | null };

@Injectable()
export class Funnels {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(AUTHOR_AUTHORIZATION)
    private readonly authorization: AuthorAuthorization,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  async execute(request: CommunicationsRequest): Promise<FunnelResult> {
    if (!("accountRef" in request.actor))
      throw new CommunicationsError("not_implemented");
    const actor = request.actor.accountRef;
    const permission = await this.authorization.authorize({
      kind: "account",
      accountRef: actor,
    });
    if (permission !== "allowed")
      throw new CommunicationsError(
        permission === "denied" ? "forbidden" : "authorization_unavailable",
      );
    return this.database.transaction().execute(async (tx) => {
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
        return prior.result as FunnelResult;
      }
      await communicationLock(
        tx,
        `communications-definitions:${this.config.botIdentity}`,
      );
      const result = await this.apply(tx, request, actor);
      if (
        ![
          "funnels.read",
          "funnels.list",
          "intro.read",
          "deliveries.read",
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
    });
  }
  private async apply(
    tx: Transaction<DatabaseSchema>,
    request: CommunicationsRequest,
    actor: string,
  ): Promise<FunnelResult> {
    const { operation, payload, expectedRevision } = request;
    const bot = this.config.botIdentity;
    if (operation === "intro.read" || operation === "intro.save") {
      const row = await tx
        .selectFrom("communication_intro")
        .selectAll()
        .where("bot_identity", "=", bot)
        .executeTakeFirst();
      if (row && row.owner_account_ref !== actor)
        throw new CommunicationsError("not_found");
      const old = row?.snapshot as IntroSnapshot | undefined;
      if (operation === "intro.read") {
        if (!old) throw new CommunicationsError("not_found");
        return { intro: old };
      }
      if ((old?.revision ?? 0) !== expectedRevision)
        throw new CommunicationsError("revision_conflict");
      if (old && old.introId !== payload.introId)
        throw new CommunicationsError("revision_conflict");
      validateParts(payload.parts!);
      const intro: IntroSnapshot = {
        introId: payload.introId!,
        revision: expectedRevision + 1,
        parts: payload.parts!,
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
        nextCursor: rows.length > 100 ? rows[99]!.funnel_id : null,
      };
    }
    if (operation === "deliveries.read") {
      let query = tx
        .selectFrom("communication_deliveries as d")
        .leftJoin("communication_funnels as f", "f.funnel_id", "d.funnel_id")
        .leftJoin(
          "communication_intro as i",
          "i.bot_identity",
          "d.bot_identity",
        )
        .selectAll("d")
        .where("d.bot_identity", "=", bot)
        .where((eb) =>
          eb.or([
            eb("f.owner_account_ref", "=", actor),
            eb.and([
              eb("d.funnel_id", "is", null),
              eb("i.owner_account_ref", "=", actor),
            ]),
          ]),
        );
      if (payload.funnelId)
        query = query.where("d.funnel_id", "=", payload.funnelId);
      if (payload.deliveryId)
        query = query.where("d.delivery_id", "=", payload.deliveryId);
      if (payload.broadcastId) return { deliveries: [], nextCursor: null };
      if (payload.cursor)
        query = query.where(
          "d.delivery_id",
          ">",
          requireCursor(payload.cursor),
        );
      const rows = await query.orderBy("d.delivery_id").limit(101).execute();
      return {
        deliveries: rows.slice(0, 100).map((r) => ({
          deliveryId: r.delivery_id,
          revision: r.revision,
          contactId: r.contact_id,
          funnelId: r.funnel_id,
          broadcastId: null,
          stepId: r.step_id,
          publishedRevision: r.published_revision,
          snapshot: r.snapshot as MessagePart[],
          parts: r.parts as DeliveryPart[],
          cancelRequested: r.cancel_requested,
          completedAt: r.completed_at?.toISOString() ?? null,
        })),
        nextCursor: rows.length > 100 ? rows[99]!.delivery_id : null,
      };
    }
    if (
      ![
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
      .where("funnel_id", "=", payload.funnelId!)
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
        funnelId: payload.funnelId!,
        name: payload.name!,
        steps: payload.steps!,
        sources: payload.sources!,
        isDefault: payload.isDefault!,
        entryResponse: payload.entryResponse!,
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
    if (operation === "funnels.lifecycle") {
      const lifecycle = (
        {
          pause: "paused",
          resume: "published",
          archive: "archived",
          restore: "paused",
        } as const
      )[payload.action!];
      if (!existing.published || !lifecycle)
        throw new CommunicationsError("revision_conflict");
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
    const draft = existing.draft as FunnelDraft;
    const previous = existing.published as FunnelDraft | null;
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
            (s.part_ids as string[]).some((id) =>
              step.parts.some((p) => p.partId === id),
            ),
        )
      )
        throw new CommunicationsError("revision_conflict");
      const partIds = [
        ...new Set([
          ...((saved?.part_ids as string[] | undefined) ?? []),
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
        lifecycle: "published",
        is_default: draft.isDefault,
      })
      .where("funnel_id", "=", draft.funnelId)
      .execute();
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
  draft: unknown;
  revision: number;
  published_revision: number | null;
  lifecycle: FunnelSnapshot["lifecycle"];
}): FunnelSnapshot {
  return {
    ...(row.draft as FunnelDraft),
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

export async function planDelivery(
  tx: Transaction<DatabaseSchema>,
  input: {
    bot: string;
    contactId: string;
    funnelId?: string;
    stepId?: string;
    kind: "intro" | "entry" | "step" | "fallback";
    key: string;
    parts: readonly MessagePart[];
    revision: number;
    dueAt: Date;
    now: Date;
  },
): Promise<void> {
  await tx
    .insertInto("communication_deliveries")
    .values({
      delivery_id: randomUUID(),
      dedup_key: input.key,
      bot_identity: input.bot,
      contact_id: input.contactId,
      funnel_id: input.funnelId ?? null,
      step_id: input.stepId ?? null,
      kind: input.kind,
      published_revision: input.revision,
      snapshot: JSON.stringify(input.parts),
      parts: JSON.stringify(
        input.parts.map((p) => ({
          partId: p.partId,
          state: "pending",
          diagnosticCode: null,
          attempts: [],
        })),
      ),
      revision: 1,
      due_at: input.dueAt,
      created_at: input.now,
      completed_at: null,
      cancel_requested: false,
      attempt_id: null,
      locked_at: null,
    })
    .onConflict((c) => c.column("dedup_key").doNothing())
    .execute();
}
