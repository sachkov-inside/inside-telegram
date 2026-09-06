import { Api, type ApiClientOptions } from "grammy";

import type { TelegramCallbackAnswers } from "../../modules/bot-sign-in/telegram-callback-answers.js";

export class GrammyCallbackAnswersAdapter implements TelegramCallbackAnswers {
  private readonly api: Pick<Api, "answerCallbackQuery">;

  constructor(token: string, transport?: Pick<ApiClientOptions, "fetch">) {
    this.api = new Api(token, { ...transport, timeoutSeconds: 2 });
  }

  async answer(callbackQueryId: string): Promise<void> {
    try {
      await this.api.answerCallbackQuery(callbackQueryId, {
        text: "Вернитесь в исходную вкладку сайта и проверьте результат входа.",
      });
    } catch {
      // Ephemeral UI acknowledgement may already have expired. The durable decision is independent.
    }
  }
}
