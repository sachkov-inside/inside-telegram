import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import type { Transaction } from "kysely";

import {
  DATABASE,
  type Database,
  type DatabaseSchema,
} from "../../database/database.js";
import { CLOCK, type Clock } from "./clock.js";
import { isOpaqueRef } from "./identity-linking-validation.js";

const MAX_LINK_LIFETIME_MILLISECONDS = 10 * 60 * 1000;

export interface BeginLink {
  readonly accountRef: string;
  readonly expiresAt: Date;
  readonly returnCorrelation: string;
  readonly tokenDigest: string;
}

export interface LinkChallenge {
  readonly expiresAt: Date;
  readonly linkTransactionRef: string;
  readonly returnCorrelation: string;
  readonly status: "pending";
}

export interface TokenReceipt {
  readonly botIdentity: string;
  readonly linkToken:
    | { readonly digest: string; readonly kind: "digest" }
    | { readonly kind: "malformed" };
  readonly observedAt: Date;
  readonly telegramUserId: string;
}

export type PendingLinkOutcome = {
  readonly status:
    "conflict" | "expired" | "malformed" | "pending" | "replayed";
};

export interface AuthenticatedConfirmation {
  readonly accountRef: string;
  readonly linkTransactionRef: string;
  readonly returnCorrelation: string;
}

export type LinkOutcome =
  | {
      readonly linkTransactionRef: string;
      readonly returnCorrelation: string;
      readonly status: "expired" | "pending" | "recovery-required";
    }
  | {
      readonly linkTransactionRef: string;
      readonly returnCorrelation: string;
      readonly status: "idempotent" | "linked";
      readonly telegramIdentityRef: string;
    }
  | { readonly status: "malformed" };

export class MalformedLinkRequestError extends Error {}

@Injectable()
export class IdentityLinking {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async register(begin: BeginLink): Promise<LinkChallenge> {
    assertBeginLink(begin, this.clock.now());

    return this.database.transaction().execute(async (transaction) => {
      const linkTransactionRef = randomUUID();
      const inserted = await transaction
        .insertInto("link_transactions")
        .values({
          account_ref: begin.accountRef,
          bot_identity: null,
          candidate_telegram_user_id: null,
          confirmed_at: null,
          expires_at: begin.expiresAt,
          link_transaction_ref: linkTransactionRef,
          received_at: null,
          registered_at: this.clock.now(),
          return_correlation: begin.returnCorrelation,
          state: "registered",
          token_digest: begin.tokenDigest,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning("link_transaction_ref")
        .executeTakeFirst();

      if (!inserted) {
        const existing = await transaction
          .selectFrom("link_transactions")
          .selectAll()
          .where("token_digest", "=", begin.tokenDigest)
          .executeTakeFirst();
        if (
          !existing ||
          existing.account_ref !== begin.accountRef ||
          existing.token_digest !== begin.tokenDigest ||
          existing.return_correlation !== begin.returnCorrelation ||
          existing.expires_at.getTime() !== begin.expiresAt.getTime()
        ) {
          throw new MalformedLinkRequestError();
        }
        return challenge(existing);
      }

      await addEvent(
        transaction,
        linkTransactionRef,
        "registered",
        this.clock.now(),
      );
      return {
        expiresAt: begin.expiresAt,
        linkTransactionRef,
        returnCorrelation: begin.returnCorrelation,
        status: "pending",
      };
    });
  }

  async acceptStart(receipt: TokenReceipt): Promise<PendingLinkOutcome> {
    if (
      receipt.linkToken.kind === "malformed" ||
      !/^[A-Za-z0-9_-]{43}$/.test(receipt.linkToken.digest) ||
      !isInternalIdentity(receipt.botIdentity) ||
      !isTelegramId(receipt.telegramUserId)
    ) {
      return { status: "malformed" };
    }
    const tokenDigest = receipt.linkToken.digest;

    return this.database.transaction().execute(async (transaction) => {
      const linkTransaction = await transaction
        .selectFrom("link_transactions")
        .selectAll()
        .where("token_digest", "=", tokenDigest)
        .forUpdate()
        .executeTakeFirst();
      if (!linkTransaction) {
        return { status: "malformed" };
      }
      if (linkTransaction.state !== "registered") {
        await addEvent(
          transaction,
          linkTransaction.link_transaction_ref,
          "receipt_replayed",
          receipt.observedAt,
        );
        return { status: "replayed" };
      }
      if (
        linkTransaction.expires_at.getTime() <= receipt.observedAt.getTime()
      ) {
        await addEvent(
          transaction,
          linkTransaction.link_transaction_ref,
          "receipt_expired",
          receipt.observedAt,
        );
        return { status: "expired" };
      }

      const identityLink = await transaction
        .selectFrom("platform_links")
        .select(["account_ref", "telegram_user_id"])
        .where("bot_identity", "=", receipt.botIdentity)
        .where("telegram_user_id", "=", receipt.telegramUserId)
        .executeTakeFirst();
      const conflict =
        identityLink !== undefined &&
        identityLink.account_ref !== linkTransaction.account_ref;

      await transaction
        .updateTable("link_transactions")
        .set({
          bot_identity: receipt.botIdentity,
          candidate_telegram_user_id: receipt.telegramUserId,
          received_at: receipt.observedAt,
          state: conflict ? "conflict" : "received",
        })
        .where(
          "link_transaction_ref",
          "=",
          linkTransaction.link_transaction_ref,
        )
        .execute();
      await addEvent(
        transaction,
        linkTransaction.link_transaction_ref,
        conflict ? "receipt_conflict" : "receipt_accepted",
        receipt.observedAt,
      );
      return { status: conflict ? "conflict" : "pending" };
    });
  }

  async confirm(confirmation: AuthenticatedConfirmation): Promise<LinkOutcome> {
    if (
      !isOpaqueRef(confirmation.accountRef) ||
      !isOpaqueRef(confirmation.linkTransactionRef) ||
      !isOpaqueRef(confirmation.returnCorrelation)
    ) {
      return { status: "malformed" };
    }

    return this.database.transaction().execute(async (transaction) => {
      const linkTransaction = await transaction
        .selectFrom("link_transactions")
        .selectAll()
        .where("link_transaction_ref", "=", confirmation.linkTransactionRef)
        .where("account_ref", "=", confirmation.accountRef)
        .where("return_correlation", "=", confirmation.returnCorrelation)
        .forUpdate()
        .executeTakeFirst();
      if (!linkTransaction) {
        return { status: "malformed" };
      }

      const base = {
        linkTransactionRef: linkTransaction.link_transaction_ref,
        returnCorrelation: linkTransaction.return_correlation,
      };
      if (linkTransaction.state === "linked") {
        if (
          !linkTransaction.bot_identity ||
          !linkTransaction.candidate_telegram_user_id
        ) {
          throw new Error("Linked transaction has no Telegram candidate");
        }
        const link = await matchingLink(
          transaction,
          linkTransaction.account_ref,
          linkTransaction.bot_identity,
          linkTransaction.candidate_telegram_user_id,
        );
        if (!link) {
          throw new Error("Linked transaction has no PlatformLink");
        }
        await addEvent(
          transaction,
          linkTransaction.link_transaction_ref,
          "confirmation_idempotent",
          this.clock.now(),
        );
        return {
          ...base,
          status: "idempotent",
          telegramIdentityRef: link.telegram_identity_ref,
        };
      }
      if (linkTransaction.state === "conflict") {
        await addEvent(
          transaction,
          linkTransaction.link_transaction_ref,
          "recovery_required",
          this.clock.now(),
        );
        return { ...base, status: "recovery-required" };
      }
      if (linkTransaction.expires_at.getTime() <= this.clock.now().getTime()) {
        await addEvent(
          transaction,
          linkTransaction.link_transaction_ref,
          "confirmation_expired",
          this.clock.now(),
        );
        return { ...base, status: "expired" };
      }
      if (linkTransaction.state === "registered") {
        return { ...base, status: "pending" };
      }
      if (
        !linkTransaction.bot_identity ||
        !linkTransaction.candidate_telegram_user_id
      ) {
        throw new Error("Received transaction has no Telegram candidate");
      }

      const telegramIdentityRef = randomUUID();
      const inserted = await transaction
        .insertInto("platform_links")
        .values({
          account_ref: linkTransaction.account_ref,
          bot_identity: linkTransaction.bot_identity,
          link_transaction_ref: linkTransaction.link_transaction_ref,
          linked_at: this.clock.now(),
          telegram_identity_ref: telegramIdentityRef,
          telegram_user_id: linkTransaction.candidate_telegram_user_id,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning("telegram_identity_ref")
        .executeTakeFirst();

      const link =
        inserted ??
        (await matchingLink(
          transaction,
          linkTransaction.account_ref,
          linkTransaction.bot_identity,
          linkTransaction.candidate_telegram_user_id,
        ));
      if (!link) {
        await transaction
          .updateTable("link_transactions")
          .set({ state: "conflict" })
          .where(
            "link_transaction_ref",
            "=",
            linkTransaction.link_transaction_ref,
          )
          .execute();
        await addEvent(
          transaction,
          linkTransaction.link_transaction_ref,
          "recovery_required",
          this.clock.now(),
        );
        return { ...base, status: "recovery-required" };
      }

      await transaction
        .updateTable("link_transactions")
        .set({ confirmed_at: this.clock.now(), state: "linked" })
        .where(
          "link_transaction_ref",
          "=",
          linkTransaction.link_transaction_ref,
        )
        .execute();
      await addEvent(
        transaction,
        linkTransaction.link_transaction_ref,
        inserted ? "confirmed" : "confirmation_idempotent",
        this.clock.now(),
      );
      return {
        ...base,
        status: inserted ? "linked" : "idempotent",
        telegramIdentityRef: link.telegram_identity_ref,
      };
    });
  }
}

function assertBeginLink(begin: BeginLink, now: Date): void {
  const lifetime = begin.expiresAt.getTime() - now.getTime();
  if (
    !isOpaqueRef(begin.accountRef) ||
    !isOpaqueRef(begin.returnCorrelation) ||
    !/^[A-Za-z0-9_-]{43}$/.test(begin.tokenDigest) ||
    !Number.isFinite(begin.expiresAt.getTime()) ||
    lifetime <= 0 ||
    lifetime > MAX_LINK_LIFETIME_MILLISECONDS
  ) {
    throw new MalformedLinkRequestError();
  }
}

function challenge(storedLinkTransaction: {
  expires_at: Date;
  link_transaction_ref: string;
  return_correlation: string;
}): LinkChallenge {
  return {
    expiresAt: storedLinkTransaction.expires_at,
    linkTransactionRef: storedLinkTransaction.link_transaction_ref,
    returnCorrelation: storedLinkTransaction.return_correlation,
    status: "pending",
  };
}

async function addEvent(
  transaction: Transaction<DatabaseSchema>,
  linkTransactionRef: string,
  eventType: DatabaseSchema["identity_link_events"]["event_type"],
  occurredAt: Date,
): Promise<void> {
  await transaction
    .insertInto("identity_link_events")
    .values({
      event_type: eventType,
      link_transaction_ref: linkTransactionRef,
      occurred_at: occurredAt,
    })
    .execute();
}

async function matchingLink(
  transaction: Transaction<DatabaseSchema>,
  accountRef: string,
  botIdentity: string,
  telegramUserId: string,
) {
  return transaction
    .selectFrom("platform_links")
    .select("telegram_identity_ref")
    .where("account_ref", "=", accountRef)
    .where("bot_identity", "=", botIdentity)
    .where("telegram_user_id", "=", telegramUserId)
    .executeTakeFirst();
}

function isInternalIdentity(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

function isTelegramId(value: string): boolean {
  return /^[1-9][0-9]{0,15}$/.test(value);
}
