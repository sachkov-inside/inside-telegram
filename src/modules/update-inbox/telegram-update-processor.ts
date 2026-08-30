import { Inject, Injectable } from "@nestjs/common";

import { GrammyUpdateAdapter } from "../../adapters/telegram/grammy-update.adapter.js";
import { BotContacts } from "../bot-contacts/bot-contacts.js";
import { RuntimeMetrics } from "../../operations/runtime-metrics.js";
import { TelegramUpdateInbox } from "./telegram-update-inbox.js";

@Injectable()
export class TelegramUpdateProcessor {
  private readonly adapter = new GrammyUpdateAdapter();

  constructor(
    @Inject(TelegramUpdateInbox) private readonly inbox: TelegramUpdateInbox,
    @Inject(BotContacts) private readonly botContacts: BotContacts,
    @Inject(RuntimeMetrics) private readonly metrics: RuntimeMetrics,
  ) {}

  async processAvailable(limit = 50, now = new Date()): Promise<number> {
    let processed = 0;
    for (; processed < limit; processed += 1) {
      const update = await this.inbox.claimNext(now);
      if (!update) {
        break;
      }

      try {
        const command = this.adapter.translate(
          update.botIdentity,
          update.updateId,
          update.payload,
          update.receivedAt,
        );

        if (command.kind === "start") {
          await this.botContacts.observeStart(command.value);
        } else if (command.kind === "contactability") {
          await this.botContacts.observeContactability(command.value);
        }

        await this.inbox.markProcessed(update, now);
        this.metrics.increment(
          command.kind === "ignored" ? "update_ignored" : "update_processed",
        );
      } catch {
        const outcome = await this.inbox.markFailed(update, now);
        if (outcome === "failed") {
          this.metrics.increment("update_failed");
        }
      }
    }
    return processed;
  }
}
