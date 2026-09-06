import { Inject, Injectable } from "@nestjs/common";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { DATABASE, type Database } from "../../database/database.js";
import { CLOCK, type Clock } from "../identity-linking/clock.js";
import { IdentityLinking } from "../identity-linking/identity-linking.js";
import { isRequestRef } from "./bot-sign-in.js";

/** Finalizes an already consumed proof for the Account selected by the trusted Platform. */
@Injectable()
export class SignInAccountLink {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IdentityLinking) private readonly linking: IdentityLinking,
  ) {}

  async bind(requestRef: string, subjectRef: string, accountRef: string) {
    if (!this.config.signInEnabled) return { status: "disabled" } as const;
    if (![requestRef, subjectRef, accountRef].every(isRequestRef))
      return { status: "unavailable" } as const;
    const accepted = await this.database
      .transaction()
      .execute(async (transaction) => {
        const request = await transaction
          .selectFrom("sign_in_requests")
          .selectAll()
          .where("request_ref", "=", requestRef)
          .where("bot_identity", "=", this.config.botIdentity)
          .forUpdate()
          .executeTakeFirst();
        if (
          !request ||
          request.state !== "consumed" ||
          !request.telegram_user_id
        )
          return false;
        const subject = await transaction
          .selectFrom("sign_in_subjects")
          .select("subject_ref")
          .where("bot_identity", "=", request.bot_identity)
          .where("telegram_user_id", "=", request.telegram_user_id)
          .executeTakeFirst();
        if (subject?.subject_ref !== subjectRef) return false;
        const previous = await transaction
          .selectFrom("link_transactions")
          .selectAll()
          .where("link_transaction_ref", "=", requestRef)
          .executeTakeFirst();
        if (previous) return previous.account_ref === accountRef;
        const now = this.clock.now();
        if (request.expires_at <= now) return false;
        await transaction
          .insertInto("link_transactions")
          .values({
            link_transaction_ref: requestRef,
            account_ref: accountRef,
            token_digest: request.start_token_digest,
            return_correlation: requestRef,
            expires_at: request.expires_at,
            state: "received",
            bot_identity: request.bot_identity,
            candidate_telegram_user_id: request.telegram_user_id,
            registered_at: now,
            received_at: now,
            confirmed_at: null,
          })
          .execute();
        return true;
      });
    if (!accepted) return { status: "unavailable" } as const;
    const result = await this.linking.confirm({
      accountRef,
      linkTransactionRef: requestRef,
      returnCorrelation: requestRef,
    });
    return result.status === "linked" || result.status === "idempotent"
      ? ({
          status: "linked",
          telegramIdentityRef: result.telegramIdentityRef,
        } as const)
      : ({ status: "conflict" } as const);
  }
}
