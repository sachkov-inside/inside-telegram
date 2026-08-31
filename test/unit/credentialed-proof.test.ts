import { describe, expect, it } from "vitest";

import {
  validateBotIdentity,
  validateChatAdministration,
  validateChatDemotion,
  validateWebhookInfo,
  validateWebhookUrl,
} from "../../src/operations/credentialed-proof.js";

describe("credentialed Telegram proof redaction", () => {
  it("validates getMe without returning provider identifiers", () => {
    expect(
      validateBotIdentity(
        { first_name: "Inside", id: 123, is_bot: true, username: "inside_bot" },
        "123",
        "inside_bot",
      ),
    ).toEqual({ idMatches: true, isBot: true, usernameMatches: true });
    expect(() =>
      validateBotIdentity(
        { id: 124, is_bot: true, username: "other_bot" },
        "123",
        "inside_bot",
      ),
    ).toThrow(/configured dedicated bot/u);
  });

  it("requires a closed-chat-compatible type and administrator status", () => {
    expect(
      validateChatAdministration(
        { id: -100123, title: "Private proof", type: "supergroup" },
        {
          can_manage_chat: true,
          status: "administrator",
          user: { id: 123 },
        },
        true,
      ),
    ).toEqual({
      assignableRights: {
        can_change_info: false,
        can_delete_messages: false,
        can_delete_stories: false,
        can_edit_messages: false,
        can_edit_stories: false,
        can_invite_users: false,
        can_manage_direct_messages: false,
        can_manage_tags: false,
        can_manage_topics: false,
        can_manage_video_chats: false,
        can_pin_messages: false,
        can_post_messages: false,
        can_post_stories: false,
        can_promote_members: false,
        can_restrict_members: false,
        can_send_welcome_messages: false,
        is_anonymous: false,
      },
      botStatus: "administrator",
      chatType: "supergroup",
      impliedManageChat: true,
      minimumClientConfigurationConfirmed: true,
    });
    expect(() =>
      validateChatAdministration(
        { id: -100123, type: "channel" },
        { status: "member", user: { id: 123 } },
        true,
      ),
    ).toThrow(/group or supergroup/u);
    expect(() =>
      validateChatAdministration(
        { id: -100123, type: "supergroup" },
        { can_manage_chat: true, status: "administrator" },
        false,
      ),
    ).toThrow(/not confirmed/u);
  });

  it("captures current assignable admin rights and a separate demotion", () => {
    expect(
      validateChatAdministration(
        { id: -100123, type: "supergroup" },
        {
          can_manage_chat: true,
          can_manage_direct_messages: true,
          can_manage_tags: true,
          can_post_stories: true,
          can_send_welcome_messages: true,
          status: "administrator",
        },
        true,
      ),
    ).toMatchObject({
      assignableRights: {
        can_manage_direct_messages: true,
        can_manage_tags: true,
        can_post_stories: true,
        can_send_welcome_messages: true,
      },
      impliedManageChat: true,
    });
    expect(validateChatDemotion({ status: "member" })).toEqual({
      botIsAdministrator: false,
      botStatus: "member",
    });
    expect(() => validateChatDemotion({ status: "administrator" })).toThrow(
      /not been demoted/u,
    );
  });

  it("requires the exact callback and allowed update vocabulary", () => {
    expect(
      validateWebhookInfo(
        {
          allowed_updates: ["message", "my_chat_member", "chat_member"],
          has_custom_certificate: false,
          pending_update_count: 0,
          url: "https://proof.example/telegram",
        },
        "https://proof.example/telegram",
      ),
    ).toEqual({
      allowedUpdatesMatch: true,
      hasCustomCertificate: false,
      hasLastError: false,
      pendingUpdates: 0,
      urlMatches: true,
    });
    expect(() =>
      validateWebhookInfo(
        { allowed_updates: ["message"], url: "https://proof.example/telegram" },
        "https://proof.example/telegram",
      ),
    ).toThrow(/allowed_updates/u);
  });

  it("rejects callback ports outside the Telegram webhook contract", () => {
    expect(validateWebhookUrl("https://proof.example/telegram")).toBe(
      "https://proof.example/telegram",
    );
    expect(validateWebhookUrl("https://proof.example:8443/telegram")).toBe(
      "https://proof.example:8443/telegram",
    );
    expect(() =>
      validateWebhookUrl("https://proof.example:444/telegram"),
    ).toThrow(/Telegram-supported port/u);
  });
});
