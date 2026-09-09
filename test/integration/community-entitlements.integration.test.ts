import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/create-database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import {
  CommunityProvider,
  type CommunityJoinRequest,
} from "../../src/modules/community/community-provider.js";
import type {
  CommunityResult,
  CommunitySetCommand,
  DispatchAuthorizationRequest,
  DispatchAuthorizationResponse,
  DispatchDenialReason,
} from "../../src/modules/community/community-contract.js";
import fixtures from "../../docs/contracts/billing-v1/fixtures.json" with { type: "json" };
import { FakeCommunityChat } from "../support/community-chat.js";
import {
  seedCommunityBinding,
  unlinkCommunityBinding,
} from "../support/community-binding.js";

const CHAT = "-1000000000000";
const db = createDatabase(process.env.DATABASE_URL!);
const other = createDatabase(process.env.DATABASE_URL!);
const clock = {
  value: new Date("2026-09-08T09:00:00Z"),
  now() {
    return new Date(this.value);
  },
};
const chat = new FakeCommunityChat();
const authorizations: DispatchAuthorizationRequest[] = [];
let decide: (
  request: DispatchAuthorizationRequest,
) => DispatchAuthorizationResponse | undefined = allow;
const authorization = {
  async authorize(request: DispatchAuthorizationRequest) {
    authorizations.push(request);
    return decide(request);
  },
};

function allow(
  request: DispatchAuthorizationRequest,
): DispatchAuthorizationResponse {
  return {
    contractVersion: "inside.billing-dispatch.v1",
    operation: "dispatch.result",
    operationId: request.operationId,
    dispatchId: request.dispatchId,
    attemptId: request.attemptId,
    decision: {
      status: "allowed",
      permitRef: randomUUID(),
      validUntil: new Date(clock.now().getTime() + 5000).toISOString(),
    },
  };
}

function deny(reason: DispatchDenialReason) {
  return (
    request: DispatchAuthorizationRequest,
  ): DispatchAuthorizationResponse => ({
    contractVersion: "inside.billing-dispatch.v1",
    operation: "dispatch.result",
    operationId: request.operationId,
    dispatchId: request.dispatchId,
    attemptId: request.attemptId,
    decision: { status: "denied", reason },
  });
}

const unavailable = (
  request: DispatchAuthorizationRequest,
): DispatchAuthorizationResponse => ({
  contractVersion: "inside.billing-dispatch.v1",
  operation: "dispatch.result",
  operationId: request.operationId,
  dispatchId: request.dispatchId,
  attemptId: request.attemptId,
  decision: { status: "unavailable" },
});

/** Each subject owns a bot identity so one worker sweep never sees another test. */
const provider = (
  who: Subject = { bot: "inside" } as Subject,
  connection = db,
) =>
  new CommunityProvider(connection, who.bot, CHAT, clock, authorization, chat, {
    reconciliationCadenceMs: 60_000,
  });

function fixture(name: string): CommunitySetCommand {
  return structuredClone(
    fixtures.find((entry) => entry.name === name)!.value,
  ) as CommunitySetCommand;
}

interface Subject {
  readonly bot: string;
  readonly accountRef: string;
  readonly identityRef: string;
  readonly user: string;
}

function subject(): Subject {
  const suffix = randomUUID();
  return {
    bot: `inside-${suffix}`,
    accountRef: `account-${suffix}`,
    identityRef: `telegram-${suffix}`,
    user: String(500_000_000 + Math.floor(Math.random() * 400_000_000)),
  };
}

function command(
  name:
    "finite-community-grant" | "lifetime-community-grant" | "community-revoke",
  who: Subject,
  overrides: Partial<CommunitySetCommand> = {},
): CommunitySetCommand {
  const base = fixture(name);
  return {
    ...base,
    operationId: randomUUID(),
    correlationRef: randomUUID(),
    binding: {
      ...base.binding,
      accountRef: who.accountRef,
      telegramIdentityRef: who.identityRef,
      linkRef: randomUUID(),
    },
    ...overrides,
  };
}

async function drain(who: Subject, times = 8): Promise<void> {
  const p = provider(who);
  for (let index = 0; index < times; index += 1) await p.processDueEffects();
}

async function result(
  who: Subject,
  operationId: string,
): Promise<CommunityResult> {
  const handled = await provider(who).handle({
    contractVersion: "inside.community-entitlement.v1",
    operation: "entitlement.status",
    operationId,
  });
  return handled.body as CommunityResult;
}

async function desiredState(who: Subject) {
  return db
    .selectFrom("community_desired_states")
    .selectAll()
    .where("bot_identity", "=", who.bot)
    .where("account_ref", "=", who.accountRef)
    .executeTakeFirstOrThrow();
}

async function effects(who: Subject) {
  return db
    .selectFrom("community_effects")
    .selectAll()
    .where("bot_identity", "=", who.bot)
    .where("account_ref", "=", who.accountRef)
    .orderBy("created_at")
    .execute();
}

function joinRequest(who: Subject, seconds = 0): CommunityJoinRequest {
  return {
    botIdentity: who.bot,
    canonicalChatId: CHAT,
    telegramUserId: who.user,
    requestedAt: new Date(clock.now().getTime() + seconds * 1000),
    updateId: String(Math.floor(Math.random() * 1_000_000)),
  };
}

/** Drives one subject from an accepted grant to observed membership. */
async function admit(who: Subject): Promise<CommunitySetCommand> {
  const grant = command("finite-community-grant", who);
  await seedCommunityBinding(db, grant.binding, clock.now(), who.user, who.bot);
  await provider(who).handle(grant);
  await drain(who);
  await provider(who).acceptJoinRequest(joinRequest(who));
  await drain(who);
  return grant;
}

beforeAll(async () => {
  await migrateToLatest(db);
});

beforeEach(() => {
  clock.value = new Date("2026-09-08T09:00:00Z");
  chat.reset();
  authorizations.length = 0;
  decide = allow;
});

afterAll(async () => {
  await other.destroy();
  await db.destroy();
});

describe("community entitlement inbox", () => {
  it("keeps a revoke in force when the old grant is replayed", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    const revoke = command("community-revoke", who, {
      binding: grant.binding,
      entitlementRevision: 2,
      access: { kind: "denied" },
    });

    expect((await provider(who).handle(grant)).status).toBe(200);
    expect((await provider(who).handle(revoke)).status).toBe(200);
    const replay = await provider(who).handle(grant);

    expect((replay.body as CommunityResult).status).toBe("superseded");
    expect((replay.body as CommunityResult).entitlementRevision).toBe(1);
    const state = await desiredState(who);
    expect(Number(state.entitlement_revision)).toBe(2);
    expect(state.access).toEqual({ kind: "denied" });
    const rows = await effects(who);
    expect(rows[0]?.effect).toBe("community.ensure_admission");
    expect(rows[0]?.state).toBe("superseded");
    expect(rows[1]?.effect).toBe("community.ensure_absence");
    expect(chat.count("approve")).toBe(0);
    expect(chat.count("create_invite")).toBe(0);
  });

  it("rejects the same operation with a changed payload", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);

    const changed = await provider(who).handle({
      ...grant,
      access: { kind: "lifetime" },
    });

    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({
      operation: "entitlement.error",
      error: "operation_conflict",
    });
    const state = await desiredState(who);
    expect(Number(state.entitlement_revision)).toBe(1);
    expect(await effects(who)).toHaveLength(1);
  });

  it("answers a retried command after a lost acknowledgement from one record", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );

    const first = await provider(who).handle(grant);
    const retry = await provider(who).handle(grant);

    expect(retry.body).toEqual(first.body);
    const rows = await db
      .selectFrom("community_operations")
      .selectAll()
      .where("account_ref", "=", who.accountRef)
      .execute();
    expect(rows).toHaveLength(1);
    expect(await effects(who)).toHaveLength(1);
  });

  it("refuses a different desired state at the same revision", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);

    const conflicting = await provider(who).handle(
      command("lifetime-community-grant", who, {
        binding: grant.binding,
        entitlementRevision: 1,
      }),
    );

    expect(conflicting.status).toBe(409);
    expect(conflicting.body).toMatchObject({ error: "revision_conflict" });
    expect(await effects(who)).toHaveLength(1);
  });

  it("accepts an identical repeat at the same revision without a second desired state", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);

    const repeat = await provider(who).handle(
      command("finite-community-grant", who, { binding: grant.binding }),
    );

    expect(repeat.status).toBe(200);
    expect(await effects(who)).toHaveLength(1);
    expect(Number((await desiredState(who)).entitlement_revision)).toBe(1);
  });

  it("answers an unknown status query with not_found", async () => {
    const handled = await provider(subject()).handle({
      contractVersion: "inside.community-entitlement.v1",
      operation: "entitlement.status",
      operationId: randomUUID(),
    });
    expect(handled.status).toBe(404);
    expect(handled.body).toMatchObject({ error: "not_found" });
  });
});

describe("concurrent workers", () => {
  it("keeps one record when the same command arrives on two connections", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );

    const [first, second] = await Promise.all([
      provider(who).handle(grant),
      provider(who, other).handle(grant),
    ]);

    expect(first.body).toEqual(second.body);
    expect(
      await db
        .selectFrom("community_operations")
        .selectAll()
        .where("account_ref", "=", who.accountRef)
        .execute(),
    ).toHaveLength(1);
    expect(await effects(who)).toHaveLength(1);
  });

  it("starts one external attempt when two workers sweep the same effect", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);

    await Promise.all([
      provider(who).processDueEffects(),
      provider(who, other).processDueEffects(),
    ]);

    expect(chat.count("create_invite")).toBe(1);
    const attempts = await db
      .selectFrom("community_effect_attempts")
      .innerJoin(
        "community_effects",
        "community_effects.effect_ref",
        "community_effect_attempts.effect_ref",
      )
      .select("attempt_id")
      .where("community_effects.account_ref", "=", who.accountRef)
      .execute();
    expect(attempts).toHaveLength(1);
    expect((await result(who, grant.operationId)).status).toBe(
      "waiting_for_join",
    );
  });
});

describe("community admission", () => {
  it("creates a short join-request link and applies only observed membership", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);

    await drain(who);

    const invite = chat.calls.find((call) => call.method === "create_invite");
    expect(invite).toBeDefined();
    expect(
      invite?.method === "create_invite" && invite.expiresAt.getTime(),
    ).toBe(clock.now().getTime() + 600_000);
    expect((await result(who, grant.operationId)).status).toBe(
      "waiting_for_join",
    );
    expect((await result(who, grant.operationId)).observedMembership).not.toBe(
      "member",
    );

    await provider(who).acceptJoinRequest(joinRequest(who));
    await drain(who);

    expect(chat.count("approve")).toBe(1);
    const applied = await result(who, grant.operationId);
    expect(applied.status).toBe("applied");
    expect(applied.observedMembership).toBe("member");
  });

  it("never lets an invite outlive a finite right", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who, {
      access: {
        kind: "finite",
        validUntil: new Date(clock.now().getTime() + 60_000).toISOString(),
      },
    });
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);

    await drain(who);

    const invite = chat.calls.find((call) => call.method === "create_invite");
    expect(
      invite?.method === "create_invite" && invite.expiresAt.toISOString(),
    ).toBe(grant.access.kind === "finite" ? grant.access.validUntil : "");
  });

  it("declines a foreign join request without granting anything", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    await drain(who);
    // Same bot and canonical chat, but an identity nobody granted anything to.
    const foreign = { ...subject(), bot: who.bot };

    await provider(who).acceptJoinRequest(joinRequest(foreign));

    expect(chat.count("decline")).toBe(1);
    expect(chat.count("approve")).toBe(0);
    expect((await result(who, grant.operationId)).status).toBe(
      "waiting_for_join",
    );
    expect(await effects(foreign)).toHaveLength(0);
  });

  it("reuses one effect for a replayed join request and opens a new one for a rejoin", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    await drain(who);
    const request = joinRequest(who);
    await provider(who).acceptJoinRequest(request);
    await drain(who);

    // The very same update reaches the provider twice.
    await provider(who).acceptJoinRequest(request);
    const afterReplay = (await effects(who)).filter(
      (row) => row.effect === "community.approve_join",
    );

    chat.membership = "not_member";
    await provider(who).acceptJoinRequest(joinRequest(who, 120));
    await drain(who);

    const approvals = (await effects(who)).filter(
      (row) => row.effect === "community.approve_join",
    );
    expect(afterReplay).toHaveLength(1);
    expect(approvals).toHaveLength(2);
    expect(approvals[0]?.effect_ref).not.toBe(approvals[1]?.effect_ref);
    expect(Number((await desiredState(who)).entitlement_revision)).toBe(1);
    expect((await result(who, grant.operationId)).status).toBe("applied");
  });
});

describe("community removal", () => {
  it("ends membership when the right is revoked", async () => {
    const who = subject();
    const grant = await admit(who);
    expect(chat.membership).toBe("member");

    await provider(who).handle(
      command("community-revoke", who, {
        binding: grant.binding,
        entitlementRevision: 2,
        access: { kind: "denied" },
      }),
    );
    await drain(who);

    expect(chat.count("ban")).toBe(1);
    expect(chat.count("revoke_link")).toBe(1);
    const state = await desiredState(who);
    expect(state.status).toBe("applied");
    expect(state.observed_membership).toBe("not_member");
  });

  it("stops admission the moment a finite right lapses and removes what remains", async () => {
    const who = subject();
    const grant = await admit(who);
    authorizations.length = 0;
    chat.calls.length = 0;

    clock.value = new Date("2026-10-08T09:00:00Z");
    await drain(who);

    expect(chat.count("create_invite")).toBe(0);
    expect(chat.count("approve")).toBe(0);
    expect(chat.count("ban")).toBe(1);
    expect((await result(who, grant.operationId)).status).toBe("expired");
  });

  it("removes a historical identity after unlink when no transfer took it over", async () => {
    const who = subject();
    const grant = await admit(who);
    await unlinkCommunityBinding(db, grant.binding, who.bot);
    chat.calls.length = 0;

    await provider(who).handle(
      command("community-revoke", who, {
        binding: grant.binding,
        entitlementRevision: 2,
        access: { kind: "denied" },
      }),
    );
    await drain(who);

    expect(chat.count("ban")).toBe(1);
    expect((await desiredState(who)).observed_membership).toBe("not_member");
  });

  it("leaves a disputed identity to an operator instead of removing it", async () => {
    const who = subject();
    const grant = await admit(who);
    // The identity now belongs to another Account, so its removal is disputed.
    await db
      .updateTable("platform_links")
      .set({ account_ref: subject().accountRef })
      .where("telegram_identity_ref", "=", grant.binding.telegramIdentityRef)
      .execute();
    chat.calls.length = 0;

    await provider(who).handle(
      command("community-revoke", who, {
        binding: grant.binding,
        entitlementRevision: 2,
        access: { kind: "denied" },
      }),
    );
    await drain(who);

    expect(chat.count("ban")).toBe(0);
    const rows = await effects(who);
    expect(rows.at(-1)?.diagnostic_code).toBe("unverified_binding");
    expect((await desiredState(who)).status).toBe("failed");
  });
});

describe("dispatch permits", () => {
  it("performs no external call while authorization is unavailable", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    decide = unavailable;

    await drain(who, 3);

    expect(authorizations.length).toBeGreaterThan(0);
    expect(chat.calls).toHaveLength(0);
    expect((await result(who, grant.operationId)).status).not.toBe("applied");
    const [effect] = await effects(who);
    expect(effect?.state).toBe("pending");
    expect(effect?.diagnostic_code).toBe("authorization_unavailable");

    decide = allow;
    clock.value = new Date(clock.value.getTime() + 2000);
    await drain(who);
    expect(chat.count("create_invite")).toBe(1);
  });

  it("does not admit when the binding is no longer authorized", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    decide = deny("binding_conflict");

    await drain(who);

    expect(chat.calls).toHaveLength(0);
    expect((await result(who, grant.operationId)).status).toBe("failed");
  });

  it("does not admit after the right has expired at the source", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    decide = deny("expired");

    await drain(who, 1);

    expect(chat.calls).toHaveLength(0);
    expect((await result(who, grant.operationId)).status).toBe("expired");
    expect(
      (await effects(who)).some(
        (row) => row.effect === "community.ensure_absence",
      ),
    ).toBe(true);
  });

  it("keeps a newer lifetime right when an old expired grant asks for removal", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    await drain(who);
    clock.value = new Date("2026-10-08T09:00:00Z");
    await drain(who, 1);
    expect((await result(who, grant.operationId)).status).toBe("expired");
    expect(
      (await effects(who)).some(
        (row) =>
          row.effect === "community.ensure_absence" &&
          ["pending", "started", "unknown"].includes(row.state),
      ),
    ).toBe(true);
    chat.calls.length = 0;

    // A manual lifetime grant arrives before the removal of the old one runs.
    const lifetime = command("lifetime-community-grant", who, {
      binding: grant.binding,
      entitlementRevision: 2,
      access: { kind: "lifetime" },
    });
    await provider(who).handle(lifetime);
    await drain(who);

    expect(chat.count("ban")).toBe(0);
    const state = await desiredState(who);
    expect(state.access).toEqual({ kind: "lifetime" });
    expect(state.status).not.toBe("expired");
    expect((await result(who, lifetime.operationId)).access).toEqual({
      kind: "lifetime",
    });
  });

  it("honours a superseded denial without removing anyone", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    await drain(who);
    clock.value = new Date("2026-10-08T09:00:00Z");
    await drain(who, 1);
    chat.calls.length = 0;
    decide = deny("superseded");

    await drain(who, 1);

    expect(chat.count("ban")).toBe(0);
    expect((await result(who, grant.operationId)).status).toBe("superseded");
  });

  it("refuses a permit that reaches past its five second window", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    decide = (request) => ({
      contractVersion: "inside.billing-dispatch.v1",
      operation: "dispatch.result",
      operationId: request.operationId,
      dispatchId: request.dispatchId,
      attemptId: request.attemptId,
      decision: {
        status: "allowed",
        permitRef: randomUUID(),
        validUntil: new Date(clock.now().getTime() + 60_000).toISOString(),
      },
    });

    await drain(who, 1);

    expect(chat.calls).toHaveLength(0);
    expect((await effects(who))[0]?.diagnostic_code).toBe(
      "permit_out_of_window",
    );
  });
});

describe("community provider outages", () => {
  it("treats a lost invite response as unknown and waits for its bounded expiry", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    chat.invite = { kind: "unknown" };

    await drain(who);

    expect(chat.count("create_invite")).toBe(1);
    const [effect] = await effects(who);
    expect(effect?.state).toBe("unknown");
    expect((await desiredState(who)).invite_state).toBe("unknown");
    expect((await result(who, grant.operationId)).status).toBe("unknown");
    expect((await result(who, grant.operationId)).observedMembership).toBe(
      "unknown",
    );

    // Only after the bounded expiry does a fresh check justify another attempt.
    chat.invite = { kind: "created", inviteLink: "https://t.me/+second" };
    clock.value = new Date(clock.value.getTime() + 600_000);
    await drain(who);

    expect(chat.count("create_invite")).toBe(2);
    expect(authorizations).toHaveLength(2);
  });

  it("does not hide an unusable bot behind an applied status", async () => {
    const who = subject();
    const grant = await admit(who);
    chat.calls.length = 0;
    chat.capability = {
      kind: "degraded",
      diagnosticCode: "bot_restrict_right_required",
    };

    await provider(who).handle(
      command("community-revoke", who, {
        binding: grant.binding,
        entitlementRevision: 2,
        access: { kind: "denied" },
      }),
    );
    await drain(who, 1);

    expect(chat.calls).toHaveLength(0);
    const rows = await effects(who);
    expect(rows.at(-1)?.diagnostic_code).toBe("bot_restrict_right_required");
    expect((await desiredState(who)).status).not.toBe("applied");
  });

  it("reports an unreachable Telegram as unknown during reconciliation", async () => {
    const who = subject();
    const grant = await admit(who);
    chat.membership = "unavailable";
    clock.value = new Date(clock.value.getTime() + 61_000);

    await provider(who).reconcileDueStates();

    const state = await result(who, grant.operationId);
    expect(state.status).toBe("unknown");
    expect(state.observedMembership).toBe("unknown");
  });

  it("returns to waiting for join when a member leaves under the same right", async () => {
    const who = subject();
    const grant = await admit(who);
    chat.membership = "not_member";
    clock.value = new Date(clock.value.getTime() + 61_000);

    await provider(who).reconcileDueStates();

    const state = await result(who, grant.operationId);
    expect(state.status).toBe("waiting_for_join");
    expect(state.entitlementRevision).toBe(1);
  });

  it("surfaces an overdue desired state to an operator", async () => {
    const who = subject();
    await admit(who);
    clock.value = new Date(clock.value.getTime() + 360_000);

    const snapshot = await provider(who).snapshot();

    expect(snapshot.dueStates).toBeGreaterThan(0);
    expect(snapshot.oldestDueAgeMs).toBeGreaterThan(300_000);
  });
});

describe("membership that arrived another way", () => {
  it("removes a member who entered outside our invite when no right is current", async () => {
    const who = subject();
    const grant = command("community-revoke", who, {
      entitlementRevision: 1,
      access: { kind: "denied" },
    });
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    // Somebody was let in by an owner-created link or a manual approval.
    chat.membership = "member";

    await drain(who);

    expect(chat.count("ban")).toBe(1);
    expect(chat.count("create_invite")).toBe(0);
    const state = await desiredState(who);
    expect(state.status).toBe("applied");
    expect(state.observed_membership).toBe("not_member");
  });

  it("applies a right without approving anything when the member is already inside", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    chat.membership = "member";
    await provider(who).handle(grant);

    await drain(who);

    expect(chat.count("approve")).toBe(0);
    expect(chat.count("create_invite")).toBe(0);
    expect((await result(who, grant.operationId)).status).toBe("applied");
  });
});

describe("invite ownership", () => {
  it("never reuses a link created for an earlier revision", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    await drain(who);
    expect(chat.count("create_invite")).toBe(1);
    const first = await desiredState(who);
    chat.invite = { kind: "created", inviteLink: "https://t.me/+relinked" };

    // A relink raises the entitlement revision while the old link is still live.
    const relinked = command("finite-community-grant", who, {
      binding: { ...grant.binding, linkRevision: 2 },
      entitlementRevision: 2,
    });
    await provider(who).handle(relinked);
    await drain(who);

    expect(chat.count("create_invite")).toBe(2);
    const second = await desiredState(who);
    expect(second.invite_link).not.toBe(first.invite_link);
    expect(Number(second.invite_revision)).toBe(2);
    expect((await result(who, relinked.operationId)).status).toBe(
      "waiting_for_join",
    );
  });

  it("keeps every accepted operation of the current revision in step", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    const duplicate = command("finite-community-grant", who, {
      binding: grant.binding,
    });
    await provider(who).handle(duplicate);

    await drain(who);

    expect((await result(who, grant.operationId)).status).toBe(
      "waiting_for_join",
    );
    expect((await result(who, duplicate.operationId)).status).toBe(
      "waiting_for_join",
    );
  });
});

describe("handing the invite to its own contact", () => {
  it("gives the stored link only to the intended contact and does not apply it", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    await drain(who);

    const admission = await provider(who).admissionFor(who.user);

    expect(admission).toEqual({
      kind: "link",
      inviteLink: "https://t.me/+synthetic",
    });
    expect((await result(who, grant.operationId)).status).toBe(
      "waiting_for_join",
    );
    expect((await result(who, grant.operationId)).observedMembership).not.toBe(
      "member",
    );
  });

  it("tells an unlinked or unentitled contact nothing about a link", async () => {
    const who = subject();
    const grant = command("finite-community-grant", who);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      who.user,
      who.bot,
    );
    await provider(who).handle(grant);
    await drain(who);
    const stranger = subject();

    await expect(provider(who).admissionFor(stranger.user)).resolves.toEqual({
      kind: "none",
    });

    await provider(who).handle(
      command("community-revoke", who, {
        binding: grant.binding,
        entitlementRevision: 2,
        access: { kind: "denied" },
      }),
    );
    await expect(provider(who).admissionFor(who.user)).resolves.toEqual({
      kind: "none",
    });
  });

  it("reports an existing member and prepares admission when no link is ready", async () => {
    const who = subject();
    await admit(who);
    await expect(provider(who).admissionFor(who.user)).resolves.toEqual({
      kind: "member",
    });

    const waiting = subject();
    const grant = command("finite-community-grant", waiting);
    await seedCommunityBinding(
      db,
      grant.binding,
      clock.now(),
      waiting.user,
      waiting.bot,
    );
    await provider(waiting).handle(grant);

    await expect(provider(waiting).admissionFor(waiting.user)).resolves.toEqual(
      { kind: "preparing" },
    );
  });
});
