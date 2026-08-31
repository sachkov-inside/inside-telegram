export interface StartOptions {
  chatType?: string;
  isBot?: boolean;
  omitSender?: boolean;
  text?: string;
}

export function privateStartUpdate(
  updateId: number,
  userId: number,
  options: StartOptions = {},
) {
  return {
    update_id: updateId,
    message: {
      chat: { id: userId, type: options.chatType ?? "private" },
      ...(!options.omitSender
        ? { from: { id: userId, is_bot: options.isBot ?? false } }
        : {}),
      message_id: updateId,
      text: options.text ?? "/start",
    },
  };
}

export function privateContactabilityUpdate(
  updateId: number,
  userId: number,
  status: "kicked" | "member",
) {
  return {
    update_id: updateId,
    my_chat_member: {
      chat: { id: userId, type: "private" },
      from: { id: userId, is_bot: false },
      new_chat_member: { status },
      old_chat_member: { status: status === "kicked" ? "member" : "kicked" },
    },
  };
}

export function canonicalMembershipUpdate(
  updateId: number,
  chatId: number,
  subjectUserId: number,
  status: string,
  options: { actorUserId?: number; date?: number; isMember?: boolean } = {},
) {
  return {
    update_id: updateId,
    chat_member: {
      chat: { id: chatId, type: "supergroup" },
      date: options.date ?? 1_893_456_060,
      from: {
        id: options.actorUserId ?? 777,
        is_bot: false,
      },
      new_chat_member: {
        ...(options.isMember === undefined
          ? {}
          : { is_member: options.isMember }),
        status,
        user: { id: subjectUserId, is_bot: false },
      },
      old_chat_member: {
        status: status === "member" ? "left" : "member",
        user: { id: subjectUserId, is_bot: false },
      },
    },
  };
}

export function canonicalProviderMembershipUpdate(
  updateId: number,
  chatId: number,
  botUserId: number,
  status: string,
  options: { actorUserId?: number; date?: number } = {},
) {
  return {
    update_id: updateId,
    my_chat_member: {
      chat: { id: chatId, type: "supergroup" },
      date: options.date ?? 1_893_456_120,
      from: { id: options.actorUserId ?? 777, is_bot: false },
      new_chat_member: {
        status,
        user: { id: botUserId, is_bot: true },
      },
      old_chat_member: {
        status: status === "administrator" ? "member" : "administrator",
        user: { id: botUserId, is_bot: true },
      },
    },
  };
}
