import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
} from "@nestjs/common";

import { TELEGRAM_WEBHOOK_PATH, TelegramWebhook } from "./telegram-webhook.js";

@Controller(TELEGRAM_WEBHOOK_PATH)
export class TelegramWebhookController {
  constructor(
    @Inject(TelegramWebhook) private readonly webhook: TelegramWebhook,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async accept(
    @Headers("x-telegram-bot-api-secret-token") secret: string | undefined,
    @Body() payload: unknown,
  ): Promise<{ accepted: true }> {
    await this.webhook.accept(secret, payload);
    return { accepted: true };
  }
}
