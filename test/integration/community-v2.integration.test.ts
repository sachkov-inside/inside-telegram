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
async function stand() {
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
      removalsEnabled: true,
      botTelegramUserId: "1234",
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
