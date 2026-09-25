import { SubscriptionActivation } from "../subscription-activation/subscription-activation.js";
import { AuthorAdmin } from "../communications/author-admin.js";
import { MarketingEntry } from "../communications/marketing-entry.js";
import { Communications } from "../communications/communications.js";
import { Inject, Injectable } from "@nestjs/common";

import { CommunityProvider } from "../community/community-provider.js";
import { StartResponseDeliveryQueue } from "../outbound/start-response-delivery-queue.js";
import { BotContacts } from "../bot-contacts/bot-contacts.js";
import type { VerifiedPrivateStart } from "../../shared/telegram-contact.js";
import { BotSignIn } from "../bot-sign-in/bot-sign-in.js";
import {
  TELEGRAM_CALLBACK_ANSWERS,
  type TelegramCallbackAnswers,
} from "../bot-sign-in/telegram-callback-answers.js";
import { IdentityLinking } from "../identity-linking/identity-linking.js";
import { MembershipEvidenceProvider } from "../membership-evidence/membership-evidence-provider.js";
import {
  reportCondition,
  reportFailure,
} from "../../shared/failure-diagnostics.js";
import {
  RUNTIME_COUNTERS,
  type RuntimeCounters,
} from "../../shared/runtime-counters.js";
import { TelegramUpdateInbox } from "./telegram-update-inbox.js";
import {
  TELEGRAM_UPDATE_TRANSLATOR,
  type TelegramUpdateCommand,
  type TelegramUpdateTranslator,
} from "./telegram-update-command.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";

@Injectable()
export class TelegramUpdateProcessor {
  constructor(
    @Inject(SubscriptionActivation)
    private readonly activation: Pick<
      SubscriptionActivation,
      "start" | "action"
    >,
    @Inject(TelegramUpdateInbox) private readonly inbox: TelegramUpdateInbox,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(BotContacts) private readonly botContacts: BotContacts,
    @Inject(IdentityLinking)
    private readonly identityLinking: IdentityLinking,
    @Inject(RUNTIME_COUNTERS) private readonly metrics: RuntimeCounters,
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
    @Inject(TELEGRAM_UPDATE_TRANSLATOR)
    private readonly translator: TelegramUpdateTranslator,
  ) {}

  async processAvailable(
    limit = 50,
    now?: Date,
    signal?: AbortSignal,
  ): Promise<number> {
    let processed = 0;
    for (; processed < limit && !signal?.aborted; processed += 1) {
      const update = await this.inbox.claimNext(now ?? new Date());
      if (!update) {
        break;
      }

      try {
        const command = this.translator.translate(
          update.botIdentity,
          update.updateId,
          update.payload,
          update.receivedAt,
        );
        await this.handle(command);

        if (!(await this.inbox.markProcessed(update, now ?? new Date())))
          reportCondition("update-inbox.process", "lease_lost", {
            update_id: update.updateId,
          });
        this.metrics.increment(
          command.kind === "ignored" ? "update_ignored" : "update_processed",
        );
      } catch (error) {
        const failure = reportFailure("update-inbox.process", error, {
          update_id: update.updateId,
          attempt: update.processAttemptCount,
        });
        const outcome = await this.inbox.markFailed(
          update,
          now ?? new Date(),
          failure,
        );
        if (outcome === "failed") {
          this.metrics.increment("update_failed");
        }
      }
    }
    return processed;
  }

  private async handle(command: TelegramUpdateCommand): Promise<void> {
    switch (command.kind) {
      case "access-action":
        await this.botContacts.observeStart(command.value, "none");
        await this.activation.action(command.value, command.action);
        if (command.callbackQueryId)
          await this.callbackAnswers.answer(command.callbackQueryId);
        return;
      case "marketing_preference":
        await this.botContacts.observeStart(command.value.contact, "none");
        await this.marketing.setPreference(
          command.value.contact,
          command.value.enabled,
        );
        return;
      case "start":
        return this.start(command.value);
      case "sign-in-decision":
        await this.signIn.decide(command.value);
        await this.callbackAnswers.answer(command.callbackQueryId);
        return;
      case "contactability":
        await this.botContacts.observeContactability(command.value);
        return;
      case "membership":
        await this.community.observeMembershipEvent(command.value);
        await this.membershipEvidence.accept(command.value);
        return;
      case "join-request":
        await this.community.acceptJoinRequest(command.value);
        return;
      case "community-request":
        // The command exists only while community effects are enabled.
        if (this.config.activation?.enabled)
          await this.activation.action(command.value, "community");
        else if (this.config.communityMode === "live")
          await this.answerAdmission(command.value);
        return;
      case "author-input": {
        const handled = await this.authorAdmin.handle(command.value);
        if (handled && command.value.callbackQueryId)
          await this.callbackAnswers.answer(command.value.callbackQueryId);
        if (!handled && command.intake)
          await this.communications.intake(command.intake);
        return;
      }
      case "template-intake":
        await this.communications.intake(command.value);
        return;
      case "ignored":
        return;
      default:
        return unhandled(command);
    }
  }

  private async start(
    start: Extract<TelegramUpdateCommand, { kind: "start" }>["value"],
  ): Promise<void> {
    await this.botContacts.observeStart(
      start.contact,
      start.activationCode !== undefined
        ? "none"
        : start.signInToken
          ? "none"
          : start.linkToken
            ? "link-receipt"
            : this.marketing.enabled()
              ? "none"
              : "welcome",
    );
    if (start.activationCode !== undefined)
      await this.activation.start(start.contact, start.activationCode);
    if (start.signInToken?.kind === "digest") {
      await this.signIn.acceptStart(start.contact, start.signInToken.digest);
    }
    if (start.linkToken) {
      await this.identityLinking.acceptStart({
        botIdentity: start.contact.botIdentity,
        linkToken: start.linkToken,
        observedAt: start.contact.observedAt,
        telegramUserId: start.contact.telegramUserId,
      });
    }
    if (
      start.activationCode === undefined &&
      !start.linkToken &&
      !start.signInToken &&
      this.marketing.enabled()
    ) {
      await this.marketing.enter(start.contact, start.marketingSource);
    }
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
      case "moderation_blocked":
        messageText =
          "Вступление ограничено модератором или требует проверки оператора. Обратитесь к владельцу. Доступ к материалам проверяется отдельно.";
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

function unhandled(command: never): never {
  throw new Error(
    `Unhandled Telegram update command ${(command as { kind: string }).kind}`,
  );
}
