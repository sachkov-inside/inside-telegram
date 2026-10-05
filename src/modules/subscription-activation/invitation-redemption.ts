import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Selectable } from "kysely";
import { DATABASE, type Database } from "../../database/database.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { CLOCK, type Clock } from "../../shared/clock.js";
import { reserveTelegramIdentity } from "../identity-linking/stable-telegram-identity.js";
import type { VerifiedPrivateStart } from "../../shared/telegram-contact.js";
import { StartResponseDeliveryQueue } from "../outbound/start-response-delivery-queue.js";
import { reportFailure } from "../../shared/failure-diagnostics.js";
import {
  ACTIVATION_PLATFORM,
  type ActivationPlatform,
} from "./activation-ports.js";
import { ACTIVATION_VERSION } from "./activation-contract.js";
import type { ActivationTables } from "./activation-storage.js";
import {
  INVITATION_DELAYED,
  INVITATION_MALFORMED,
  INVITATION_UNAVAILABLE,
  invitationAnswer,
  invitationNeedsAccount,
  type InvitationAnswer,
} from "./invitation-view.js";

type Redemption = Selectable<ActivationTables["invitation_redemptions"]>;
/** Platform keeps a claimed invitation 30 days for an Account; the bot waits as long. */
const RETENTION = 30 * 24 * 60 * 60_000;
const CADENCE = 60_000;
/** Failed calls wait twice as long each time, up to an hour; `attempts` counts earlier calls. */
const MAX_RETRY_DELAY = 60 * 60_000;

/**
 * Continues an invitation link `i_<code>` until Platform answers it. Platform owns the claim,
 * the redemption and every grant; a repeat sends the same `(code, identityRef)` request, which
 * Platform answers without a second redemption.
 */
@Injectable()
export class InvitationRedemption {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ACTIVATION_PLATFORM) private readonly platform: ActivationPlatform,
    @Inject(StartResponseDeliveryQueue)
    private readonly replies: StartResponseDeliveryQueue,
  ) {}

  /** `code` is `null` when the payload is malformed. Opening the link again starts over. */
  async start(
    contact: VerifiedPrivateStart,
    code: string | null,
  ): Promise<void> {
    if (!this.config.activation?.enabled || code === null) {
      await this.replies.enqueue({
        botIdentity: contact.botIdentity,
        telegramUserId: contact.telegramUserId,
        privateChatId: contact.privateChatId,
        triggerUpdateId: contact.updateId,
        now: this.clock.now(),
        sourceKey: `invitation:${contact.botIdentity}:${contact.updateId}`,
        messageText:
          code === null
            ? INVITATION_MALFORMED.text
            : INVITATION_UNAVAILABLE.text,
      });
      return;
    }
    const now = this.clock.now();
    await this.db.transaction().execute(async (tx) => {
      const identity = await reserveTelegramIdentity(
        tx,
        contact.botIdentity,
        contact.telegramUserId,
      );
      const opened = {
        private_chat_id: contact.privateChatId,
        trigger_update_id: contact.updateId,
        state: "pending" as const,
        expires_at: new Date(now.getTime() + RETENTION),
        due_at: now,
        // A worker holding the earlier opening loses its lease and leaves this one to answer;
        // Platform answers the repeated request without a second redemption.
        lease_token: null,
        lease_until: null,
        attempts: 0,
        diagnostic_code: null,
      };
      await tx
        .insertInto("invitation_redemptions")
        .values({
          ...opened,
          redemption_id: randomUUID(),
          bot_identity: contact.botIdentity,
          telegram_user_id: contact.telegramUserId,
          identity_ref: identity,
          code,
          created_at: now,
        })
        .onConflict((c) =>
          c
            .columns(["bot_identity", "telegram_user_id", "code"])
            .doUpdateSet(opened),
        )
        .execute();
    });
  }

  /** The person says the Account is linked: waiting redemptions run now. */
  async retry(contact: VerifiedPrivateStart): Promise<void> {
    if (!this.config.activation?.enabled) return;
    const now = this.clock.now();
    await this.db
      .updateTable("invitation_redemptions")
      .set({ due_at: now })
      .where("bot_identity", "=", contact.botIdentity)
      .where("telegram_user_id", "=", contact.telegramUserId)
      .where("state", "in", ["needs_account", "retry"])
      .where((eb) =>
        eb.or([eb("lease_until", "is", null), eb("lease_until", "<=", now)]),
      )
      .execute();
  }

  async processAvailable(limit = 10): Promise<number> {
    if (!this.config.activation?.enabled) return 0;
    let processed = 0;
    for (; processed < limit; processed++) {
      const now = this.clock.now();
      const redemption = await this.db.transaction().execute(async (tx) => {
        const row = await tx
          .selectFrom("invitation_redemptions")
          .selectAll()
          .where("bot_identity", "=", this.config.botIdentity)
          .where("state", "in", ["pending", "needs_account", "retry"])
          .where("due_at", "<=", now)
          .where("expires_at", ">", now)
          .where((eb) =>
            eb.or([
              eb("lease_until", "is", null),
              eb("lease_until", "<=", now),
            ]),
          )
          .orderBy("due_at")
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!row) return;
        const lease = randomUUID();
        await tx
          .updateTable("invitation_redemptions")
          .set({
            lease_token: lease,
            lease_until: new Date(now.getTime() + CADENCE),
            attempts: row.attempts + 1,
          })
          .where("redemption_id", "=", row.redemption_id)
          .execute();
        return { ...row, lease_token: lease };
      });
      if (!redemption) break;
      try {
        await this.process(redemption);
      } catch (error) {
        reportFailure("invitation.process", error, {
          attempt_id: redemption.redemption_id,
        });
        await this.settle(redemption, "retry", "worker_unavailable");
      }
    }
    const now = this.clock.now();
    await this.db
      .deleteFrom("invitation_redemptions")
      .where("bot_identity", "=", this.config.botIdentity)
      .where("expires_at", "<=", now)
      .where((eb) =>
        eb.or([eb("lease_until", "is", null), eb("lease_until", "<=", now)]),
      )
      .execute();
    return processed;
  }

  private async process(redemption: Redemption): Promise<void> {
    const response = await this.platform.redeem({
      contractVersion: ACTIVATION_VERSION,
      code: redemption.code,
      identityRef: redemption.identity_ref,
    });
    if (!response || (!response.ok && response.error.code === "unavailable")) {
      await this.settle(
        redemption,
        "retry",
        response ? "unavailable" : "platform_unavailable",
        INVITATION_DELAYED,
      );
      return;
    }
    if (response.ok && response.value.state === "needs_account") {
      const accountUrl = this.config.activation?.accountUrl;
      await this.settle(
        redemption,
        "needs_account",
        "needs_account",
        accountUrl ? invitationNeedsAccount(accountUrl) : undefined,
      );
      return;
    }
    await this.settle(
      redemption,
      "completed",
      response.ok ? null : response.error.code,
      invitationAnswer(response, this.clock.now()),
    );
  }

  /**
   * Stores the next state and its reply together; a lost lease leaves both to the newer run.
   * A final answer deletes the row: the reply's source key already prevents a second reply.
   */
  private async settle(
    redemption: Redemption,
    state: "retry" | "needs_account" | "completed",
    diagnosticCode: string | null,
    answer?: InvitationAnswer,
  ): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction().execute(async (tx) => {
      const stored =
        state === "completed"
          ? await tx
              .deleteFrom("invitation_redemptions")
              .where("redemption_id", "=", redemption.redemption_id)
              .where("lease_token", "=", redemption.lease_token)
              .returning("redemption_id")
              .executeTakeFirst()
          : await tx
              .updateTable("invitation_redemptions")
              .set({
                state,
                diagnostic_code: diagnosticCode,
                lease_token: null,
                lease_until: null,
                // Waiting for an Account is no failure: it keeps the short cadence.
                ...(state === "needs_account" ? { attempts: 0 } : {}),
                due_at: new Date(
                  now.getTime() +
                    (state === "retry"
                      ? Math.min(
                          CADENCE * 2 ** redemption.attempts,
                          MAX_RETRY_DELAY,
                        )
                      : CADENCE),
                ),
              })
              .where("redemption_id", "=", redemption.redemption_id)
              .where("lease_token", "=", redemption.lease_token)
              .returning("redemption_id")
              .executeTakeFirst();
      if (!stored || !answer) return;
      // One reply per opening of the link and outcome: waiting cycles do not repeat it.
      await this.replies.enqueue(
        {
          botIdentity: redemption.bot_identity,
          telegramUserId: redemption.telegram_user_id,
          privateChatId: redemption.private_chat_id,
          triggerUpdateId: redemption.trigger_update_id,
          now,
          sourceKey: `invitation:${createHash("sha256")
            .update(
              JSON.stringify([
                redemption.identity_ref,
                redemption.code,
                redemption.trigger_update_id,
              ]),
            )
            .digest("hex")}:${answer.outcome}`,
          messageText: answer.text,
          ...(answer.buttons ? { buttons: answer.buttons } : {}),
        },
        tx,
      );
    });
  }
}
