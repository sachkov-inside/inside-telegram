import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql, type Transaction } from "kysely";
import { unhandled } from "../../shared/unhandled.js";
import {
  DATABASE,
  type Database,
  type DatabaseSchema,
} from "../../database/database.js";
import { transactionWithExternalReads } from "../../database/external-reads.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { findPlatformLink } from "../identity-linking/platform-links.js";
import { enqueueReply } from "../outbound/start-response-delivery-queue.js";
import {
  AUTHOR_AUTHORIZATION,
  authorizeAuthor,
  type AuthorAuthorization,
} from "./author-authorization.js";
import { AuthorBroadcastDrafts } from "./author-broadcast-drafts.js";
import { AuthorFunnelDrafts } from "./author-funnel-drafts.js";
import {
  AUTHOR_CONTENT_VALIDATION,
  validateAuthorContent,
  type AuthorContentValidation,
} from "./author-content-validation.js";
import { AuthorDelivery, enqueueAuthorMessage } from "./author-delivery.js";
import {
  emptyAuthorState,
  parseAuthorState,
  type AuthorState,
} from "./author-dialog.js";
import {
  discardComposition,
  loadComposition,
  pendingCompositions,
  removeAuthorDraft,
  retainComposition,
  retainFunnelDraft,
  saveAuthorDraft,
} from "./author-drafts.js";
import type { AuthorInput } from "./author-input.js";
import { authorRequest } from "./author-request.js";
import { transition } from "./author-transition.js";
import type { AuthorEffect, AuthorEvent } from "./author-turn.js";
import { communicationLock } from "./communication-state.js";
import { Communications } from "./communications.js";
import {
  CommunicationsError,
  validRequest,
  type CommunicationsRequest,
} from "./communications-contract.js";
import { Funnels } from "./funnels.js";

type Tx = Transaction<DatabaseSchema>;
/** One author update being handled: its transaction, input and authorized author. */
export type Context = {
  tx: Tx;
  input: AuthorInput;
  accountRef: string;
  identityRef: string;
};

/** Failures caused by data that changed under the author; the dialog starts over from home. */
const RECOVERABLE = [
  "revision_conflict",
  "not_found",
  "unsupported_content",
  "malformed",
];

/**
 * Runs the author admin dialog: authorizes each update, feeds it to {@link transition} and
 * executes the effects that transition returns inside the update's transaction.
 */
@Injectable()
export class AuthorAdmin {
  private readonly broadcastDrafts: AuthorBroadcastDrafts;
  private readonly funnelDrafts: AuthorFunnelDrafts;
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(AUTHOR_AUTHORIZATION)
    private readonly authorization: AuthorAuthorization,
    @Inject(Communications) private readonly posts: Communications,
    @Inject(Funnels) private readonly funnels: Funnels,
    @Inject(AuthorDelivery) private readonly delivery: AuthorDelivery,
    @Inject(AUTHOR_CONTENT_VALIDATION)
    private readonly validation: AuthorContentValidation,
  ) {
    this.broadcastDrafts = new AuthorBroadcastDrafts(funnels);
    this.funnelDrafts = new AuthorFunnelDrafts(funnels);
  }
  async handle(input: AuthorInput): Promise<boolean> {
    if (input.botIdentity !== this.config.botIdentity) return false;
    // Platform answers are fetched with no transaction open; see transactionWithExternalReads.
    return transactionWithExternalReads(this.database, async (tx) => {
      await communicationLock(
        tx,
        `communications-intake:${input.botIdentity}:${input.telegramUserId}`,
      );
      const previous = await tx
        .selectFrom("communication_author_receipts")
        .selectAll()
        .where("bot_identity", "=", input.botIdentity)
        .where("update_id", "=", input.updateId)
        .executeTakeFirst();
      if (previous) return true;
      const session = await tx
        .selectFrom("communication_author_sessions")
        .selectAll()
        .where("bot_identity", "=", input.botIdentity)
        .where("telegram_user_id", "=", input.telegramUserId)
        .executeTakeFirst();
      if (/^\/template(?:@[A-Za-z0-9_]+)?$/.test(input.text)) {
        await tx
          .deleteFrom("communication_author_sessions")
          .where("bot_identity", "=", input.botIdentity)
          .where("telegram_user_id", "=", input.telegramUserId)
          .execute();
        return false;
      }
      const open = /^\/admin(?:@[A-Za-z0-9_]+)?$/.test(input.text);
      const close = /^\/cancel(?:@[A-Za-z0-9_]+)?$/.test(input.text);
      if (
        !open &&
        !input.callbackData &&
        (!session || (!close && /^\//.test(input.text)))
      )
        return false;
      const earlier = await tx
        .selectFrom("telegram_updates")
        .select("update_id")
        .where("bot_identity", "=", input.botIdentity)
        .where("update_id", "<", input.updateId)
        .where("state", "in", ["pending", "processing"])
        .where(
          sql<boolean>`coalesce(payload->'callback_query'->'from'->>'id', payload->'message'->'from'->>'id') = ${input.telegramUserId}`,
        )
        .executeTakeFirst();
      if (earlier) throw new Error("Earlier author update is still pending");
      const link = await findPlatformLink(
        tx,
        {
          botIdentity: input.botIdentity,
          telegramUserId: input.telegramUserId,
        },
        "share",
      );
      const allowed = link
        ? await authorizeAuthor(this.authorization, {
            kind: "telegram",
            accountRef: link.accountRef,
            telegramIdentityRef: link.telegramIdentityRef,
            botIdentity: input.botIdentity,
          })
        : "denied";
      if (allowed === "unavailable")
        throw new CommunicationsError("authorization_unavailable");
      if (
        allowed !== "allowed" ||
        !link ||
        (!open && session && session.account_ref !== link.accountRef)
      ) {
        await tx
          .deleteFrom("communication_author_sessions")
          .where("bot_identity", "=", input.botIdentity)
          .where("telegram_user_id", "=", input.telegramUserId)
          .execute();
        // Use the ordinary reply queue for a denial without exposing any author data.
        await enqueueReply(tx, {
          botIdentity: input.botIdentity,
          telegramUserId: input.telegramUserId,
          privateChatId: input.privateChatId,
          messageText:
            "Нет доступа к админке. Свяжите Telegram с аккаунтом, которому разрешено управление рассылками.",
          sourceKey: `author-denied:${input.botIdentity}:${input.updateId}`,
          now: new Date(),
        });
      } else {
        const context: Context = {
          tx,
          input,
          accountRef: link.accountRef,
          identityRef: link.telegramIdentityRef,
        };
        const stored = open ? undefined : parseAuthorState(session?.state);
        const state = await this.step(
          context,
          stored ?? emptyAuthorState(randomUUID()),
          open
            ? { kind: "open" }
            : close
              ? { kind: "close" }
              : input.callbackData
                ? { kind: "callback", data: input.callbackData }
                : { kind: "text", text: input.text, content: input.content },
        );
        await retainFunnelDraft(context, state.funnelAuthor);
        await retainComposition(context, state);
        await tx
          .insertInto("communication_author_sessions")
          .values({
            bot_identity: input.botIdentity,
            telegram_user_id: input.telegramUserId,
            account_ref: link.accountRef,
            state: JSON.stringify(state),
          })
          .onConflict((c) =>
            c.columns(["bot_identity", "telegram_user_id"]).doUpdateSet({
              account_ref: link.accountRef,
              state: JSON.stringify(state),
            }),
          )
          .execute();
        await tx
          .deleteFrom("communication_author_modes")
          .where("bot_identity", "=", input.botIdentity)
          .where("telegram_user_id", "=", input.telegramUserId)
          .execute();
      }
      await tx
        .insertInto("communication_author_receipts")
        .values({
          bot_identity: input.botIdentity,
          update_id: input.updateId,
        })
        .execute();
      return true;
    });
  }

  /**
   * Applies one author update atomically. When a button or a reply fails on changed data, its
   * writes roll back and the author gets the home menu; `/admin` and `/cancel` failures propagate.
   */
  private async step(
    c: Context,
    state: AuthorState,
    event: AuthorEvent,
  ): Promise<AuthorState> {
    // Expected revisions are taken from the menu the author actually saw.
    await sql`savepoint author_admin_action`.execute(c.tx);
    try {
      const next = await this.run(c, state, event);
      await sql`release savepoint author_admin_action`.execute(c.tx);
      return next;
    } catch (error) {
      await sql`rollback to savepoint author_admin_action`.execute(c.tx);
      if (
        (event.kind !== "callback" && event.kind !== "text") ||
        !(error instanceof CommunicationsError) ||
        !RECOVERABLE.includes(error.code)
      )
        throw error;
      return this.run(c, state, { kind: "failed", during: event.kind });
    }
  }

  /** Executes transitions until the dialog stops asking for answers. */
  private async run(
    c: Context,
    state: AuthorState,
    first: AuthorEvent,
  ): Promise<AuthorState> {
    let pending = await pendingCompositions(c);
    let event: AuthorEvent | undefined = first;
    while (event) {
      const next = transition(state, event, {
        pendingCompositions: pending,
        now: new Date(),
        newId: randomUUID,
      });
      state = next.state;
      event = undefined;
      for (const effect of next.effects) {
        if (effect.kind === "discard-composition") {
          pending = new Set(pending);
          pending.delete(effect.id);
        }
        event = await this.execute(c, effect);
      }
    }
    return state;
  }

  private request(
    c: Context,
    operation: string,
    payload: CommunicationsRequest["payload"],
    revision = 0,
  ): CommunicationsRequest {
    return authorRequest(c.accountRef, operation, payload, revision);
  }

  private async execute(
    c: Context,
    effect: AuthorEffect,
  ): Promise<AuthorEvent | undefined> {
    switch (effect.kind) {
      case "menu":
        await this.enqueue(c, {
          content: {
            type: "text",
            text: effect.text,
            entities: [],
            buttons: [],
          },
          authorMenu: true,
          editMenu: Boolean(c.input.callbackData) && !effect.fresh,
          authorButtons: effect.buttons,
        });
        return;
      case "message":
        await this.enqueue(c, { content: effect.content });
        return;
      case "test-send":
        await this.delivery.testSend(
          this.request(
            c,
            "templates.testSend",
            { templateId: effect.templateId },
            effect.revision,
          ),
          c.tx,
        );
        return;
      case "retain-broadcast": {
        const b = effect.broadcast;
        await saveAuthorDraft(
          c,
          b.broadcastId,
          "broadcast",
          effect.name ?? "Новая рассылка",
          b.revision === 0 ? b : null,
        );
        return;
      }
      case "retain-funnel-draft":
        await retainFunnelDraft(c, effect.funnelAuthor);
        return;
      case "remove-draft":
        await removeAuthorDraft(c, effect.id);
        return;
      case "discard-composition":
        await discardComposition(c, effect.id);
        return;
      case "read-statistics": {
        const result = await this.funnels.execute(
          this.request(
            c,
            "statistics.read",
            effect.broadcastId ? { broadcastId: effect.broadcastId } : {},
          ),
          c.tx,
        );
        return {
          kind: "statistics-read",
          broadcastId: effect.broadcastId,
          deliveries:
            "statistics" in result ? result.statistics.deliveries : undefined,
        };
      }
      case "list-posts": {
        const list = await this.posts.list(
          this.request(
            c,
            "templates.list",
            effect.cursor ? { cursor: effect.cursor } : {},
          ),
          c.tx,
          { search: effect.search, limit: 10 },
        );
        return {
          kind: "posts-listed",
          purpose: effect.purpose,
          cursor: effect.cursor,
          templates: list.templates,
          nextCursor: list.nextCursor,
        };
      }
      case "read-post":
        return {
          kind: "post-read",
          purpose: effect.purpose,
          template: await this.posts.execute(
            this.request(c, "templates.read", {
              templateId: effect.templateId,
            }),
            c.tx,
          ),
        };
      case "save-post":
        try {
          return {
            kind: "post-saved",
            template: await this.posts.execute(
              this.request(
                c,
                "templates.save",
                { templateId: effect.templateId, content: effect.content },
                effect.revision,
              ),
              c.tx,
            ),
          };
        } catch (error) {
          if (
            !effect.reportConflict ||
            !(error instanceof CommunicationsError) ||
            error.code !== "revision_conflict"
          )
            throw error;
          return { kind: "post-conflict" };
        }
      case "save-broadcast": {
        const b = effect.broadcast;
        const result = await this.funnels.execute(
          this.request(
            c,
            "broadcasts.save",
            {
              broadcastId: b.broadcastId,
              parts: b.parts,
              audience: b.audience,
              scheduledAt: b.scheduledAt,
            },
            b.revision,
          ),
          c.tx,
        );
        return {
          kind: "broadcast-saved",
          broadcast: "broadcast" in result ? result.broadcast : undefined,
          then: effect.then,
        };
      }
      case "change-broadcast": {
        const result = await this.funnels.execute(
          this.request(
            c,
            effect.operation === "launch"
              ? "broadcasts.launch"
              : "broadcasts.lifecycle",
            {
              broadcastId: effect.broadcastId,
              ...(effect.operation !== "launch"
                ? { action: effect.operation }
                : {}),
            },
            effect.revision,
          ),
          c.tx,
        );
        return {
          kind: "broadcast-changed",
          broadcast: "broadcast" in result ? result.broadcast : undefined,
        };
      }
      case "list-broadcasts":
        return {
          kind: "broadcasts-listed",
          ...(await this.broadcastDrafts.list(c, effect.cursor)),
        };
      case "read-broadcast":
        return {
          kind: "broadcast-read",
          ...(await this.broadcastDrafts.read(c, effect.broadcastId)),
        };
      case "restore-composition":
        return {
          kind: "composition-restored",
          composing: await loadComposition(c, effect.destinationId),
          then: effect.then,
        };
      case "list-funnels":
        return {
          kind: "funnels-listed",
          ...(await this.funnelDrafts.list(c, effect.cursor)),
        };
      case "read-funnel":
        return {
          kind: "funnel-read",
          funnelAuthor: await this.funnelDrafts.read(c, effect.funnelId),
        };
      case "read-intro":
        return {
          kind: "intro-read",
          funnelAuthor: await this.funnelDrafts.readIntro(c),
        };
      case "save-funnel": {
        const f = effect.funnel;
        const request = this.request(
          c,
          "funnels.save",
          {
            funnelId: f.funnelId,
            name: f.name,
            isDefault: f.isDefault,
            sources: f.sources,
            entryResponse: f.entryResponse,
            steps: f.steps,
          },
          f.revision,
        );
        if (!validRequest(request))
          return { kind: "funnel-invalid", then: effect.then };
        const result = await this.funnels.execute(request, c.tx);
        return {
          kind: "funnel-saved",
          funnel: "funnel" in result ? result.funnel : undefined,
          then: effect.then,
        };
      }
      case "validate-content":
        return {
          kind: "content-validated",
          purpose: effect.purpose,
          result: await validateAuthorContent(
            this.validation,
            {
              kind: "telegram",
              accountRef: c.accountRef,
              telegramIdentityRef: c.identityRef,
              botIdentity: c.input.botIdentity,
            },
            effect.parts,
          ),
        };
      case "save-intro": {
        const result = await this.funnels.execute(
          this.request(
            c,
            "intro.save",
            { introId: effect.intro.introId, parts: effect.intro.parts },
            effect.intro.revision,
          ),
          c.tx,
        );
        return {
          kind: "intro-saved",
          intro: "intro" in result ? result.intro : undefined,
        };
      }
      case "lock-funnel": {
        const loaded = await this.funnels.execute(
          this.request(c, "funnels.read", { funnelId: effect.funnelId }),
          c.tx,
        );
        return {
          kind: "funnel-locked",
          publish: effect.publish,
          revision: "funnel" in loaded ? loaded.funnel.revision : undefined,
        };
      }
      case "publish-funnel": {
        const output = await this.funnels.execute(
          this.request(
            c,
            effect.publish ? "funnels.publish" : "funnels.preview",
            { funnelId: effect.funnelId },
            effect.revision,
          ),
          c.tx,
        );
        if ("funnel" in output)
          return { kind: "funnel-published", funnel: output.funnel };
        if ("preview" in output)
          return { kind: "publication-previewed", preview: output.preview };
        throw new CommunicationsError("malformed");
      }
      case "change-funnel": {
        const result = await this.funnels.execute(
          this.request(
            c,
            "funnels.lifecycle",
            { funnelId: effect.funnelId, action: effect.action },
            effect.revision,
          ),
          c.tx,
        );
        return {
          kind: "funnel-changed",
          funnel: "funnel" in result ? result.funnel : undefined,
        };
      }
      case "read-part-history":
        return {
          kind: "part-history-read",
          partId: effect.partId,
          delaySeconds: effect.delaySeconds,
          published: await this.funnelDrafts.wasPublished(
            c,
            effect.funnelId,
            effect.partId,
          ),
        };
      default:
        return unhandled(effect, "author effect");
    }
  }

  private async enqueue(
    c: Context,
    message: Omit<
      Parameters<typeof enqueueAuthorMessage>[1]["message"],
      "chatId"
    >,
  ) {
    await enqueueAuthorMessage(c.tx, {
      deliveryId: randomUUID(),
      botIdentity: c.input.botIdentity,
      accountRef: c.accountRef,
      telegramUserId: c.input.telegramUserId,
      telegramIdentityRef: c.identityRef,
      message: { chatId: c.input.telegramUserId, ...message },
    });
  }
}
