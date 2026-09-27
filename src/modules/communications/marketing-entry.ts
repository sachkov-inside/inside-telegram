import { enqueueReply } from "../outbound/start-response-delivery-queue.js";
import { cancelDelivery } from "./funnel-timeline.js";
import { updateMarketingAvailability } from "./marketing-preferences.js";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { DATABASE, type Database } from "../../database/database.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { CLOCK, type Clock } from "../../shared/clock.js";
import type { VerifiedPrivateStart } from "../../shared/telegram-contact.js";
import { contactLock, planDelivery } from "./communication-state.js";

@Injectable()
export class MarketingEntry {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  enabled(): boolean {
    return this.config.marketingEnabled;
  }
  async setPreference(
    start: VerifiedPrivateStart,
    enabled: boolean,
  ): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      await contactLock(tx, this.config.botIdentity, start.telegramUserId);
      const prior = await tx
        .selectFrom("communication_preferences")
        .select("update_id")
        .where("bot_identity", "=", start.botIdentity)
        .where("update_id", "=", start.updateId)
        .executeTakeFirst();
      if (prior) return;
      await tx
        .insertInto("communication_contacts")
        .values({
          contact_id: randomUUID(),
          bot_identity: start.botIdentity,
          telegram_user_id: start.telegramUserId,
          marketing_enabled: true,
        })
        .onConflict((c) =>
          c.columns(["bot_identity", "telegram_user_id"]).doNothing(),
        )
        .execute();
      const contact = await tx
        .selectFrom("communication_contacts")
        .selectAll()
        .where("bot_identity", "=", start.botIdentity)
        .where("telegram_user_id", "=", start.telegramUserId)
        .executeTakeFirstOrThrow();
      const now = this.clock.now();
      await updateMarketingAvailability(
        tx,
        start.botIdentity,
        start.telegramUserId,
        now,
        true,
        enabled,
      );
      await tx
        .insertInto("communication_preferences")
        .values({
          bot_identity: start.botIdentity,
          update_id: start.updateId,
          contact_id: contact.contact_id,
          enabled,
          observed_at: now,
        })
        .execute();
      await enqueueReply(tx, {
        botIdentity: start.botIdentity,
        telegramUserId: start.telegramUserId,
        privateChatId: start.privateChatId,
        messageText: enabled
          ? "Сообщения включены. Пропущенные сообщения не придут."
          : "Сообщения выключены. Чтобы включить их снова, отправьте /resume.",
        sourceKey: `marketing-preference:${start.botIdentity}:${start.updateId}`,
        triggerUpdateId: start.updateId,
        now,
      });
    });
  }
  async enter(start: VerifiedPrivateStart, source?: string): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      await contactLock(tx, this.config.botIdentity, start.telegramUserId);
      const receipt = await tx
        .selectFrom("communication_entries")
        .select("outcome")
        .where("bot_identity", "=", start.botIdentity)
        .where("update_id", "=", start.updateId)
        .executeTakeFirst();
      if (receipt) return;
      await tx
        .insertInto("communication_contacts")
        .values({
          contact_id: randomUUID(),
          bot_identity: start.botIdentity,
          telegram_user_id: start.telegramUserId,
          marketing_enabled: true,
        })
        .onConflict((c) =>
          c.columns(["bot_identity", "telegram_user_id"]).doNothing(),
        )
        .execute();
      const contact = await tx
        .selectFrom("communication_contacts")
        .selectAll()
        .where("bot_identity", "=", start.botIdentity)
        .where("telegram_user_id", "=", start.telegramUserId)
        .executeTakeFirstOrThrow();
      const sourceRow = source
        ? await tx
            .selectFrom("communication_sources")
            .selectAll()
            .where("bot_identity", "=", start.botIdentity)
            .where("code", "=", source)
            .executeTakeFirst()
        : undefined;
      let query = tx
        .selectFrom("communication_funnels")
        .selectAll()
        .where("bot_identity", "=", start.botIdentity)
        .where("lifecycle", "=", "published");
      query = source
        ? query.where(
            "funnel_id",
            "=",
            sourceRow?.funnel_id ?? "00000000-0000-0000-0000-000000000000",
          )
        : query.where("is_default", "=", true);
      const row = await query.executeTakeFirst();
      const funnel =
        row?.published &&
        row.published_revision !== null &&
        (!source || row.published.sources.some((s) => s.code === source))
          ? {
              funnelId: row.funnel_id,
              draft: row.published,
              revision: row.published_revision,
            }
          : undefined;
      const now = this.clock.now();
      await tx
        .insertInto("communication_entries")
        .values({
          bot_identity: start.botIdentity,
          update_id: start.updateId,
          contact_id: contact.contact_id,
          funnel_id: funnel?.funnelId ?? null,
          source_id: sourceRow?.source_id ?? null,
          source_code: source ?? null,
          entered_at: now,
          outcome: !contact.marketing_enabled
            ? "marketing_off"
            : funnel
              ? "entered"
              : "unavailable",
        })
        .execute();
      const common = {
        bot: start.botIdentity,
        contactId: contact.contact_id,
        now,
        dueAt: now,
      };
      if (!funnel) {
        await planDelivery(tx, {
          ...common,
          kind: "fallback",
          key: `fallback:${start.botIdentity}:${start.updateId}`,
          revision: 0,
          parts: [
            {
              partId: randomUUID(),
              content: {
                type: "text",
                text: "Эта ссылка сейчас недоступна. Общее знакомство — /start.",
                entities: [],
                buttons: [],
              },
            },
          ],
        });
        return;
      }
      const intro = await tx
        .selectFrom("communication_intro")
        .select("snapshot")
        .where("bot_identity", "=", start.botIdentity)
        .executeTakeFirstOrThrow();
      const introSnapshot = intro.snapshot;
      await planDelivery(tx, {
        ...common,
        kind: "intro",
        key: `intro:${contact.contact_id}`,
        parts: introSnapshot.parts,
        revision: introSnapshot.revision,
      });
      if (!contact.marketing_enabled) {
        const intro = await tx
          .selectFrom("communication_deliveries")
          .selectAll()
          .where("dedup_key", "=", `intro:${contact.contact_id}`)
          .executeTakeFirstOrThrow();
        await cancelDelivery(tx, intro, now, "marketing_unavailable");
      }
      await tx
        .insertInto("communication_enrollments")
        .values({
          enrollment_id: randomUUID(),
          contact_id: contact.contact_id,
          funnel_id: funnel.funnelId,
          enrolled_at: now,
          initial_entry_key: `entry:${start.botIdentity}:${start.updateId}`,
        })
        .onConflict((c) => c.columns(["contact_id", "funnel_id"]).doNothing())
        .execute();
      await planDelivery(tx, {
        ...common,
        kind: "entry",
        key: `entry:${start.botIdentity}:${start.updateId}`,
        funnelId: funnel.funnelId,
        stepId: funnel.draft.entryResponse.stepId,
        parts: funnel.draft.entryResponse.parts,
        revision: funnel.revision,
      });
    });
  }
}
