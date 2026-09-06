import { Api } from "grammy";

import type { TelegramCallbackAnswers } from "../../modules/bot-sign-in/telegram-callback-answers.js";

export class GrammyCallbackAnswersAdapter implements TelegramCallbackAnswers {
  private readonly api: Pick<Api, "answerCallbackQuery">;

  constructor(token: string, api?: Pick<Api, "answerCallbackQuery">) {
    this.api = api ?? new Api(token);
  }

  async answer(callbackQueryId: string): Promise<void> {
    try {
      await this.api.answerCallbackQuery(
        callbackQueryId,
        {
          text: "Вернитесь в исходную вкладку сайта и проверьте результат входа.",
        },
        AbortSignal.timeout(2_000),
      );
    } catch {
      // Ephemeral UI acknowledgement may already have expired. The durable decision is independent.
    }
  }
}
