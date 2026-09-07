export interface TelegramCallbackAnswers {
  /** Clears Telegram's progress indicator; does not prove a successful sign-in. */
  answer(callbackQueryId: string): Promise<void>;
}

export const TELEGRAM_CALLBACK_ANSWERS = Symbol("TELEGRAM_CALLBACK_ANSWERS");

export class DisabledTelegramCallbackAnswers implements TelegramCallbackAnswers {
  async answer(): Promise<void> {}
}
