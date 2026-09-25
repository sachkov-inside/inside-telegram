/** A private-chat message or `author:` callback that may belong to the author admin dialog. */
export interface AuthorInput {
  readonly botIdentity: string;
  readonly updateId: string;
  readonly telegramUserId: string;
  /** The author's private chat; Telegram gives it the author's user ID. */
  readonly privateChatId: string;
  readonly text: string;
  readonly content: unknown;
  readonly callbackData?: string;
  readonly callbackQueryId?: string;
}

/** A private-chat message for the `/template` intake mode. */
export interface TemplateIntake {
  readonly botIdentity: string;
  readonly updateId: string;
  readonly telegramUserId: string;
  readonly privateChatId: string;
  readonly action: "open" | "close" | "capture";
  readonly content: unknown;
}
