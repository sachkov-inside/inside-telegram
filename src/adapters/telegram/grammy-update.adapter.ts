import { createHash } from "node:crypto";

import type { Update } from "grammy/types";

import type {
  VerifiedPrivateContactability,
  VerifiedPrivateStart,
} from "../../modules/bot-contacts/bot-contacts.js";
import type { CommunityJoinRequest } from "../../modules/community/community-provider.js";
import type { DurableMembershipEnvelope } from "../../modules/membership-evidence/membership-evidence-provider.js";
import type { VerifiedSignInDecision } from "../../modules/bot-sign-in/bot-sign-in.js";
import { toTelegramChatMember } from "./grammy-membership.adapter.js";

export type TelegramUpdateCommand =
  | {
      readonly kind: "sign-in-decision";
      readonly value: VerifiedSignInDecision;
      readonly callbackQueryId: string;
    }
  | {
      readonly kind: "marketing_preference";
      readonly value: {
        readonly contact: VerifiedPrivateStart;
        readonly enabled: boolean;
      };
    }
  | {
      readonly kind: "contactability";
      readonly value: VerifiedPrivateContactability;
    }
  | { readonly kind: "ignored" }
  | { readonly kind: "membership"; readonly value: DurableMembershipEnvelope }
  | { readonly kind: "join-request"; readonly value: CommunityJoinRequest }
  | {
      readonly kind: "community-request";
      readonly value: VerifiedPrivateStart;
    }
  | {
      readonly kind: "start";
      readonly value: {
        readonly contact: VerifiedPrivateStart;
        readonly signInToken?:
          | { readonly digest: string; readonly kind: "digest" }
          | { readonly kind: "malformed" };
        readonly marketingSource?: string;
        readonly linkToken?:
          | { readonly digest: string; readonly kind: "digest" }
          | { readonly kind: "malformed" };
      };
    };

const LINK_TOKEN_FIELD = "_inside_link_token";
const SIGN_IN_TOKEN_FIELD = "_inside_sign_in_token";

export function prepareTelegramUpdateForInbox(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.message)) {
    return payload;
  }

  const message = { ...payload.message };
  delete message[LINK_TOKEN_FIELD];
  delete message[SIGN_IN_TOKEN_FIELD];
  delete message._inside_marketing_source;
  const text = message.text;
  if (typeof text !== "string") {
    return { ...payload, message };
  }

  const start = parseStart(text);
  if (!start || start.argument === undefined) {
    return { ...payload, message };
  }

  // Never reinterpret any legacy auth token, including ones starting with m_.
  if (start.argument.startsWith("m_") && start.argument.length < 43) {
    return {
      ...payload,
      message: {
        ...message,
        text: start.command,
        _inside_marketing_source: start.argument,
      },
    };
  }
  // Legacy linking accepts every base64url payload of 43–64 characters, including this prefix.
  // Reserve a shorter namespace so existing valid link tokens keep their exact meaning.
  const signIn =
    start.argument.startsWith("signin_") && start.argument.length < 43;
  const argument = signIn ? start.argument.slice(7) : start.argument;
  const valid = signIn
    ? /^[A-Za-z0-9_-]{35}$/.test(argument)
    : /^[A-Za-z0-9_-]{43,64}$/.test(argument);
  const linkToken = valid
    ? {
        digest: createHash("sha256").update(argument).digest("base64url"),
        kind: "digest" as const,
      }
    : { kind: "malformed" as const };

  return {
    ...payload,
    message: {
      ...message,
      [signIn ? SIGN_IN_TOKEN_FIELD : LINK_TOKEN_FIELD]: linkToken,
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
    const decision = privateSignInDecision(botIdentity, update.callback_query);
    if (
      decision &&
      typeof update.callback_query?.id === "string" &&
      update.callback_query.id.length <= 128
    )
      return {
        kind: "sign-in-decision",
        value: decision,
        callbackQueryId: update.callback_query.id,
      };
    const admission = /^\/community(?:@[A-Za-z0-9_]+)?$/.test(
      typeof update.message?.text === "string"
        ? update.message.text.trim()
        : "",
    );
    if (admission) {
      // The contact asks for their own admission; nobody else selects a recipient.
      const privateCommand = this.privateStart(
        botIdentity,
        updateId,
        { ...update, message: { ...update.message!, text: "/start" } },
        observedAt,
      );
      if (privateCommand)
        return { kind: "community-request", value: privateCommand.contact };
    }
    const preference = /^(\/stop|\/resume)(?:@[A-Za-z0-9_]+)?$/.exec(
      typeof update.message?.text === "string"
        ? update.message.text.trim()
        : "",
    );
    if (preference) {
      const privateCommand = this.privateStart(
        botIdentity,
        updateId,
        { ...update, message: { ...update.message!, text: "/start" } },
        observedAt,
      );
      if (privateCommand)
        return {
          kind: "marketing_preference",
          value: {
            contact: privateCommand.contact,
            enabled: preference[1] === "/resume",
          },
        };
    }
    const start = this.privateStart(botIdentity, updateId, update, observedAt);
    if (start) {
      return { kind: "start", value: start };
    }

    const joinRequest = this.joinRequest(botIdentity, updateId, update);
    if (joinRequest) {
      return { kind: "join-request", value: joinRequest };
    }

    const subjectMembership = this.subjectMembershipEvent(
      botIdentity,
      updateId,
      update,
    );
    if (subjectMembership) {
      return { kind: "membership", value: subjectMembership };
    }

    const providerMembership = this.providerMembershipEvent(
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

  /** A join request identifies its own chat and requester; nothing else selects a recipient. */
  private joinRequest(
    botIdentity: string,
    updateId: string,
    update: Partial<Update>,
  ): CommunityJoinRequest | undefined {
    const request: unknown = update.chat_join_request;
    if (!isRecord(request)) {
      return undefined;
    }
    const chat = request.chat;
    const from = request.from;
    if (
      !isRecord(chat) ||
      chat.type === "private" ||
      !isRecord(from) ||
      from.is_bot !== false ||
      typeof request.date !== "number" ||
      !Number.isSafeInteger(request.date) ||
      request.date < 0
    ) {
      return undefined;
    }
    const canonicalChatId = signedTelegramId(chat.id);
    const telegramUserId = telegramId(from.id);
    if (!canonicalChatId || !telegramUserId) {
      return undefined;
    }
    return {
      botIdentity,
      canonicalChatId,
      telegramUserId,
      requestedAt: new Date(request.date * 1000),
      updateId,
    };
  }

  private subjectMembershipEvent(
    botIdentity: string,
    updateId: string,
    update: Partial<Update>,
  ): DurableMembershipEnvelope | undefined {
    const parsed = parseChatMemberUpdated(update.chat_member);
    if (!parsed) {
      return undefined;
    }
    const actor = parsed.update.from;
    if (!isRecord(actor)) {
      return undefined;
    }

    const actorTelegramUserId = telegramId(actor.id);
    const subjectTelegramUserId = telegramId(parsed.member.user.id);
    if (!actorTelegramUserId || !subjectTelegramUserId) {
      return undefined;
    }

    return {
      actorIsSubject: actorTelegramUserId === subjectTelegramUserId,
      botIdentity,
      canonicalChatId: parsed.chatId,
      chatMember: parsed.chatMember,
      eventAt: parsed.eventAt,
      kind: "subject",
      subjectTelegramUserId,
      updateId,
    };
  }

  private providerMembershipEvent(
    botIdentity: string,
    updateId: string,
    update: Partial<Update>,
  ): Extract<DurableMembershipEnvelope, { kind: "provider" }> | undefined {
    const parsed = parseChatMemberUpdated(update.my_chat_member);
    if (!parsed) {
      return undefined;
    }
    if (parsed.chat.type === "private" || parsed.member.user.is_bot !== true) {
      return undefined;
    }
    return {
      botIdentity,
      canonicalChatId: parsed.chatId,
      chatMember: parsed.chatMember,
      eventAt: parsed.eventAt,
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
    const signInToken = readLinkToken(message, SIGN_IN_TOKEN_FIELD);
    return {
      contact: {
        botIdentity,
        observedAt,
        privateChatId,
        telegramUserId,
        updateId,
      },
      ...(linkToken ? { linkToken } : {}),
      ...(signInToken ? { signInToken } : {}),
      ...(typeof message._inside_marketing_source === "string"
        ? { marketingSource: message._inside_marketing_source }
        : {}),
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
  field = LINK_TOKEN_FIELD,
): Extract<TelegramUpdateCommand, { kind: "start" }>["value"]["linkToken"] {
  const value = message[field];
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

function privateSignInDecision(
  botIdentity: string,
  value: unknown,
): VerifiedSignInDecision | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.from) ||
    value.from.is_bot !== false ||
    !isRecord(value.message) ||
    !isRecord(value.message.chat) ||
    value.message.chat.type !== "private" ||
    typeof value.data !== "string"
  )
    return undefined;
  const match =
    /^signin:(approve|deny):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
      value.data,
    );
  const telegramUserId = telegramId(value.from.id);
  const privateChatId = telegramId(value.message.chat.id);
  const messageId = telegramId(value.message.message_id);
  if (
    !match ||
    !telegramUserId ||
    !privateChatId ||
    !messageId ||
    telegramUserId !== privateChatId
  )
    return undefined;
  return {
    botIdentity,
    telegramUserId,
    privateChatId,
    messageId,
    requestRef: match[2]!,
    decision: match[1] === "approve" ? "approve" : "deny",
  };
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

interface ParsedChatMemberUpdated {
  readonly chat: Record<string, unknown>;
  readonly chatId: string;
  readonly chatMember: ReturnType<typeof toTelegramChatMember>;
  readonly eventAt: Date;
  readonly member: Record<string, unknown> & {
    readonly user: Record<string, unknown>;
  };
  readonly update: Record<string, unknown>;
}

function parseChatMemberUpdated(
  value: unknown,
): ParsedChatMemberUpdated | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const chat = value.chat;
  const member = value.new_chat_member;
  if (
    !isRecord(chat) ||
    !isRecord(member) ||
    !isRecord(member.user) ||
    typeof member.status !== "string" ||
    typeof value.date !== "number" ||
    !Number.isSafeInteger(value.date) ||
    value.date < 0
  ) {
    return undefined;
  }
  const chatId = signedTelegramId(chat.id);
  if (!chatId) {
    return undefined;
  }
  return {
    chat,
    chatId,
    chatMember: toTelegramChatMember({
      ...(typeof member.is_member === "boolean"
        ? { is_member: member.is_member }
        : {}),
      status: member.status,
    }),
    eventAt: new Date(value.date * 1000),
    member: { ...member, user: member.user },
    update: value,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
