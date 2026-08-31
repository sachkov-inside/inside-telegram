import { createHash } from "node:crypto";

import type { Update } from "grammy/types";

import type {
  VerifiedPrivateContactability,
  VerifiedPrivateStart,
} from "../../modules/bot-contacts/bot-contacts.js";
import type { DurableMembershipEnvelope } from "../../modules/membership-evidence/membership-evidence-provider.js";
import { toTelegramChatMember } from "./grammy-membership.adapter.js";

export type TelegramUpdateCommand =
  | {
      readonly kind: "contactability";
      readonly value: VerifiedPrivateContactability;
    }
  | { readonly kind: "ignored" }
  | { readonly kind: "membership"; readonly value: DurableMembershipEnvelope }
  | {
      readonly kind: "start";
      readonly value: {
        readonly contact: VerifiedPrivateStart;
        readonly linkToken?:
          | { readonly digest: string; readonly kind: "digest" }
          | { readonly kind: "malformed" };
      };
    };

const LINK_TOKEN_FIELD = "_inside_link_token";

export function prepareTelegramUpdateForInbox(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.message)) {
    return payload;
  }

  const message = { ...payload.message };
  delete message[LINK_TOKEN_FIELD];
  const text = message.text;
  if (typeof text !== "string") {
    return { ...payload, message };
  }

  const start = parseStart(text);
  if (!start || start.argument === undefined) {
    return { ...payload, message };
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
      ...message,
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

    const membership = this.membership(botIdentity, updateId, update);
    if (membership) {
      return { kind: "membership", value: membership };
    }

    const providerMembership = this.providerMembership(
      botIdentity,
      updateId,
      update,
    );
    if (providerMembership) {
      return { kind: "membership", value: providerMembership };
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

  private membership(
    botIdentity: string,
    updateId: string,
    update: Partial<Update>,
  ): DurableMembershipEnvelope | undefined {
    const membershipUpdate: unknown = update.chat_member;
    if (!isRecord(membershipUpdate)) {
      return undefined;
    }
    const chat = membershipUpdate.chat;
    const actor = membershipUpdate.from;
    const newChatMember = membershipUpdate.new_chat_member;
    if (
      !isRecord(chat) ||
      !isRecord(actor) ||
      !isRecord(newChatMember) ||
      !isRecord(newChatMember.user) ||
      typeof newChatMember.status !== "string" ||
      typeof membershipUpdate.date !== "number" ||
      !Number.isSafeInteger(membershipUpdate.date) ||
      membershipUpdate.date < 0
    ) {
      return undefined;
    }

    const canonicalChatId = signedTelegramId(chat.id);
    const actorTelegramUserId = telegramId(actor.id);
    const subjectTelegramUserId = telegramId(newChatMember.user.id);
    if (!canonicalChatId || !actorTelegramUserId || !subjectTelegramUserId) {
      return undefined;
    }

    return {
      actorIsSubject: actorTelegramUserId === subjectTelegramUserId,
      botIdentity,
      canonicalChatId,
      chatMember: toTelegramChatMember({
        ...(typeof newChatMember.is_member === "boolean"
          ? { is_member: newChatMember.is_member }
          : {}),
        status: newChatMember.status,
      }),
      eventAt: new Date(membershipUpdate.date * 1000),
      kind: "subject",
      subjectTelegramUserId,
      updateId,
    };
  }

  private providerMembership(
    botIdentity: string,
    updateId: string,
    update: Partial<Update>,
  ): Extract<DurableMembershipEnvelope, { kind: "provider" }> | undefined {
    const membershipUpdate: unknown = update.my_chat_member;
    if (!isRecord(membershipUpdate)) {
      return undefined;
    }
    const chat = membershipUpdate.chat;
    const newChatMember = membershipUpdate.new_chat_member;
    if (
      !isRecord(chat) ||
      chat.type === "private" ||
      !isRecord(newChatMember) ||
      !isRecord(newChatMember.user) ||
      newChatMember.user.is_bot !== true ||
      typeof newChatMember.status !== "string" ||
      typeof membershipUpdate.date !== "number" ||
      !Number.isSafeInteger(membershipUpdate.date) ||
      membershipUpdate.date < 0
    ) {
      return undefined;
    }
    const canonicalChatId = signedTelegramId(chat.id);
    if (!canonicalChatId) {
      return undefined;
    }
    return {
      botIdentity,
      canonicalChatId,
      chatMember: toTelegramChatMember({
        ...(typeof newChatMember.is_member === "boolean"
          ? { is_member: newChatMember.is_member }
          : {}),
        status: newChatMember.status,
      }),
      eventAt: new Date(membershipUpdate.date * 1000),
      kind: "provider",
      updateId,
    };
  }

  private privateStart(
    botIdentity: string,
    updateId: string,
    update: Partial<Update>,
    observedAt: Date,
  ): Extract<TelegramUpdateCommand, { kind: "start" }>["value"] | undefined {
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
      typeof message.text !== "string"
    ) {
      return undefined;
    }
    const start = parseStart(message.text);
    if (!start || start.argument !== undefined) {
      return undefined;
    }

    const telegramUserId = telegramId(from.id);
    const privateChatId = telegramId(chat.id);
    if (!telegramUserId || !privateChatId) {
      return undefined;
    }

    const linkToken = readLinkToken(message);
    return {
      contact: {
        botIdentity,
        observedAt,
        privateChatId,
        telegramUserId,
        updateId,
      },
      ...(linkToken ? { linkToken } : {}),
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
): Extract<TelegramUpdateCommand, { kind: "start" }>["value"]["linkToken"] {
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

function signedTelegramId(value: unknown): string | undefined {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value === 0
  ) {
    return undefined;
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
