import { Module, type DynamicModule } from "@nestjs/common";

import {
  DisabledMessagesAdapter,
  GrammyMessagesAdapter,
} from "./adapters/telegram/grammy-messages.adapter.js";
import { GrammyMembershipAdapter } from "./adapters/telegram/grammy-membership.adapter.js";
import { HttpPlatformEvidenceAdapter } from "./adapters/platform/http-platform-evidence.adapter.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "./config/application-config.js";
import { createDatabase } from "./database/create-database.js";
import { DATABASE } from "./database/database.js";
import { DatabaseLifecycle } from "./database/database-lifecycle.js";
import { BotContacts } from "./modules/bot-contacts/bot-contacts.js";
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
        IdentityLinkingController,
        OperationsController,
        TelegramWebhookController,
      ],
      providers: [
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
        BackgroundWorkers,
        BotContacts,
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
