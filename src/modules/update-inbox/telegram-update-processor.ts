import { AuthorAdmin } from "../communications/author-admin.js";
import { translateAuthorInput } from "../../adapters/telegram/grammy-author-admin.adapter.js";
import { MarketingEntry } from "../communications/marketing-entry.js";
import { Communications } from "../communications/communications.js";
import { translateTemplateIntake } from "../../adapters/telegram/grammy-template-intake.adapter.js";
import { Inject, Injectable } from "@nestjs/common";

import { GrammyUpdateAdapter } from "../../adapters/telegram/grammy-update.adapter.js";
import { BotContacts } from "../bot-contacts/bot-contacts.js";
import { BotSignIn } from "../bot-sign-in/bot-sign-in.js";
import {
  TELEGRAM_CALLBACK_ANSWERS,
  type TelegramCallbackAnswers,
} from "../bot-sign-in/telegram-callback-answers.js";
import { IdentityLinking } from "../identity-linking/identity-linking.js";
import { MembershipEvidenceProvider } from "../membership-evidence/membership-evidence-provider.js";
import { RuntimeMetrics } from "../../operations/runtime-metrics.js";
import { TelegramUpdateInbox } from "./telegram-update-inbox.js";

@Injectable()
export class TelegramUpdateProcessor {
  private readonly adapter = new GrammyUpdateAdapter();

  constructor(
    @Inject(TelegramUpdateInbox) private readonly inbox: TelegramUpdateInbox,
    @Inject(BotContacts) private readonly botContacts: BotContacts,
    @Inject(IdentityLinking)
    private readonly identityLinking: IdentityLinking,
    @Inject(RuntimeMetrics) private readonly metrics: RuntimeMetrics,
    @Inject(MembershipEvidenceProvider)
    private readonly membershipEvidence: MembershipEvidenceProvider,
    @Inject(BotSignIn) private readonly signIn: BotSignIn,
    @Inject(TELEGRAM_CALLBACK_ANSWERS)
    private readonly callbackAnswers: TelegramCallbackAnswers,
    @Inject(Communications)
    private readonly communications: Communications,
    @Inject(AuthorAdmin)
    private readonly authorAdmin: Pick<AuthorAdmin, "handle">,
    @Inject(MarketingEntry) private readonly marketing: MarketingEntry,
  ) {}

  async processAvailable(limit = 50, now?: Date): Promise<number> {
    let processed = 0;
    for (; processed < limit; processed += 1) {
      const update = await this.inbox.claimNext(now ?? new Date());
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

        if (command.kind === "marketing_preference") {
          await this.botContacts.observeStart(command.value.contact, "none");
          await this.marketing.setPreference(
            command.value.contact,
            command.value.enabled,
          );
        } else if (command.kind === "start") {
          await this.botContacts.observeStart(
            command.value.contact,
            command.value.signInToken
              ? "none"
              : command.value.linkToken
                ? "link-receipt"
                : this.marketing.enabled()
                  ? "none"
                  : "welcome",
          );
          if (command.value.signInToken?.kind === "digest") {
            await this.signIn.acceptStart(
              command.value.contact,
              command.value.signInToken.digest,
            );
          }
          if (command.value.linkToken) {
            await this.identityLinking.acceptStart({
              botIdentity: command.value.contact.botIdentity,
              linkToken: command.value.linkToken,
              observedAt: command.value.contact.observedAt,
              telegramUserId: command.value.contact.telegramUserId,
            });
          }
          if (
            !command.value.linkToken &&
            !command.value.signInToken &&
            this.marketing.enabled()
          ) {
            await this.marketing.enter(
              command.value.contact,
              command.value.marketingSource,
            );
          }
        } else if (command.kind === "sign-in-decision") {
          await this.signIn.decide(command.value);
          await this.callbackAnswers.answer(command.callbackQueryId);
        } else if (command.kind === "contactability") {
          await this.botContacts.observeContactability(command.value);
        } else if (command.kind === "membership") {
          await this.membershipEvidence.accept(command.value);
        } else if (command.kind === "ignored") {
          const authorInput = translateAuthorInput(
            update.botIdentity,
            update.updateId,
            update.payload,
          );
          const handled = authorInput
            ? await this.authorAdmin.handle(authorInput)
            : false;
          if (handled && authorInput?.callbackQueryId)
            await this.callbackAnswers.answer(authorInput.callbackQueryId);
          const intake =
            !handled &&
            translateTemplateIntake(
              update.botIdentity,
              update.updateId,
              update.payload,
            );
          if (intake) await this.communications.intake(intake);
        }

        await this.inbox.markProcessed(update, now ?? new Date());
        this.metrics.increment(
          command.kind === "ignored" ? "update_ignored" : "update_processed",
        );
      } catch {
        const outcome = await this.inbox.markFailed(update, now ?? new Date());
        if (outcome === "failed") {
          this.metrics.increment("update_failed");
        }
      }
    }
    return processed;
  }
}
