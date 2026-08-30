import { Inject, Injectable } from "@nestjs/common";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import {
  DATABASE,
  type Contactability,
  type Database,
} from "../../database/database.js";

export interface VerifiedPrivateStart {
  readonly botIdentity: string;
  readonly observedAt: Date;
  readonly privateChatId: string;
  readonly telegramUserId: string;
  readonly updateId: string;
}

export interface VerifiedPrivateContactability {
  readonly botIdentity: string;
  readonly contactability: Contactability;
  readonly observedAt: Date;
  readonly telegramUserId: string;
  readonly updateId: string;
}

export interface ContactOutcome {
  readonly contact: "created" | "reactivated" | "refreshed";
  readonly responsePlanned: boolean;
}

export type StartResponseKind = "link-receipt" | "welcome";

@Injectable()
export class BotContacts {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG)
    private readonly config: ApplicationConfig,
  ) {}

  async observeStart(
    start: VerifiedPrivateStart,
    responseKind: StartResponseKind = "welcome",
  ): Promise<ContactOutcome> {
    return this.database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("bot_contacts")
        .select("contactability")
        .where("bot_identity", "=", start.botIdentity)
        .where("telegram_user_id", "=", start.telegramUserId)
        .forUpdate()
        .executeTakeFirst();

      let contact: ContactOutcome["contact"];
      if (!existing) {
        await transaction
          .insertInto("bot_contacts")
          .values({
            bot_identity: start.botIdentity,
            contactability: "reachable",
            first_started_at: start.observedAt,
            last_started_at: start.observedAt,
            private_chat_id: start.privateChatId,
            telegram_user_id: start.telegramUserId,
            updated_at: start.observedAt,
          })
          .execute();
        contact = "created";
      } else {
        await transaction
          .updateTable("bot_contacts")
          .set({
            contactability: "reachable",
            last_started_at: start.observedAt,
            private_chat_id: start.privateChatId,
            updated_at: start.observedAt,
          })
          .where("bot_identity", "=", start.botIdentity)
          .where("telegram_user_id", "=", start.telegramUserId)
          .execute();
        contact =
          existing.contactability === "blocked" ? "reactivated" : "refreshed";
      }

      await transaction
        .insertInto("bot_contact_events")
        .values({
          bot_identity: start.botIdentity,
          contactability: "reachable",
          event_type: "start_observed",
          observed_at: start.observedAt,
          telegram_user_id: start.telegramUserId,
          update_id: start.updateId,
        })
        .onConflict((conflict) => conflict.doNothing())
        .execute();

      const responseDelivery = await transaction
        .insertInto("start_response_deliveries")
        .values({
          attempt_count: 0,
          available_at: start.observedAt,
          bot_identity: start.botIdentity,
          created_at: start.observedAt,
          delivered_at: null,
          diagnostic_code: null,
          locked_at: null,
          message_text:
            responseKind === "link-receipt"
              ? this.config.linkReceiptText
              : this.config.welcomeText,
          private_chat_id: start.privateChatId,
          source_key: `telegram-update:${start.botIdentity}:${start.updateId}`,
          state: "pending",
          telegram_user_id: start.telegramUserId,
          trigger_update_id: start.updateId,
          updated_at: start.observedAt,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning("id")
        .executeTakeFirst();

      return {
        contact,
        responsePlanned: responseDelivery !== undefined,
      };
    });
  }

  async observeContactability(
    observation: VerifiedPrivateContactability,
  ): Promise<boolean> {
    return this.database.transaction().execute(async (transaction) => {
      const contact = await transaction
        .updateTable("bot_contacts")
        .set({
          contactability: observation.contactability,
          updated_at: observation.observedAt,
        })
        .where("bot_identity", "=", observation.botIdentity)
        .where("telegram_user_id", "=", observation.telegramUserId)
        .returning("telegram_user_id")
        .executeTakeFirst();

      if (!contact) {
        return false;
      }

      await transaction
        .insertInto("bot_contact_events")
        .values({
          bot_identity: observation.botIdentity,
          contactability: observation.contactability,
          event_type: "contactability_observed",
          observed_at: observation.observedAt,
          telegram_user_id: observation.telegramUserId,
          update_id: observation.updateId,
        })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
      return true;
    });
  }
}
