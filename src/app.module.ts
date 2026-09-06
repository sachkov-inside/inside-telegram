import {
  AUTHOR_CONTENT_VALIDATION,
  DisabledAuthorContentValidation,
} from "./modules/communications/author-content-validation.js";
import { HttpAuthorContentValidationAdapter } from "./adapters/platform/http-author-content-validation.adapter.js";
import { CommunicationTracking } from "./modules/communications/communication-tracking.js";
import { Api } from "grammy";
import { Funnels } from "./modules/communications/funnels.js";
import { MarketingEntry } from "./modules/communications/marketing-entry.js";
import { FunnelScheduler } from "./modules/communications/funnel-scheduler.js";
import { COMMUNICATION_TRANSPORT } from "./modules/communications/communication-delivery.js";
import {
  GrammyCommunicationsAdapter,
  DisabledCommunicationTransport,
} from "./adapters/telegram/grammy-communications.adapter.js";
import { Communications } from "./modules/communications/communications.js";
import { CommunicationsController } from "./modules/communications/communications.controller.js";
import {
  AUTHOR_AUTHORIZATION,
  DisabledAuthorAuthorization,
} from "./modules/communications/author-authorization.js";
import { HttpAuthorAuthorizationAdapter } from "./adapters/platform/http-author-authorization.adapter.js";
import { Module, type DynamicModule } from "@nestjs/common";

import {
  DisabledMessagesAdapter,
  GrammyMessagesAdapter,
} from "./adapters/telegram/grammy-messages.adapter.js";
import { GrammyMembershipAdapter } from "./adapters/telegram/grammy-membership.adapter.js";
import { GrammyCallbackAnswersAdapter } from "./adapters/telegram/grammy-callback-answers.adapter.js";
import {
  TELEGRAM_CALLBACK_ANSWERS,
  DisabledTelegramCallbackAnswers,
} from "./modules/bot-sign-in/telegram-callback-answers.js";
import { HttpPlatformEvidenceAdapter } from "./adapters/platform/http-platform-evidence.adapter.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "./config/application-config.js";
import { createDatabase } from "./database/create-database.js";
import { DATABASE } from "./database/database.js";
import { DatabaseLifecycle } from "./database/database-lifecycle.js";
import { BotContacts } from "./modules/bot-contacts/bot-contacts.js";
import { SignInAccountLink } from "./modules/bot-sign-in/sign-in-account-link.js";
import { BotSignIn } from "./modules/bot-sign-in/bot-sign-in.js";
import { BotSignInController } from "./modules/bot-sign-in/bot-sign-in.controller.js";
import { CLOCK, systemClock } from "./modules/identity-linking/clock.js";
import { IdentityLinking } from "./modules/identity-linking/identity-linking.js";
import { IdentityLinkRecovery } from "./modules/identity-linking/identity-link-recovery.js";
import { IdentityLinkingController } from "./modules/identity-linking/identity-linking.controller.js";
import { InMemoryIdentityLinkingAdapter } from "./modules/identity-linking/in-memory-identity-linking.adapter.js";
import { InitialMembershipCheckProcessor } from "./modules/membership-evidence/initial-membership-check-processor.js";
import { InitialMembershipCheckQueue } from "./modules/membership-evidence/initial-membership-check-queue.js";
import { MembershipEvidenceDeliveryProcessor } from "./modules/membership-evidence/membership-evidence-delivery-processor.js";
import { MembershipEvidenceOutbox } from "./modules/membership-evidence/membership-evidence-outbox.js";
import { MembershipEvidenceProvider } from "./modules/membership-evidence/membership-evidence-provider.js";
import {
  DisabledPlatformEvidenceDelivery,
  PLATFORM_EVIDENCE_DELIVERY,
  type PlatformEvidenceDelivery,
} from "./modules/membership-evidence/platform-evidence-delivery.js";
import {
  DisabledTelegramMembership,
  TELEGRAM_MEMBERSHIP,
  type TelegramMembership,
} from "./modules/membership-evidence/telegram-membership.js";
import {
  TELEGRAM_MESSAGES,
  type TelegramMessages,
} from "./modules/outbound/telegram-messages.js";
import { StartResponseDeliveryProcessor } from "./modules/outbound/start-response-delivery-processor.js";
import { StartResponseDeliveryQueue } from "./modules/outbound/start-response-delivery-queue.js";
import { TelegramUpdateInbox } from "./modules/update-inbox/telegram-update-inbox.js";
import { TelegramUpdateProcessor } from "./modules/update-inbox/telegram-update-processor.js";
import { TelegramWebhook } from "./modules/webhook/telegram-webhook.js";
import { TelegramWebhookController } from "./modules/webhook/telegram-webhook.controller.js";
import { BackgroundWorkers } from "./operations/background-workers.js";
import { OperationsController } from "./operations/operations.controller.js";
import { RuntimeMetrics } from "./operations/runtime-metrics.js";

@Module({})
export class AppModule {
  static register(config: ApplicationConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        BotSignInController,
        CommunicationsController,
        IdentityLinkingController,
        OperationsController,
        TelegramWebhookController,
      ],
      providers: [
        {
          provide: TELEGRAM_CALLBACK_ANSWERS,
          useFactory: () =>
            config.signInEnabled &&
            config.deliveryMode === "live" &&
            config.botToken
              ? new GrammyCallbackAnswersAdapter(config.botToken)
              : new DisabledTelegramCallbackAnswers(),
        },
        { provide: APPLICATION_CONFIG, useValue: config },
        { provide: CLOCK, useValue: systemClock },
        {
          provide: DATABASE,
          inject: [APPLICATION_CONFIG],
          useFactory: (applicationConfig: ApplicationConfig) =>
            createDatabase(applicationConfig.databaseUrl),
        },
        {
          provide: TELEGRAM_MESSAGES,
          inject: [APPLICATION_CONFIG],
          useFactory: (
            applicationConfig: ApplicationConfig,
          ): TelegramMessages => {
            if (
              applicationConfig.deliveryMode === "live" &&
              applicationConfig.botToken
            ) {
              return new GrammyMessagesAdapter(applicationConfig.botToken);
            }
            return new DisabledMessagesAdapter();
          },
        },
        {
          provide: TELEGRAM_MEMBERSHIP,
          inject: [APPLICATION_CONFIG],
          useFactory: (
            applicationConfig: ApplicationConfig,
          ): TelegramMembership => {
            if (
              applicationConfig.membershipMode === "live" &&
              applicationConfig.botToken
            ) {
              return new GrammyMembershipAdapter(applicationConfig.botToken);
            }
            return new DisabledTelegramMembership();
          },
        },
        {
          provide: PLATFORM_EVIDENCE_DELIVERY,
          inject: [APPLICATION_CONFIG],
          useFactory: (
            applicationConfig: ApplicationConfig,
          ): PlatformEvidenceDelivery => {
            if (
              applicationConfig.evidenceDeliveryMode === "live" &&
              applicationConfig.platformEvidenceDeliveryUrl &&
              applicationConfig.platformEvidenceDeliverySecret
            ) {
              return new HttpPlatformEvidenceAdapter(
                applicationConfig.platformEvidenceDeliveryUrl,
                applicationConfig.platformEvidenceDeliverySecret,
              );
            }
            return new DisabledPlatformEvidenceDelivery();
          },
        },
        CommunicationTracking,
        Communications,
        Funnels,
        MarketingEntry,
        FunnelScheduler,
        {
          provide: COMMUNICATION_TRANSPORT,
          useFactory: () =>
            config.marketingEnabled &&
            config.deliveryMode === "live" &&
            config.botToken
              ? new GrammyCommunicationsAdapter(
                  new Api(config.botToken, { timeoutSeconds: 10 }),
                )
              : new DisabledCommunicationTransport(),
        },
        {
          provide: AUTHOR_AUTHORIZATION,
          useFactory: () =>
            config.platformAuthorAuthorizationUrl &&
            config.platformAuthorAuthorizationSecret
              ? new HttpAuthorAuthorizationAdapter(
                  config.platformAuthorAuthorizationUrl,
                  config.platformAuthorAuthorizationSecret,
                )
              : new DisabledAuthorAuthorization(),
        },
        {
          provide: AUTHOR_CONTENT_VALIDATION,
          useFactory: () =>
            config.platformAuthorContentValidationUrl &&
            config.platformAuthorAuthorizationSecret
              ? new HttpAuthorContentValidationAdapter(
                  config.platformAuthorContentValidationUrl,
                  config.platformAuthorAuthorizationSecret,
                )
              : new DisabledAuthorContentValidation(),
        },
        BackgroundWorkers,
        BotContacts,
        BotSignIn,
        SignInAccountLink,
        DatabaseLifecycle,
        IdentityLinking,
        IdentityLinkRecovery,
        InMemoryIdentityLinkingAdapter,
        InitialMembershipCheckProcessor,
        InitialMembershipCheckQueue,
        MembershipEvidenceDeliveryProcessor,
        MembershipEvidenceOutbox,
        MembershipEvidenceProvider,
        RuntimeMetrics,
        TelegramUpdateInbox,
        TelegramUpdateProcessor,
        TelegramWebhook,
        StartResponseDeliveryProcessor,
        StartResponseDeliveryQueue,
      ],
    };
  }
}
