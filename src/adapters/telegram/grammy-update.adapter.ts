import { createHash } from "node:crypto";

import type { Update } from "grammy/types";

import type {
  VerifiedPrivateContactability,
  VerifiedPrivateStart,
} from "../../modules/bot-contacts/bot-contacts.js";

export type TelegramUpdateCommand =
  | {
      readonly kind: "contactability";
      readonly value: VerifiedPrivateContactability;
    }
  | { readonly kind: "ignored" }
  | { readonly kind: "start"; readonly value: VerifiedPrivateStart };

const LINK_TOKEN_FIELD = "_inside_link_token";

export function prepareTelegramUpdateForInbox(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.message)) {
    return payload;
  }

  const text = payload.message.text;
  if (typeof text !== "string") {
    return payload;
  }

  const start = parseStart(text);
  if (!start || start.argument === undefined) {
    return payload;
  }

  const linkToken = /^[A-Za-z0-9_-]{43,64}$/.test(start.argument)
    ? {
        digest: createHash("sha256").update(start.argument).digest("base64url"),
        kind: "digest" as const,
      }
    : { kind: "malformed" as const };

  return {
    ...payload,
    message: {
      ...payload.message,
      [LINK_TOKEN_FIELD]: linkToken,
      text: start.command,
    },
  };
}

export class GrammyUpdateAdapter {
  translate(
    botIdentity: string,
    updateId: string,
    payload: unknown,
    observedAt: Date,
  ): TelegramUpdateCommand {
    if (!isRecord(payload)) {
      return { kind: "ignored" };
    }

    const update = payload as Partial<Update>;
    const start = this.privateStart(botIdentity, updateId, update, observedAt);
    if (start) {
      return { kind: "start", value: start };
    }

    const contactability = this.privateContactability(
      botIdentity,
      updateId,
      update,
      observedAt,
    );
    if (contactability) {
      return { kind: "contactability", value: contactability };
    }

    return { kind: "ignored" };
  }

  private privateStart(
    botIdentity: string,
    updateId: string,
    update: Partial<Update>,
    observedAt: Date,
  ): VerifiedPrivateStart | undefined {
    const message: unknown = update.message;
    if (!isRecord(message)) {
      return undefined;
    }
    const chat = message.chat;
    const from = message.from;
    if (
      !isRecord(chat) ||
      chat.type !== "private" ||
      !isRecord(from) ||
      from.is_bot !== false ||
      typeof message.text !== "string" ||
      !isOrdinaryStart(message.text)
    ) {
      return undefined;
    }

    const telegramUserId = telegramId(from.id);
    const privateChatId = telegramId(chat.id);
    if (!telegramUserId || !privateChatId) {
      return undefined;
    }

    const linkToken = readLinkToken(message);
    return {
      botIdentity,
      ...(linkToken ? { linkToken } : {}),
      observedAt,
      privateChatId,
      telegramUserId,
      updateId,
    };
  }

  private privateContactability(
    botIdentity: string,
    updateId: string,
    update: Partial<Update>,
    observedAt: Date,
  ): VerifiedPrivateContactability | undefined {
    const contactabilityUpdate: unknown = update.my_chat_member;
    if (!isRecord(contactabilityUpdate)) {
      return undefined;
    }
    const chat = contactabilityUpdate.chat;
    const from = contactabilityUpdate.from;
    const newChatMember = contactabilityUpdate.new_chat_member;
    if (
      !isRecord(chat) ||
      chat.type !== "private" ||
      !isRecord(from) ||
      from.is_bot !== false ||
      !isRecord(newChatMember)
    ) {
      return undefined;
    }

    const telegramUserId = telegramId(from.id);
    if (!telegramUserId) {
      return undefined;
    }

    const status = newChatMember.status;
    if (status !== "kicked" && status !== "member") {
      return undefined;
    }

    return {
      botIdentity,
      contactability: status === "kicked" ? "blocked" : "reachable",
      observedAt,
      telegramUserId,
      updateId,
    };
  }
}

function isOrdinaryStart(text: string): boolean {
  return /^\/start(?:@[A-Za-z0-9_]+)?$/.test(text.trim());
}

function parseStart(
  text: string,
): { readonly argument?: string; readonly command: string } | undefined {
  const match = /^(\/start(?:@[A-Za-z0-9_]+)?)(?:\s+([\s\S]+))?$/.exec(
    text.trim(),
  );
  if (!match?.[1]) {
    return undefined;
  }
  return {
    command: match[1],
    ...(match[2] !== undefined ? { argument: match[2] } : {}),
  };
}

function readLinkToken(
  message: Record<string, unknown>,
): VerifiedPrivateStart["linkToken"] {
  const value = message[LINK_TOKEN_FIELD];
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.kind === "malformed") {
    return { kind: "malformed" };
  }
  if (
    value.kind === "digest" &&
    typeof value.digest === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.digest)
  ) {
    return { digest: value.digest, kind: "digest" };
  }
  return { kind: "malformed" };
}

function telegramId(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return undefined;
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
