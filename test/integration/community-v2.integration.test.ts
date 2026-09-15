import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/database/create-database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import { CommunityProvider } from "../../src/modules/community/community-provider.js";
import { CommunityRestrictions } from "../../src/modules/community/community-restrictions.js";
import {
  COMMUNITY_V2,
  type CommunitySetCommand,
  type DispatchAuthorizationRequest,
  type DispatchAuthorizationResponse,
} from "../../src/modules/community/community-contract.js";
import { StartResponseDeliveryQueue } from "../../src/modules/outbound/start-response-delivery-queue.js";
import { digest } from "../../src/security/payload-digest.js";
import { seedCommunityBinding } from "../support/community-binding.js";
import { FakeCommunityChat } from "../support/community-chat.js";
const db = createDatabase(process.env.DATABASE_URL!);
beforeAll(async () => {
  await migrateToLatest(db);
});
afterAll(async () => {
  await db.destroy();
});
async function stand(
  options: {
    readonly removalsEnabled?: boolean;
    readonly tributeBotTelegramUserId?: string;
  } = {},
) {
  const bot = `v2-${randomUUID()}`;
  const user = "70099";
  const clock = {
    value: new Date(),
    now() {
      return new Date(this.value);
    },
  };
  const chat = new FakeCommunityChat();
  const binding = {
    accountRef: randomUUID(),
    telegramIdentityRef: randomUUID(),
    linkRef: randomUUID(),
    linkRevision: 2,
  };
  await seedCommunityBinding(db, binding, clock.now(), user, bot);
  const commands = new Map<string, CommunitySetCommand>();
  const requests: DispatchAuthorizationRequest[] = [];
  const auth = {
    async authorize(
      request: DispatchAuthorizationRequest,
    ): Promise<DispatchAuthorizationResponse> {
      requests.push(request);
      const command = commands.get(request.dispatchId)!;
      return {
        contractVersion: "inside.billing-dispatch.v1",
        operation: "dispatch.result",
        operationId: request.operationId,
        attemptId: request.attemptId,
        dispatchId: request.dispatchId,
        decision:
          request.dispatchContractVersion === command.contractVersion &&
          request.payloadDigest === digest(command)
            ? {
                status: "allowed",
                permitRef: randomUUID(),
                validUntil: new Date(
                  clock.now().getTime() + 5000,
                ).toISOString(),
              }
            : { status: "denied", reason: "payload_conflict" },
      };
    },
  };
  const provider = () =>
    new CommunityProvider(db, bot, "-1000000000000", clock, auth, chat, {
      contractVersion: COMMUNITY_V2,
      removalsEnabled: options.removalsEnabled ?? true,
      botTelegramUserId: "1234",
      ...(options.tributeBotTelegramUserId
        ? {
            tributeBotTelegramUserId: options.tributeBotTelegramUserId,
            readmission: {
              replies: new StartResponseDeliveryQueue(db),
              text: "Synthetic readmission",
            },
          }
        : {}),
    });
  let revision = 0;
  async function set(
    access: CommunitySetCommand["access"] = { kind: "lifetime" },
    modify: Partial<CommunitySetCommand> = {},
  ) {
    const command: CommunitySetCommand = {
      contractVersion: COMMUNITY_V2,
      operation: "entitlement.set",
      operationId: randomUUID(),
      correlationRef: randomUUID(),
      entitlementRevision: ++revision,
      binding,
      access,
      issuedAt: clock.now().toISOString(),
      ...modify,
    };
    commands.set(command.operationId.toLowerCase(), command);
    const response = await provider().handle(command);
    expect(response.status).toBe(200);
    return command;
  }
  const row = () =>
    db
      .selectFrom("community_desired_states")
      .selectAll()
      .where("bot_identity", "=", bot)
      .executeTakeFirstOrThrow();
  return {
    bot,
    user,
    clock,
    chat,
    binding,
    commands,
    requests,
    provider,
    set,
    row,
  };
}
describe("community v2 exact target, moderation and durable effects", () => {
  it("uses exact v2 wire digest including UUID spelling and reads historical v1 receipts", async () => {
    const s = await stand();
    const old: CommunitySetCommand = {
      contractVersion: "inside.community-entitlement.v1",
      operation: "entitlement.set",
      operationId: randomUUID(),
      correlationRef: randomUUID(),
      entitlementRevision: 1,
      binding: s.binding,
      access: { kind: "lifetime" },
      issuedAt: s.clock.now().toISOString(),
    };
    const legacy = new CommunityProvider(
      db,
      s.bot,
      "-1000000000000",
      s.clock,
      {
        async authorize() {
          return;
        },
      },
      s.chat,
    );
    expect((await legacy.handle(old)).status).toBe(200);
    await s.provider().processDueEffects();
    expect(s.chat.calls).toHaveLength(0);
    expect(
      (
        await s.provider().handle({
          contractVersion: old.contractVersion,
          operation: "entitlement.status",
          operationId: old.operationId,
        })
      ).body,
    ).toMatchObject({ contractVersion: old.contractVersion });
    expect((await s.provider().handle(old)).status).toBe(422);
    await s.set(
      { kind: "lifetime" },
      {
        operationId: randomUUID().toUpperCase(),
        correlationRef: randomUUID().toUpperCase(),
        binding: { ...s.binding, linkRef: s.binding.linkRef.toUpperCase() },
      },
    );
    await s.provider().processDueEffects();
    expect(s.chat.count("create_invite")).toBe(1);
    expect(s.requests.at(-1)?.dispatchContractVersion).toBe(COMMUNITY_V2);
  });
  it("does not clear an external or moderator ban on a new right", async () => {
    const s = await stand();
    s.chat.membership = "banned";
    await s.set();
    await s.provider().processDueEffects();
    expect((await s.row()).admission_restriction).toBe("external_unknown");
    expect(s.chat.count("unban")).toBe(0);
    await s.set();
    await s.provider().processDueEffects();
    expect(s.chat.count("unban")).toBe(0);
    expect(await s.provider().admissionFor(s.user)).toEqual({
      kind: "moderation_blocked",
    });
  });
  it("restores only a positively recorded own removal, then forgets that provenance", async () => {
    const s = await stand();
    s.chat.membership = "member";
    await s.set({ kind: "denied" });
    await s.provider().processDueEffects();
    expect(s.chat.count("ban")).toBe(1);
    expect((await s.row()).removal_origin).toBe("bot_expiry");
    await s.set();
    await s.provider().processDueEffects();
    expect(s.chat.count("unban")).toBe(1);
    await s.provider().processDueEffects();
    s.clock.value = new Date(s.clock.now().getTime() + 1000);
    await s.provider().observeMembershipEvent({
      kind: "subject",
      botIdentity: s.bot,
      canonicalChatId: "-1000000000000",
      subjectTelegramUserId: s.user,
      actorIsSubject: false,
      actorIsBot: false,
      actorTelegramUserId: "998",
      chatMember: { status: "kicked" },
      eventAt: s.clock.now(),
      updateId: "989",
    });
    s.chat.membership = "banned";
    await s.set();
    await s.provider().processDueEffects();
    expect((await s.row()).admission_restriction).toBe("moderation");
    expect(s.chat.count("unban")).toBe(1);
  });
  it("keeps unknown ban outcomes restricted and requires an audited decision to restore", async () => {
    const s = await stand();
    s.chat.membership = "member";
    s.chat.mutation = { kind: "unknown" };
    await s.set({ kind: "denied" });
    await s.provider().processDueEffects();
    s.chat.membership = "banned";
    s.chat.mutation = { kind: "succeeded" };
    await s.set();
    await s.provider().processDueEffects();
    expect(s.chat.count("unban")).toBe(0);
    const row = await s.row();
    const input = {
      operationId: randomUUID(),
      botIdentity: s.bot,
      accountRef: s.binding.accountRef,
      identityRef: s.binding.telegramIdentityRef,
      expectedRevision: Number(row.restriction_revision),
      action: "restore" as const,
      actorRef: "synthetic-owner",
      reason: "Synthetic authorized restoration",
    };
    const restrictions = new CommunityRestrictions(db, s.clock);
    expect(await restrictions.decide(input, false)).toBe("ready");
    expect(await restrictions.decide(input, true)).toBe("applied");
    expect(await restrictions.decide(input, true)).toBe("duplicate");
    await s.provider().reconcileDueStates();
    await s.provider().processDueEffects();
    expect(s.chat.count("unban")).toBe(1);
  });
  it("preserves a reconstructable restore audit after a new hold and conflicting retries", async () => {
    const s = await stand();
    const command = await s.set();
    const restrictions = new CommunityRestrictions(db, s.clock);
    const input = {
      operationId: randomUUID(),
      botIdentity: s.bot,
      accountRef: s.binding.accountRef,
      identityRef: s.binding.telegramIdentityRef,
      expectedRevision: 0,
      action: "hold" as const,
      actorRef: "synthetic-owner",
      reason: "Synthetic moderation decision",
    };
    const audit = (operationId: string) =>
      db
        .selectFrom("community_restriction_decisions")
        .selectAll()
        .where("operation_id", "=", operationId)
        .executeTakeFirst();
    expect(await restrictions.decide(input, false)).toBe("ready");
    expect(await audit(input.operationId)).toBeUndefined();
    expect(await restrictions.decide(input, true)).toBe("applied");
    const restore = {
      ...input,
      operationId: randomUUID(),
      expectedRevision: 1,
      action: "restore" as const,
      reason: "Synthetic authorized restoration",
    };
    const before = await s.row();
    expect(await restrictions.decide(restore, true)).toBe("applied");
    const restored = await audit(restore.operationId);
    expect(restored).toEqual({
      operation_id: restore.operationId,
      fingerprint: digest(restore),
      actor_ref: restore.actorRef,
      reason: restore.reason,
      created_at: s.clock.now(),
      audit: {
        version: 1,
        target: {
          botIdentity: s.bot,
          accountRef: s.binding.accountRef,
          identityRef: s.binding.telegramIdentityRef,
          linkRef: s.binding.linkRef,
          linkRevision: "2",
        },
        action: "restore",
        expectedRevision: 1,
        appliedRevision: 2,
        before: {
          admissionRestriction: "moderation",
          removalOrigin: "external_unknown",
          confirmedBanAttemptId: before.confirmed_ban_attempt_id,
          status: "failed",
        },
        after: {
          admissionRestriction: "none",
          removalOrigin: "operator_restore",
          confirmedBanAttemptId: null,
          status: "accepted",
        },
        communityOperation: {
          operationId: command.operationId,
          correlationRef: command.correlationRef,
          contractVersion: COMMUNITY_V2,
          entitlementRevision: "1",
        },
      },
    });
    await s.set(); // The current entitlement operation is no longer the audited source.
    const hold = { ...input, operationId: randomUUID(), expectedRevision: 2 };
    expect(await restrictions.decide(hold, true)).toBe("applied");
    const held = await s.row();
    expect(held.admission_restriction).toBe("moderation");
    expect(held.restriction_revision).toBe("3");
    expect(await restrictions.decide(restore, true)).toBe("duplicate");
    for (const changed of [
      { ...restore, action: "hold" as const },
      { ...restore, reason: "Changed reason" },
      { ...restore, accountRef: "another-opaque-account" },
      { ...restore, expectedRevision: 3 },
    ])
      expect(await restrictions.decide(changed, true)).toBe("conflict");
    const stale = { ...restore, operationId: randomUUID() };
    expect(await restrictions.decide(stale, true)).toBe("conflict");
    expect(await audit(stale.operationId)).toBeUndefined();
    expect(await audit(restore.operationId)).toEqual(restored);
    expect(await s.row()).toEqual(held);
    expect((await audit(hold.operationId))?.audit?.before).toEqual(
      restored?.audit?.after,
    );
  });
  it("rolls back the audit together with the restriction if its receipt update fails", async () => {
    const s = await stand();
    await s.set();
    const before = await s.row();
    const input = {
      operationId: randomUUID(),
      botIdentity: s.bot,
      accountRef: s.binding.accountRef,
      identityRef: s.binding.telegramIdentityRef,
      expectedRevision: 0,
      action: "hold" as const,
      actorRef: "synthetic-owner",
      reason: "Synthetic atomicity check",
    };
    let reads = 0;
    const restrictions = new CommunityRestrictions(db, {
      now() {
        if (++reads === 2)
          throw new Error("Synthetic failure after desired update");
        return s.clock.now();
      },
    });
    await expect(restrictions.decide(input, true)).rejects.toThrow(
      "Synthetic failure after desired update",
    );
    expect(
      await db
        .selectFrom("community_restriction_decisions")
        .selectAll()
        .where("operation_id", "=", input.operationId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(await s.row()).toEqual(before);
    expect(
      await new CommunityRestrictions(db, s.clock).decide(input, true),
    ).toBe("applied");
  });
  it("orders equal-second membership events and preserves a later moderator ban", async () => {
    const s = await stand();
    s.chat.membership = "member";
    await s.set({ kind: "denied" });
    await s.provider().processDueEffects();
    const event = {
      kind: "subject" as const,
      botIdentity: s.bot,
      canonicalChatId: "-1000000000000",
      subjectTelegramUserId: s.user,
      actorIsSubject: false,
      actorIsBot: true,
      actorTelegramUserId: "1234",
      chatMember: { status: "kicked" },
      eventAt: s.clock.now(),
      updateId: "100",
    };
    await s.provider().observeMembershipEvent(event);
    await s.provider().observeMembershipEvent({
      ...event,
      updateId: "101",
      actorIsBot: false,
      actorTelegramUserId: "998",
    });
    await s.set();
    await s.provider().processDueEffects();
    expect((await s.row()).admission_restriction).toBe("moderation");
    expect(s.chat.count("unban")).toBe(0);
  });
  it("recognizes an own ban event arriving before its HTTP acknowledgement", async () => {
    const s = await stand();
    s.chat.membership = "member";
    s.chat.banMember = async () => {
      s.chat.membership = "banned";
      await s.provider().observeMembershipEvent({
        kind: "subject",
        botIdentity: s.bot,
        canonicalChatId: "-1000000000000",
        subjectTelegramUserId: s.user,
        actorIsSubject: false,
        actorIsBot: true,
        actorTelegramUserId: "1234",
        chatMember: { status: "kicked" },
        eventAt: s.clock.now(),
        updateId: "100",
      });
      return { kind: "unknown" };
    };
    await s.set({ kind: "denied" });
    await s.provider().processDueEffects();
    expect((await s.row()).admission_restriction).toBe("none");
    expect((await s.row()).removal_origin).toBe("bot_expiry");
    await s.set();
    await s.provider().processDueEffects();
    expect(s.chat.count("unban")).toBe(1);
  });
  it("does not overwrite an operator restoration when a superseded ban settles late", async () => {
    const s = await stand();
    s.chat.membership = "member";
    s.chat.banMember = async () => {
      await s.set();
      const current = await s.row();
      expect(
        await new CommunityRestrictions(db, s.clock).decide(
          {
            operationId: randomUUID(),
            botIdentity: s.bot,
            accountRef: s.binding.accountRef,
            identityRef: s.binding.telegramIdentityRef,
            expectedRevision: Number(current.restriction_revision),
            action: "restore",
            actorRef: "synthetic-owner",
            reason: "Confirmed restore while old request settles",
          },
          true,
        ),
      ).toBe("applied");
      return { kind: "unknown" };
    };
    await s.set({ kind: "denied" });
    await s.provider().processDueEffects();
    expect((await s.row()).removal_origin).toBe("operator_restore");
    expect((await s.row()).admission_restriction).toBe("none");
  });
  it.each([
    ["banned", "effect"],
    ["not_member", "effect"],
    ["banned", "reconcile"],
    ["not_member", "reconcile"],
  ] as const)(
    "does not replace an operator restore with stale %s observation in %s",
    async (observed, path) => {
      const s = await stand();
      await s.set();
      // Prior bot-owned provenance gives the stale non-banned branch something to clear.
      await db
        .updateTable("community_desired_states")
        .set({ removal_origin: "bot_expiry" })
        .where("bot_identity", "=", s.bot)
        .execute();
      if (observed === "banned")
        await db
          .updateTable("community_desired_states")
          .set({ removal_origin: "none" })
          .where("bot_identity", "=", s.bot)
          .execute();
      s.chat.observeMember = async () => {
        const row = await s.row();
        expect(
          await new CommunityRestrictions(db, s.clock).decide(
            {
              operationId: randomUUID(),
              botIdentity: s.bot,
              accountRef: s.binding.accountRef,
              identityRef: s.binding.telegramIdentityRef,
              expectedRevision: Number(row.restriction_revision),
              action: "restore",
              actorRef: "synthetic-owner",
              reason: "Restore during observation",
            },
            true,
          ),
        ).toBe("applied");
        return { kind: "observed", state: observed };
      };
      if (path === "effect") await s.provider().processDueEffects();
      else await s.provider().reconcileDueStates();
      expect((await s.row()).removal_origin).toBe("operator_restore");
      expect((await s.row()).admission_restriction).toBe("none");
    },
  );
  it("uses the exact persisted invite expiry despite clock advancing after commit", async () => {
    const s = await stand();
    const originalNow = s.clock.now.bind(s.clock);
    s.clock.now = () => {
      s.clock.value = new Date(s.clock.value.getTime() + 1);
      return originalNow();
    };
    let actualExpiry: Date | undefined;
    s.chat.createJoinRequestLink = async (_chat, expiresAt) => {
      actualExpiry = expiresAt;
      s.chat.calls.push({ method: "create_invite", expiresAt });
      expect(expiresAt).toEqual((await s.row()).invite_expires_at);
      throw new Error("Crash/lost response after Telegram created the invite");
    };
    await s.set();
    await s.provider().processDueEffects();
    s.clock.now = originalNow;
    expect(actualExpiry).toBeDefined();
    s.clock.value = new Date(actualExpiry!.getTime() - 1);
    await s.provider().processDueEffects();
    expect(s.chat.count("create_invite")).toBe(1);
  });
  it("waits for the persisted invite horizon after throw or process death", async () => {
    const s = await stand();
    s.chat.createJoinRequestLink = async () => {
      s.chat.calls.push({ method: "create_invite", expiresAt: s.clock.now() });
      throw new Error("response lost");
    };
    await s.set();
    await s.provider().processDueEffects();
    await s.provider().processDueEffects();
    expect(s.chat.count("create_invite")).toBe(1);
    expect((await s.row()).invite_expires_at!.getTime()).toBeGreaterThan(
      s.clock.now().getTime(),
    );
    s.clock.value = new Date(s.clock.now().getTime() + 60_000);
    await s.provider().processDueEffects();
    expect(s.chat.count("create_invite")).toBe(1);
  });
  it("rejects foreign and delayed expired invites before an approval effect", async () => {
    const s = await stand();
    await s.set();
    await s.provider().processDueEffects();
    const request = {
      botIdentity: s.bot,
      canonicalChatId: "-1000000000000",
      telegramUserId: s.user,
      requestedAt: s.clock.now(),
      updateId: "1",
      inviteLink: "https://t.me/+other",
    };
    await s.provider().acceptJoinRequest(request);
    expect(s.chat.count("decline")).toBe(1);
    await s.provider().acceptJoinRequest({
      ...request,
      updateId: "2",
      inviteLink: (await s.row()).invite_link!,
    });
    s.clock.value = new Date(s.clock.now().getTime() + 600_001);
    await s.provider().processDueEffects();
    expect(s.chat.count("approve")).toBe(0);
  });
  it("keeps two concurrent workers to one external attempt and admits intended current invite", async () => {
    const s = await stand();
    await s.set();
    await Promise.all([
      s.provider().processDueEffects(),
      s.provider().processDueEffects(),
    ]);
    expect(s.chat.count("create_invite")).toBe(1);
    await s.provider().acceptJoinRequest({
      botIdentity: s.bot,
      canonicalChatId: "-1000000000000",
      telegramUserId: s.user,
      requestedAt: s.clock.now(),
      updateId: "3",
      inviteLink: (await s.row()).invite_link!,
    });
    await s.provider().processDueEffects();
    expect(s.chat.count("approve")).toBe(1);
    await s.provider().processDueEffects();
    expect(await s.provider().admissionFor(s.user)).toEqual({ kind: "member" });
  });
});

describe("community v2 removal by the configured Tribute bot", () => {
  const tribute = "7000001";
  type Stand = Awaited<ReturnType<typeof stand>>;
  const removal = (
    s: Stand,
    status: "kicked" | "left",
    actor: { readonly id: string; readonly isBot: boolean },
    updateId: string,
  ) =>
    s.provider().observeMembershipEvent({
      kind: "subject",
      botIdentity: s.bot,
      canonicalChatId: "-1000000000000",
      subjectTelegramUserId: s.user,
      actorIsSubject: false,
      actorIsBot: actor.isBot,
      actorTelegramUserId: actor.id,
      chatMember: { status },
      eventAt: s.clock.now(),
      updateId,
    });
  const notices = async (s: Stand) =>
    (
      await db
        .selectFrom("start_response_deliveries")
        .select(["private_chat_id", "message_text"])
        .where("bot_identity", "=", s.bot)
        .where("source_key", "like", "community-readmission:%")
        .execute()
    ).map((row) => ({
      chat: String(row.private_chat_id),
      text: row.message_text,
    }));
  const advance = (s: Stand, milliseconds: number) => {
    s.clock.value = new Date(s.clock.now().getTime() + milliseconds);
  };
  async function sweep(s: Stand) {
    await s.provider().reconcileDueStates();
    await s.provider().processDueEffects();
    await s.provider().processDueEffects();
  }
  async function memberWithRight() {
    const s = await stand({ tributeBotTelegramUserId: tribute });
    s.chat.membership = "member";
    await s.set();
    await s.provider().processDueEffects();
    advance(s, 1000);
    return s;
  }
  const blocked = async (s: Stand) => {
    expect(s.chat.count("unban")).toBe(0);
    expect(s.chat.count("create_invite")).toBe(0);
    expect(await notices(s)).toEqual([]);
    expect(await s.provider().admissionFor(s.user)).toEqual({
      kind: "moderation_blocked",
    });
  };

  it("returns a person removed by Tribute while the Platform right is current", async () => {
    const s = await memberWithRight();
    s.chat.membership = "banned";
    await removal(s, "kicked", { id: tribute, isBot: true }, "200");
    expect(await s.row()).toMatchObject({
      admission_restriction: "none",
      removal_origin: "tribute_expiry",
    });

    await sweep(s);

    expect(s.chat.count("unban")).toBe(1);
    expect(s.chat.count("create_invite")).toBe(1);
    expect(await s.provider().admissionFor(s.user)).toEqual({
      kind: "link",
      inviteLink: "https://t.me/+synthetic",
    });
    expect(await notices(s)).toEqual([
      { chat: s.user, text: "Synthetic readmission\nhttps://t.me/+synthetic" },
    ]);
    advance(s, 60_000);
    await sweep(s);
    expect(await notices(s)).toHaveLength(1);
  });

  it("invites a person whom Tribute banned and unbanned, because leaving does not return them", async () => {
    const s = await memberWithRight();
    await removal(s, "kicked", { id: tribute, isBot: true }, "200");
    await removal(s, "left", { id: tribute, isBot: true }, "201");
    s.chat.membership = "not_member";

    await sweep(s);

    expect(s.chat.count("unban")).toBe(0);
    expect(s.chat.count("create_invite")).toBe(1);
    expect(await notices(s)).toHaveLength(1);
  });

  it("keeps a removal by a human moderator as a ban without automatic return", async () => {
    const s = await memberWithRight();
    s.chat.membership = "banned";
    await removal(s, "kicked", { id: "998", isBot: false }, "200");

    await sweep(s);

    expect((await s.row()).admission_restriction).toBe("moderation");
    await blocked(s);
  });

  it("keeps a removal by an unconfigured bot restricted as unknown", async () => {
    const s = await memberWithRight();
    s.chat.membership = "banned";
    await removal(s, "kicked", { id: "555000", isBot: true }, "200");

    await sweep(s);

    expect((await s.row()).admission_restriction).toBe("external_unknown");
    await blocked(s);
  });

  it("does nothing without a Platform right and returns the person once a right appears", async () => {
    const s = await stand({
      tributeBotTelegramUserId: tribute,
      removalsEnabled: false,
    });
    s.chat.membership = "member";
    await s.set({ kind: "denied" });
    await s.provider().processDueEffects();
    advance(s, 1000);
    s.chat.membership = "banned";
    await removal(s, "kicked", { id: tribute, isBot: true }, "300");
    advance(s, 60_000);

    await sweep(s);

    expect(s.chat.count("ban")).toBe(0);
    expect(s.chat.count("unban")).toBe(0);
    expect(s.chat.count("create_invite")).toBe(0);
    expect(await notices(s)).toEqual([]);

    await s.set();
    await sweep(s);

    expect(s.chat.count("unban")).toBe(1);
    expect(s.chat.count("create_invite")).toBe(1);
    expect(await notices(s)).toHaveLength(1);
  });

  it("lets a late Tribute event lift the restriction set by an unexplained ban observation", async () => {
    const s = await memberWithRight();
    s.chat.membership = "banned";
    advance(s, 60_000);
    await sweep(s);
    expect((await s.row()).admission_restriction).toBe("external_unknown");
    expect(s.chat.count("unban")).toBe(0);

    await removal(s, "kicked", { id: tribute, isBot: true }, "200");
    await sweep(s);

    expect((await s.row()).admission_restriction).toBe("none");
    expect(s.chat.count("unban")).toBe(1);
    expect(s.chat.count("create_invite")).toBe(1);
  });

  it("does not lift a moderator ban when Tribute reports a later removal event", async () => {
    const s = await memberWithRight();
    s.chat.membership = "banned";
    await removal(s, "kicked", { id: "998", isBot: false }, "200");
    await removal(s, "kicked", { id: tribute, isBot: true }, "201");

    await sweep(s);

    expect((await s.row()).admission_restriction).toBe("moderation");
    await blocked(s);
  });

  it("invites a person whom Tribute removed with a single unban", async () => {
    const s = await memberWithRight();
    await removal(s, "left", { id: tribute, isBot: true }, "200");
    s.chat.membership = "not_member";

    await sweep(s);

    expect(s.chat.count("unban")).toBe(0);
    expect(s.chat.count("create_invite")).toBe(1);
    expect(await notices(s)).toHaveLength(1);
  });

  it("keeps an unknown bot's ban restricted after a manual unban and a later Tribute removal", async () => {
    const s = await memberWithRight();
    s.chat.membership = "banned";
    await removal(s, "kicked", { id: "555000", isBot: true }, "200");
    await removal(s, "left", { id: "998", isBot: false }, "201");
    await removal(s, "kicked", { id: tribute, isBot: true }, "202");

    await sweep(s);

    expect((await s.row()).admission_restriction).toBe("external_unknown");
    await blocked(s);
  });

  it("keeps the invite available in the bot but sends no message to an unreachable contact", async () => {
    const s = await memberWithRight();
    await db
      .updateTable("bot_contacts")
      .set({ contactability: "blocked" })
      .where("bot_identity", "=", s.bot)
      .execute();
    s.chat.membership = "banned";
    await removal(s, "kicked", { id: tribute, isBot: true }, "200");

    await sweep(s);

    expect(s.chat.count("create_invite")).toBe(1);
    expect(await notices(s)).toEqual([]);
    expect(await s.provider().admissionFor(s.user)).toEqual({
      kind: "link",
      inviteLink: "https://t.me/+synthetic",
    });
  });
});
