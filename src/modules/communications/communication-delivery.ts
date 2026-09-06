import type { TemplateContent } from "./communications-contract.js";
import type { TelegramDeliveryResult } from "../outbound/telegram-messages.js";
export interface CommunicationMessage {
  readonly chatId: string;
  readonly content: TemplateContent;
  readonly offerStart?: boolean;
}
export interface CommunicationTransport {
  send(message: CommunicationMessage): Promise<TelegramDeliveryResult>;
}
export const COMMUNICATION_TRANSPORT = Symbol("COMMUNICATION_TRANSPORT");
