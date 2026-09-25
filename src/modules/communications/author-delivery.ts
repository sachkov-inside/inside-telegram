import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Inject, Injectable } from "@nestjs/common";
import {
  DATABASE,
  type Database,
  type DatabaseSchema,
} from "../../database/database.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import {
  AUTHOR_AUTHORIZATION,
  authorizeAuthor,
  type AuthorAuthorization,
} from "./author-authorization.js";
import {
  type CommunicationTransport,
  type CommunicationMessage,
} from "./communication-delivery.js";
import {
  CommunicationsError,
  type CommunicationsRequest,
  type TemplateContent,
} from "./communications-contract.js";
import { communicationLock } from "./communication-state.js";
import {
  reserveTelegramSlot,
  deferTelegramSlot,
} from "../outbound/telegram-transport-slots.js";
import type { Transaction } from "kysely";
import {
  claim,
  expireLeases,
  retryDelay,
  settle,
  type DurableQueue,
} from "../../database/durable-queue.js";
import { transactionWithExternalReads } from "../../database/external-reads.js";
import { reportFailure } from "../../operations/failure-diagnostics.js";

export const AUTHOR_TRANSPORT = Symbol("AUTHOR_TRANSPORT");

const authorOutbox: DurableQueue<"communication_author_outbox"> = {
  table: "communication_author_outbox",
  key: ["delivery_id"],
  order: ["sequence_id"],
  ready: ["pending"],
  leased: "sending",
  due: "available_at",
  attempts: "attempt_count",
  leasedAt: "attempted_at",
  leaseMs: 60_000,
  retry: { initialMs: 5000, maxMs: 5000 },
};
export async function enqueueAuthorMessage(
  tx: Transaction<DatabaseSchema>,
  input: {
    deliveryId: string;
    botIdentity: string;
    accountRef: string;
    telegramUserId: string;
    telegramIdentityRef: string;
    message: CommunicationMessage;
  },
) {
  await tx
    .insertInto("communication_author_outbox")
    .values({
      delivery_id: input.deliveryId,
      bot_identity: input.botIdentity,
      account_ref: input.accountRef,
      telegram_user_id: input.telegramUserId,
      telegram_identity_ref: input.telegramIdentityRef,
      message: JSON.stringify(input.message),
      state: "pending",
      created_at: new Date(),
      available_at: new Date(),
      attempted_at: null,
      provider_message_id: null,
    })
    .onConflict((c) => c.column("delivery_id").doNothing())
    .execute();
}

@Injectable()
export class AuthorDelivery {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(AUTHOR_AUTHORIZATION)
    private readonly authorization: AuthorAuthorization,
    @Inject(AUTHOR_TRANSPORT)
    private readonly transport: CommunicationTransport,
  ) {}
  async testSend(
    request: CommunicationsRequest,
    transaction?: Transaction<DatabaseSchema>,
  ): Promise<{ testDeliveryId: string }> {
    if (!("accountRef" in request.actor))
      throw new CommunicationsError("forbidden");
    const accountRef = request.actor.accountRef;
    const permission = await authorizeAuthor(this.authorization, {
      kind: "account",
      accountRef,
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
          prior.actor_account_ref !== accountRef ||
          !isDeepStrictEqual(prior.request, request)
        )
          throw new CommunicationsError("operation_conflict");
        return prior.result as { testDeliveryId: string };
      }
      const template = await tx
        .selectFrom("communication_templates")
        .selectAll()
        .where("template_id", "=", request.payload.templateId!)
        .where("bot_identity", "=", this.config.botIdentity)
        .where("owner_account_ref", "=", accountRef)
        .forShare()
        .executeTakeFirst();
      if (!template) throw new CommunicationsError("not_found");
      if (template.revision !== request.expectedRevision)
        throw new CommunicationsError("revision_conflict");
      const link = await tx
        .selectFrom("platform_links")
        .selectAll()
        .where("bot_identity", "=", this.config.botIdentity)
        .where("account_ref", "=", accountRef)
        .forShare()
        .executeTakeFirst();
      if (!link) throw new CommunicationsError("forbidden");
      const result = { testDeliveryId: randomUUID() };
      await enqueueAuthorMessage(tx, {
        deliveryId: result.testDeliveryId,
        botIdentity: this.config.botIdentity,
        accountRef,
        telegramUserId: link.telegram_user_id,
        telegramIdentityRef: link.telegram_identity_ref,
        message: {
          chatId: link.telegram_user_id,
          content: template.content as TemplateContent,
        },
      });
      await tx
        .insertInto("communication_operations")
        .values({
          bot_identity: this.config.botIdentity,
          operation_id: request.operationId,
          actor_account_ref: accountRef,
          request: JSON.stringify(request),
          result: JSON.stringify(result),
          created_at: new Date(),
        })
        .execute();
      return result;
    };
    return transaction
      ? work(transaction)
      : this.database.transaction().execute(work);
  }
  /**
   * Sends at most one due author message. Returns 1 when it found due work, including a message
   * that waits for its Telegram turn, so the worker keeps asking at its busy pace.
   */
  async processAvailable(now = new Date()): Promise<number> {
    if (this.config.deliveryMode !== "live") return 0;
    // Platform authorization is answered with no transaction open; see transactionWithExternalReads.
    const { item, outgoing, rejected, waiting } =
      await transactionWithExternalReads(this.database, async (tx) => {
        // Each round starts clean: a replayed round must not see an earlier round's decisions.
        let rejected = false;
        let waiting = false;
        let outgoing: CommunicationMessage | undefined;
        // A process dying after dispatch cannot know whether Telegram accepted the post.
        await expireLeases(tx, authorOutbox, now, { state: "unknown" });
        const item = await claim(tx, authorOutbox, now, {
          select: [
            "account_ref",
            "bot_identity",
            "delivery_id",
            "message",
            "sequence_id",
            "telegram_identity_ref",
            "telegram_user_id",
          ],
          where: (eb) =>
            eb.and([
              eb("bot_identity", "=", this.config.botIdentity),
              eb.not(
                eb.exists(
                  eb
                    .selectFrom("communication_author_outbox as earlier")
                    .select("earlier.delivery_id")
                    .whereRef(
                      "earlier.bot_identity",
                      "=",
                      "communication_author_outbox.bot_identity",
                    )
                    .whereRef(
                      "earlier.telegram_user_id",
                      "=",
                      "communication_author_outbox.telegram_user_id",
                    )
                    .whereRef(
                      "earlier.sequence_id",
                      "<",
                      "communication_author_outbox.sequence_id",
                    )
                    .where("earlier.state", "in", ["pending", "sending"]),
                ),
              ),
            ]),
          prepare: async (tx, row) => {
            const link = await tx
              .selectFrom("platform_links")
              .selectAll()
              .where("bot_identity", "=", row.bot_identity)
              .where("telegram_user_id", "=", row.telegram_user_id)
              .forShare()
              .executeTakeFirst();
            const allowed =
              link?.account_ref === row.account_ref &&
              link.telegram_identity_ref === row.telegram_identity_ref
                ? await authorizeAuthor(this.authorization, {
                    kind: "telegram",
                    accountRef: row.account_ref,
                    telegramIdentityRef: row.telegram_identity_ref,
                    botIdentity: row.bot_identity,
                  })
                : "denied";
            if (allowed === "unavailable") return undefined;
            if (allowed !== "allowed") {
              await tx
                .updateTable("communication_author_outbox")
                .set({ state: "rejected" })
                .where("delivery_id", "=", row.delivery_id)
                .execute();
              rejected = true;
              return undefined;
            }
            if (
              !(await reserveTelegramSlot(
                tx,
                row.bot_identity,
                row.telegram_user_id,
                now,
              ))
            ) {
              waiting = true;
              return undefined;
            }
            const message = row.message as CommunicationMessage;
            outgoing = message;
            if (
              message.authorMenu &&
              message.editMenu &&
              !message.editMessageId
            ) {
              const previous = await tx
                .selectFrom("communication_author_outbox")
                .select(["message", "provider_message_id", "state"])
                .where("bot_identity", "=", row.bot_identity)
                .where("account_ref", "=", row.account_ref)
                .where("telegram_identity_ref", "=", row.telegram_identity_ref)
                .where("telegram_user_id", "=", row.telegram_user_id)
                .where("sequence_id", "<", row.sequence_id)
                .orderBy("sequence_id", "desc")
                .executeTakeFirst();
              if (
                previous?.state === "delivered" &&
                (previous.message as CommunicationMessage)?.authorMenu &&
                previous?.provider_message_id
              ) {
                outgoing = {
                  ...message,
                  editMessageId: previous.provider_message_id,
                };
                return { message: JSON.stringify(outgoing) };
              }
            }
            return {};
          },
        });
        return { item, outgoing, rejected, waiting };
      });
    if (!item || !outgoing) return rejected || waiting ? 1 : 0;
    let result;
    try {
      result = await this.transport.send(outgoing);
    } catch (error) {
      reportFailure("communications.author-delivery", error, {
        delivery_id: item.row.delivery_id,
      });
      result = { kind: "transport_unknown" as const };
    }
    const retry = result.kind === "api_retryable" && item.attempt < 3;
    const availableAt = new Date(
      now.getTime() +
        (result.kind !== "api_retryable"
          ? 0
          : result.retryAfterSeconds
            ? result.retryAfterSeconds * 1000
            : retryDelay(authorOutbox, item.attempt)),
    );
    await this.database.transaction().execute(async (tx) => {
      if (result.kind === "api_retryable" && result.providerErrorCode === 429)
        await deferTelegramSlot(tx, item.row.bot_identity, availableAt);
      await settle(tx, authorOutbox, item, {
        state:
          result.kind === "delivered"
            ? "delivered"
            : result.kind === "transport_unknown"
              ? "unknown"
              : retry
                ? "pending"
                : "rejected",
        available_at: availableAt,
        diagnostic_code: result.kind,
        provider_message_id:
          result.kind === "delivered" ? result.providerMessageId : null,
      });
    });
    return 1;
  }
}
