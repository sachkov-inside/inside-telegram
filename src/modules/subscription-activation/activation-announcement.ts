import type { ActivationConfig } from "../../config/activation-config.js";
import type {
  TelegramButton,
  TelegramDeliveryResult,
  TelegramTextMessage,
} from "../outbound/telegram-messages.js";

/** The owner's announcement in a prior course group; the button opens the owner link. */
export const ACTIVATION_ANNOUNCEMENT_TEXT =
  "Все участники курса получают доступ к Sachkov Inside. Нажмите «Получить доступ»: бот проверит, что вы состоите в этой группе, выдаст права на платформе и пришлёт приглашение в общий чат Inside.";
export const ACTIVATION_ANNOUNCEMENT_BUTTON = "Получить доступ";

/** The same code shape the bot accepts in `/start a_<code>`. */
const ACTIVATION_CODE = /^[A-Za-z0-9_-]{1,40}$/;
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export interface ActivationAnnouncementTelegram {
  /** The bot's public username as Telegram reports it. */
  botUsername(): Promise<string | undefined>;
  sendText(message: TelegramTextMessage): Promise<TelegramDeliveryResult>;
}

export interface ActivationAnnouncementInput {
  readonly activation: ActivationConfig | undefined;
  readonly sourceRef: string;
  readonly code: string;
  /** False only previews the text and the button. */
  readonly send: boolean;
}

export type ActivationAnnouncementResult =
  | {
      readonly status: "ready" | "sent";
      readonly text: string;
      readonly button: TelegramButton;
    }
  | {
      readonly status: "refused";
      readonly reason:
        | "activation_disabled"
        | "invalid_code"
        | "unknown_source"
        | "not_whole_group"
        | "no_bot_username";
    }
  | { readonly status: "not_sent"; readonly providerErrorCode: number }
  | { readonly status: "unknown" };

/**
 * Prepares or sends the owner's announcement with the activation button to one course source
 * group. Only a whole-group source fits the promise that every member gets access; the rights
 * themselves come from the owner link's Platform rule when a member presses the button.
 */
export async function announceActivation(
  input: ActivationAnnouncementInput,
  telegram: ActivationAnnouncementTelegram,
): Promise<ActivationAnnouncementResult> {
  if (!input.activation?.enabled)
    return { status: "refused", reason: "activation_disabled" };
  if (!ACTIVATION_CODE.test(input.code))
    return { status: "refused", reason: "invalid_code" };
  const source = input.activation.sources.find(
    (candidate) => candidate.sourceRef === input.sourceRef,
  );
  if (!source) return { status: "refused", reason: "unknown_source" };
  if (source.policy !== "whole_group")
    return { status: "refused", reason: "not_whole_group" };
  const username = await telegram.botUsername();
  if (!username || !BOT_USERNAME.test(username))
    return { status: "refused", reason: "no_bot_username" };
  const button: TelegramButton = {
    text: ACTIVATION_ANNOUNCEMENT_BUTTON,
    url: `https://t.me/${username}?start=a_${input.code}`,
  };
  const announcement = { text: ACTIVATION_ANNOUNCEMENT_TEXT, button };
  if (!input.send) return { status: "ready", ...announcement };
  const delivery = await telegram.sendText({
    chatId: source.chatId,
    text: announcement.text,
    buttons: [button],
  });
  if (delivery.kind === "delivered") return { status: "sent", ...announcement };
  if (delivery.kind === "transport_unknown") return { status: "unknown" };
  return { status: "not_sent", providerErrorCode: delivery.providerErrorCode };
}
