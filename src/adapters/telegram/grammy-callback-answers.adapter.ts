import { Api, type ApiClientOptions } from "grammy";

import type { TelegramCallbackAnswers } from "../../modules/bot-sign-in/telegram-callback-answers.js";

export class GrammyCallbackAnswersAdapter implements TelegramCallbackAnswers {
  private readonly api: Pick<Api, "answerCallbackQuery">;

  constructor(token: string, transport?: Pick<ApiClientOptions, "fetch">) {
    this.api = new Api(token, { ...transport, timeoutSeconds: 2 });
  }

  async answer(callbackQueryId: string): Promise<void> {
    try {
      // Shared by sign-in and author menus; the durable reply carries the actual result.
      await this.api.answerCallbackQuery(callbackQueryId);
    } catch {
      // Ephemeral UI acknowledgement may already have expired. The durable decision is independent.
    }
  }
}
