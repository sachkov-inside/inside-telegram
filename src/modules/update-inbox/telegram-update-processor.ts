import { AuthorAdmin } from "../communications/author-admin.js";
import { translateAuthorInput } from "../../adapters/telegram/grammy-author-admin.adapter.js";
import { MarketingEntry } from "../communications/marketing-entry.js";
import { Communications } from "../communications/communications.js";
import { translateTemplateIntake } from "../../adapters/telegram/grammy-template-intake.adapter.js";
import { Inject, Injectable } from "@nestjs/common";

import { GrammyUpdateAdapter } from "../../adapters/telegram/grammy-update.adapter.js";
import { CommunityProvider } from "../community/community-provider.js";
import { StartResponseDeliveryQueue } from "../outbound/start-response-delivery-queue.js";
import {
  BotContacts,
  type VerifiedPrivateStart,
} from "../bot-contacts/bot-contacts.js";
import { BotSignIn } from "../bot-sign-in/bot-sign-in.js";
import {
  TELEGRAM_CALLBACK_ANSWERS,
  type TelegramCallbackAnswers,
} from "../bot-sign-in/telegram-callback-answers.js";
import { IdentityLinking } from "../identity-linking/identity-linking.js";
import { MembershipEvidenceProvider } from "../membership-evidence/membership-evidence-provider.js";
import { RuntimeMetrics } from "../../operations/runtime-metrics.js";
import { TelegramUpdateInbox } from "./telegram-update-inbox.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";

@Injectable()
export class TelegramUpdateProcessor {
  private readonly adapter = new GrammyUpdateAdapter();

  constructor(
    @Inject(TelegramUpdateInbox) private readonly inbox: TelegramUpdateInbox,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
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
    @Inject(CommunityProvider)
    private readonly community: CommunityProvider,
    @Inject(StartResponseDeliveryQueue)
    private readonly replies: StartResponseDeliveryQueue,
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
        } else if (command.kind === "join-request") {
          await this.community.acceptJoinRequest(command.value);
        } else if (command.kind === "community-request") {
          // The command exists only while community effects are enabled.
          if (this.config.communityMode === "live")
            await this.answerAdmission(command.value);
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

  /** The contact's own request is the only path that hands out an invite link. */
  private async answerAdmission(contact: VerifiedPrivateStart): Promise<void> {
    const admission = await this.community.admissionFor(contact.telegramUserId);
    const texts = this.config.communityTexts;
    let messageText: string;
    switch (admission.kind) {
      case "link":
        messageText = `${texts.invite}\n${admission.inviteLink}`;
        break;
      case "member":
        messageText = texts.member;
        break;
      case "preparing":
        messageText = texts.preparing;
        break;
      case "none":
        messageText = texts.unavailable;
        break;
    }
    await this.replies.enqueue({
      botIdentity: contact.botIdentity,
      telegramUserId: contact.telegramUserId,
      privateChatId: contact.privateChatId,
      messageText,
      sourceKey: `community-admission:${contact.botIdentity}:${contact.updateId}`,
      triggerUpdateId: contact.updateId,
      now: contact.observedAt,
    });
  }
}
