import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_PROOF_CAPTURE_PATH,
  CREDENTIAL_PROOF_EVIDENCE_PATH,
  runCredentialedProofCommand,
  validateBotIdentity,
  validateChatAdministration,
  validateChatDemotion,
  validateCredentialedProofDatabaseUrl,
  validateReconciliationRepair,
  validateRecordedMembershipNormalization,
  validateWebhookInfo,
  validateWebhookUrl,
} from "../../src/operations/credentialed-proof.js";

describe("credentialed Telegram proof redaction", () => {
  it("pins private output paths and archives evidence at a safe re-run boundary", async () => {
    expect(CREDENTIAL_PROOF_CAPTURE_PATH).toBe(".credentialed-proof/chat-id");
    expect(CREDENTIAL_PROOF_EVIDENCE_PATH).toBe(
      ".credentialed-proof/evidence.json",
    );
    const directory = await mkdtemp(join(tmpdir(), "inside-proof-"));
    const evidencePath = join(directory, "evidence.json");
    const environment = {
      botId: "123",
      botIdentity: "inside",
      botToken: "unused",
      botUsername: "inside_bot",
      capturePath: join(directory, "chat-id"),
      evidencePath,
    };
    try {
      await runCredentialedProofCommand("begin-proof-run", environment);
      await runCredentialedProofCommand("begin-proof-run", environment);
      expect(JSON.parse(await readFile(evidencePath, "utf8"))).toMatchObject({
        observations: { proofRun: { started: true } },
      });
      await expect(readdir(join(directory, "archive"))).resolves.toHaveLength(
        1,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

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
      inheritedMemberRights: {
        can_change_info: false,
        can_invite_users: false,
        can_manage_topics: false,
        can_pin_messages: false,
      },
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

  it("does not mistake global member permissions for elevated administrator rights", () => {
    expect(
      validateChatAdministration(
        {
          permissions: {
            can_change_info: true,
            can_pin_messages: true,
          },
          type: "supergroup",
        },
        {
          can_change_info: true,
          can_manage_chat: true,
          can_pin_messages: true,
          status: "administrator",
        },
        true,
      ),
    ).toMatchObject({
      assignableRights: {
        can_change_info: false,
        can_pin_messages: false,
      },
      inheritedMemberRights: {
        can_change_info: true,
        can_pin_messages: true,
      },
    });
  });

  it("rejects elevated assignable admin rights and captures a separate demotion", () => {
    expect(() =>
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
    ).toThrow(/elevated client-assignable/u);
    expect(validateChatDemotion({ status: "member" })).toEqual({
      botIsAdministrator: false,
      botStatus: "member",
    });
    expect(() => validateChatDemotion({ status: "administrator" })).toThrow(
      /not been demoted/u,
    );
  });

  it("records owner acceptance of observed administrator rights for a disposable proof chat", () => {
    expect(
      validateChatAdministration(
        { id: -100123, type: "supergroup" },
        {
          can_delete_messages: true,
          can_manage_chat: true,
          can_restrict_members: true,
          status: "administrator",
        },
        true,
        true,
      ),
    ).toMatchObject({
      assignableRights: {
        can_delete_messages: true,
        can_restrict_members: true,
      },
      observedAdminRightsAcceptedByOwner: true,
    });
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
      lastErrorIsHttp503: false,
      pendingUpdates: 0,
      urlMatches: true,
    });
    expect(() =>
      validateWebhookInfo(
        { allowed_updates: ["message"], url: "https://proof.example/telegram" },
        "https://proof.example/telegram",
      ),
    ).toThrow(/allowed_updates/u);
    expect(
      validateWebhookInfo(
        {
          allowed_updates: ["message", "my_chat_member", "chat_member"],
          last_error_date: 1_900_000_000,
          last_error_message:
            "Wrong response from the webhook: 503 Service Unavailable",
          pending_update_count: 1,
          url: "https://proof.example/telegram",
        },
        "https://proof.example/telegram",
      ),
    ).toMatchObject({
      hasLastError: true,
      lastErrorIsHttp503: true,
      pendingUpdates: 1,
    });
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

  it("accepts only exact loopback proof database URLs without routing overrides", () => {
    expect(
      validateCredentialedProofDatabaseUrl(
        "postgresql://inside:inside@127.0.0.1:5433/inside_telegram_issue9",
      ),
    ).toContain("inside_telegram_issue9");
    expect(
      validateCredentialedProofDatabaseUrl(
        "postgres://inside:inside@[::1]:5433/telegram_proof",
      ),
    ).toContain("telegram_proof");
    for (const value of [
      "postgresql://inside:inside@127.0.0.1:5433/inside_telegram_issue9?host=production.example.com",
      "postgresql://inside:inside@127.0.0.1:5433/inside_telegram_issue9?sslmode=require",
      "postgresql://inside:inside@127.0.0.1:5433/inside_telegram_issue9#production",
      "postgresql://inside:inside@production.example.com/inside_telegram_issue9",
      "https://127.0.0.1/inside_telegram_issue9",
      "postgresql://inside:inside@127.0.0.1:5433/inside_telegram",
    ]) {
      expect(() => validateCredentialedProofDatabaseUrl(value)).toThrow(
        /isolated loopback/u,
      );
    }
  });

  it("correlates normalization and requires reconciliation to supersede positive evidence", () => {
    expect(
      validateRecordedMembershipNormalization({
        normalized_state: "member",
        raw_is_member: true,
        raw_status: "restricted",
      }),
    ).toBe("member");
    expect(() =>
      validateRecordedMembershipNormalization({
        normalized_state: "non_member",
        raw_is_member: true,
        raw_status: "restricted",
      }),
    ).toThrow(/normalization mismatch/u);

    const base = {
      decision: "member",
      eventDisposition: "evidence",
      eventKind: "subject",
      freshnessBounded: true,
      freshnessObserved: true,
      identityFingerprint: "abc123def456",
      isCurrentRevision: false,
      mappingObserved: true,
      normalizedState: "member",
      rawIsMember: null,
      rawStatus: "member",
      revision: "1",
      sequence: 1,
      source: "member_status_event",
      validitySeconds: 300,
    } as const;
    const repaired = {
      ...base,
      decision: "not_member",
      isCurrentRevision: true,
      normalizedState: "non_member",
      rawStatus: "left",
      revision: "2",
      sequence: 2,
      source: "reconciliation",
    } as const;
    const removed = {
      ...base,
      decision: "not_member",
      isCurrentRevision: true,
      normalizedState: "non_member",
      rawStatus: "left",
      revision: "0",
      sequence: 0,
    } as const;
    const rejoined = { ...base, isCurrentRevision: true } as const;
    expect(() =>
      validateReconciliationRepair(
        [base, repaired],
        [removed],
        [rejoined],
        [rejoined],
      ),
    ).not.toThrow();
    expect(() =>
      validateReconciliationRepair(
        [base, { ...repaired, isCurrentRevision: false }],
        [removed],
        [rejoined],
        [rejoined],
      ),
    ).toThrow(/did not supersede/u);
    expect(() =>
      validateReconciliationRepair(
        [base, repaired],
        [removed],
        [rejoined],
        [{ ...rejoined, revision: "2" }],
      ),
    ).toThrow(/did not supersede/u);
    expect(() =>
      validateReconciliationRepair(
        [base, { ...repaired, identityFingerprint: "other1234567" }],
        [removed],
        [rejoined],
        [rejoined],
      ),
    ).toThrow(/did not supersede/u);
  });
});
