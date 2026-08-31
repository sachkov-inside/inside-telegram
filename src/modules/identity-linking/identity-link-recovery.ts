import { Inject, Injectable } from "@nestjs/common";
import type { Selectable, Transaction } from "kysely";

import {
  DATABASE,
  type Database,
  type DatabaseSchema,
  type IdentityLinkRecoveriesTable,
} from "../../database/database.js";
import { CLOCK, type Clock } from "./clock.js";
import { isOpaqueRef } from "./identity-linking-validation.js";

export interface IdentityLinkRecoveryCommand {
  readonly confirmedSourceAccountRef: string;
  readonly confirmedTargetAccountRef: string;
  readonly operatorRef: string;
  readonly reasonRef: string;
  readonly recoveryRef: string;
  readonly sourceAccountRef: string;
  readonly targetAccountRef: string;
  readonly targetLinkTransactionRef: string;
  readonly telegramIdentityRef: string;
}

export interface IdentityLinkTransferFacts {
  readonly botIdentity: string;
  readonly sourceAccountRef: string;
  readonly sourceLinkTransactionRef: string;
  readonly targetAccountRef: string;
  readonly targetLinkTransactionRef: string;
  readonly telegramIdentityRef: string;
  readonly telegramUserId: string;
}

export type IdentityLinkRecoveryResult =
  | {
      readonly ok: false;
      readonly reason:
        | "confirmation_mismatch"
        | "invalid_command"
        | "recovery_ref_conflict"
        | "source_mismatch"
        | "target_account_already_linked"
        | "target_not_recoverable";
    }
  | {
      readonly ok: true;
      readonly outcome: "idempotent" | "ready" | "transferred";
      readonly transfer: IdentityLinkTransferFacts;
    };

@Injectable()
export class IdentityLinkRecovery {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async preview(
    command: IdentityLinkRecoveryCommand,
  ): Promise<IdentityLinkRecoveryResult> {
    const invalid = validateCommand(command);
    if (invalid) {
      return invalid;
    }
    return this.database.transaction().execute(async (transaction) => {
      const existing = await existingRecovery(transaction, command);
      if (existing) {
        return existing;
      }
      return readyTransfer(transaction, command, false);
    });
  }

  async execute(
    command: IdentityLinkRecoveryCommand,
  ): Promise<IdentityLinkRecoveryResult> {
    const invalid = validateCommand(command);
    if (invalid) {
      return invalid;
    }
    return this.database.transaction().execute(async (transaction) => {
      const existing = await existingRecovery(transaction, command);
      if (existing) {
        return existing;
      }
      const ready = await readyTransfer(transaction, command, true);
      if (!ready.ok) {
        return ready;
      }

      const targetLinkedAt = this.clock.now();
      const sourceLink = await transaction
        .selectFrom("platform_links")
        .select("linked_at")
        .where("telegram_identity_ref", "=", ready.transfer.telegramIdentityRef)
        .where("account_ref", "=", ready.transfer.sourceAccountRef)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("platform_links")
        .set({
          account_ref: ready.transfer.targetAccountRef,
          link_transaction_ref: ready.transfer.targetLinkTransactionRef,
          linked_at: targetLinkedAt,
        })
        .where("telegram_identity_ref", "=", ready.transfer.telegramIdentityRef)
        .where("account_ref", "=", ready.transfer.sourceAccountRef)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("link_transactions")
        .set({ confirmed_at: targetLinkedAt, state: "linked" })
        .where(
          "link_transaction_ref",
          "=",
          ready.transfer.targetLinkTransactionRef,
        )
        .where("state", "=", "conflict")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("membership_checks")
        .values({
          attempt_count: 0,
          available_at: targetLinkedAt,
          completed_at: null,
          created_at: targetLinkedAt,
          diagnostic_code: null,
          locked_at: null,
          source_ref: `owner-recovery:${command.recoveryRef}`,
          state: "pending",
          telegram_identity_ref: ready.transfer.telegramIdentityRef,
        })
        .onConflict((conflict) => conflict.column("source_ref").doNothing())
        .execute();
      await transaction
        .insertInto("identity_link_recoveries")
        .values({
          bot_identity: ready.transfer.botIdentity,
          operator_ref: command.operatorRef,
          reason_ref: command.reasonRef,
          recovery_ref: command.recoveryRef,
          source_account_ref: ready.transfer.sourceAccountRef,
          source_link_transaction_ref: ready.transfer.sourceLinkTransactionRef,
          source_linked_at: sourceLink.linked_at,
          target_account_ref: ready.transfer.targetAccountRef,
          target_link_transaction_ref: ready.transfer.targetLinkTransactionRef,
          target_linked_at: targetLinkedAt,
          telegram_identity_ref: ready.transfer.telegramIdentityRef,
          telegram_user_id: ready.transfer.telegramUserId,
        })
        .execute();

      return { ...ready, outcome: "transferred" };
    });
  }
}

function validateCommand(command: IdentityLinkRecoveryCommand):
  | {
      readonly ok: false;
      readonly reason: "confirmation_mismatch" | "invalid_command";
    }
  | undefined {
  if (
    !isAuditRef(command.recoveryRef, 128) ||
    !isAuditRef(command.operatorRef, 128) ||
    !isAuditRef(command.reasonRef, 256) ||
    !isOpaqueRef(command.telegramIdentityRef) ||
    !isOpaqueRef(command.sourceAccountRef) ||
    !isOpaqueRef(command.targetAccountRef) ||
    !isOpaqueRef(command.targetLinkTransactionRef) ||
    command.sourceAccountRef === command.targetAccountRef
  ) {
    return { ok: false, reason: "invalid_command" };
  }
  if (
    command.confirmedSourceAccountRef !== command.sourceAccountRef ||
    command.confirmedTargetAccountRef !== command.targetAccountRef
  ) {
    return { ok: false, reason: "confirmation_mismatch" };
  }
  return undefined;
}

async function existingRecovery(
  transaction: Transaction<DatabaseSchema>,
  command: IdentityLinkRecoveryCommand,
): Promise<IdentityLinkRecoveryResult | undefined> {
  const audit = await transaction
    .selectFrom("identity_link_recoveries")
    .selectAll()
    .where("recovery_ref", "=", command.recoveryRef)
    .executeTakeFirst();
  if (!audit) {
    return undefined;
  }
  if (
    audit.operator_ref !== command.operatorRef ||
    audit.reason_ref !== command.reasonRef ||
    audit.telegram_identity_ref !== command.telegramIdentityRef ||
    audit.source_account_ref !== command.sourceAccountRef ||
    audit.target_account_ref !== command.targetAccountRef ||
    audit.target_link_transaction_ref !== command.targetLinkTransactionRef
  ) {
    return { ok: false, reason: "recovery_ref_conflict" };
  }
  return {
    ok: true,
    outcome: "idempotent",
    transfer: factsFromAudit(audit),
  };
}

async function readyTransfer(
  transaction: Transaction<DatabaseSchema>,
  command: IdentityLinkRecoveryCommand,
  lock: boolean,
): Promise<IdentityLinkRecoveryResult> {
  let sourceQuery = transaction
    .selectFrom("platform_links")
    .selectAll()
    .where("telegram_identity_ref", "=", command.telegramIdentityRef);
  if (lock) {
    sourceQuery = sourceQuery.forUpdate();
  }
  const source = await sourceQuery.executeTakeFirst();
  if (!source || source.account_ref !== command.sourceAccountRef) {
    return { ok: false, reason: "source_mismatch" };
  }

  let targetQuery = transaction
    .selectFrom("link_transactions")
    .selectAll()
    .where("link_transaction_ref", "=", command.targetLinkTransactionRef);
  if (lock) {
    targetQuery = targetQuery.forUpdate();
  }
  const target = await targetQuery.executeTakeFirst();
  if (
    !target ||
    target.account_ref !== command.targetAccountRef ||
    target.state !== "conflict" ||
    target.bot_identity !== source.bot_identity ||
    target.candidate_telegram_user_id !== source.telegram_user_id
  ) {
    return { ok: false, reason: "target_not_recoverable" };
  }
  const targetLink = await transaction
    .selectFrom("platform_links")
    .select("telegram_identity_ref")
    .where("account_ref", "=", command.targetAccountRef)
    .executeTakeFirst();
  if (targetLink) {
    return { ok: false, reason: "target_account_already_linked" };
  }

  return {
    ok: true,
    outcome: "ready",
    transfer: {
      botIdentity: source.bot_identity,
      sourceAccountRef: source.account_ref,
      sourceLinkTransactionRef: source.link_transaction_ref,
      targetAccountRef: target.account_ref,
      targetLinkTransactionRef: target.link_transaction_ref,
      telegramIdentityRef: source.telegram_identity_ref,
      telegramUserId: source.telegram_user_id,
    },
  };
}

function factsFromAudit(
  audit: Selectable<IdentityLinkRecoveriesTable>,
): IdentityLinkTransferFacts {
  return {
    botIdentity: audit.bot_identity,
    sourceAccountRef: audit.source_account_ref,
    sourceLinkTransactionRef: audit.source_link_transaction_ref,
    targetAccountRef: audit.target_account_ref,
    targetLinkTransactionRef: audit.target_link_transaction_ref,
    telegramIdentityRef: audit.telegram_identity_ref,
    telegramUserId: audit.telegram_user_id,
  };
}

function isAuditRef(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9._:/-]+$/u.test(value)
  );
}
