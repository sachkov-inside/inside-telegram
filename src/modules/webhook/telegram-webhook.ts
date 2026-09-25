import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import {
  RUNTIME_COUNTERS,
  type RuntimeCounters,
} from "../../shared/runtime-counters.js";
import { credentialsMatch } from "../../security/credentials.js";
import { TelegramUpdateInbox } from "../update-inbox/telegram-update-inbox.js";
import {
  TELEGRAM_UPDATE_TRANSLATOR,
  type TelegramUpdateTranslator,
} from "../update-inbox/telegram-update-command.js";

/** The application path Telegram delivers updates to; registration refers to the same value. */
export const TELEGRAM_WEBHOOK_PATH = "webhooks/telegram";

export const TELEGRAM_WEBHOOK_ALLOWED_UPDATES = [
  "message",
  "chat_member",
  "my_chat_member",
  "chat_join_request",
  "callback_query",
] as const;

@Injectable()
export class TelegramWebhook {
  constructor(
    @Inject(APPLICATION_CONFIG)
    private readonly config: ApplicationConfig,
    @Inject(TelegramUpdateInbox) private readonly inbox: TelegramUpdateInbox,
    @Inject(RUNTIME_COUNTERS) private readonly metrics: RuntimeCounters,
    @Inject(TELEGRAM_UPDATE_TRANSLATOR)
    private readonly translator: TelegramUpdateTranslator,
  ) {}

  async accept(secret: string | undefined, payload: unknown): Promise<void> {
    if (!credentialsMatch(secret, this.config.webhookSecret)) {
      throw new UnauthorizedException();
    }

    const updateId = readUpdateId(payload);
    if (!updateId) {
      throw new BadRequestException("Body must be a Telegram Update");
    }

    const result = await this.inbox.accept(
      this.config.botIdentity,
      updateId,
      this.translator.prepareForInbox(payload),
      new Date(),
    );
    this.metrics.increment(
      result === "accepted" ? "webhook_accepted" : "webhook_duplicate",
    );
  }
}

function readUpdateId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const updateId = payload.update_id;
  if (!Number.isSafeInteger(updateId) || Number(updateId) < 0) {
    return undefined;
  }
  return String(updateId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
