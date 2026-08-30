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
