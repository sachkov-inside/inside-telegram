import { Module, type DynamicModule } from "@nestjs/common";

import {
  DisabledMessagesAdapter,
  GrammyMessagesAdapter,
} from "./adapters/telegram/grammy-messages.adapter.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "./config/application-config.js";
import { createDatabase } from "./database/create-database.js";
import { DATABASE } from "./database/database.js";
import { DatabaseLifecycle } from "./database/database-lifecycle.js";
import { BotContacts } from "./modules/bot-contacts/bot-contacts.js";
import {
  TELEGRAM_MESSAGES,
  type TelegramMessages,
} from "./modules/outbound/telegram-messages.js";
import { WelcomeDeliveryProcessor } from "./modules/outbound/welcome-delivery-processor.js";
import { WelcomeDeliveryQueue } from "./modules/outbound/welcome-delivery-queue.js";
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
      controllers: [OperationsController, TelegramWebhookController],
      providers: [
        { provide: APPLICATION_CONFIG, useValue: config },
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
        BackgroundWorkers,
        BotContacts,
        DatabaseLifecycle,
        RuntimeMetrics,
        TelegramUpdateInbox,
        TelegramUpdateProcessor,
        TelegramWebhook,
        WelcomeDeliveryProcessor,
        WelcomeDeliveryQueue,
      ],
    };
  }
}
