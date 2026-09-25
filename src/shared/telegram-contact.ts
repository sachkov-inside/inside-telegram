export type Contactability = "blocked" | "reachable";

/** A human's private message to the bot, verified by the transport adapter. */
export interface VerifiedPrivateStart {
  readonly botIdentity: string;
  readonly observedAt: Date;
  readonly privateChatId: string;
  readonly telegramUserId: string;
  readonly updateId: string;
}

/** Telegram's report that a private chat with the bot was blocked or reopened. */
export interface VerifiedPrivateContactability {
  readonly botIdentity: string;
  readonly contactability: Contactability;
  readonly observedAt: Date;
  readonly telegramUserId: string;
  readonly updateId: string;
}
