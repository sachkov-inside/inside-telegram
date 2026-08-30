import { createHash } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/create-database.js";
import type { Database } from "../../src/database/database.js";
import { migrateToLatest } from "../../src/database/migrator.js";
import {
  IdentityLinking,
  MalformedLinkRequestError,
} from "../../src/modules/identity-linking/identity-linking.js";
import { InMemoryIdentityLinkingAdapter } from "../../src/modules/identity-linking/in-memory-identity-linking.adapter.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const now = new Date("2030-01-01T00:00:00.000Z");
const tokenDigest = "jKKh9RnjKMdeJyPGrUz3N7LTyO3qlo7dUNRlIji0Qk8";

let database: Database;
let linking: IdentityLinking;

beforeAll(async () => {
  database = createDatabase(databaseUrl);
  await migrateToLatest(database);
  linking = new IdentityLinking(database, { now: () => now });
});

beforeEach(async () => {
  await sql`
    truncate table
      identity_link_events,
      platform_links,
      link_transactions
    restart identity cascade
  `.execute(database);
});

afterAll(async () => {
  await database.destroy();
});

describe("IdentityLinking", () => {
  it("links only after Telegram receipt and authenticated confirmation", async () => {
    const challenge = await linking.register({
      accountRef: "account-ref-a",
      expiresAt: new Date("2030-01-01T00:10:00.000Z"),
      returnCorrelation: "return-ref-a",
      tokenDigest,
    });

    expect(challenge).toEqual({
      expiresAt: new Date("2030-01-01T00:10:00.000Z"),
      linkTransactionRef: expect.any(String),
      returnCorrelation: "return-ref-a",
      status: "pending",
    });
    await expect(
      linking.confirm({
        accountRef: "account-ref-a",
        linkTransactionRef: challenge.linkTransactionRef,
        returnCorrelation: "return-ref-a",
      }),
    ).resolves.toEqual({
      linkTransactionRef: challenge.linkTransactionRef,
      returnCorrelation: "return-ref-a",
      status: "pending",
    });

    await expect(
      linking.acceptStart({
        botIdentity: "inside",
        linkToken: { digest: tokenDigest, kind: "digest" },
        observedAt: new Date("2030-01-01T00:01:00.000Z"),
        telegramUserId: "42",
      }),
    ).resolves.toEqual({ status: "pending" });

    const linked = await linking.confirm({
      accountRef: "account-ref-a",
      linkTransactionRef: challenge.linkTransactionRef,
      returnCorrelation: "return-ref-a",
    });
    expect(linked).toEqual({
      linkTransactionRef: challenge.linkTransactionRef,
      returnCorrelation: "return-ref-a",
      status: "linked",
      telegramIdentityRef: expect.any(String),
    });
    await expect(
      linking.confirm({
        accountRef: "account-ref-a",
        linkTransactionRef: challenge.linkTransactionRef,
        returnCorrelation: "return-ref-a",
      }),
    ).resolves.toEqual({
      ...linked,
      status: "idempotent",
    });
  });

  it("keeps the same pair idempotent and requires recovery for another Account", async () => {
    const first = await registerAndReceive(
      "account-ref-a",
      digest("first-token"),
      "42",
      "return-ref-a",
    );
    const firstLink = await linking.confirm({
      accountRef: "account-ref-a",
      linkTransactionRef: first.linkTransactionRef,
      returnCorrelation: "return-ref-a",
    });
    expect(firstLink.status).toBe("linked");

    const repeat = await registerAndReceive(
      "account-ref-a",
      digest("second-token"),
      "42",
      "return-ref-b",
    );
    const repeatedLink = await linking.confirm({
      accountRef: "account-ref-a",
      linkTransactionRef: repeat.linkTransactionRef,
      returnCorrelation: "return-ref-b",
    });
    expect(repeatedLink).toEqual({
      linkTransactionRef: repeat.linkTransactionRef,
      returnCorrelation: "return-ref-b",
      status: "idempotent",
      telegramIdentityRef:
        firstLink.status === "linked"
          ? firstLink.telegramIdentityRef
          : expect.any(String),
    });
    await expect(
      linking.confirm({
        accountRef: "account-ref-a",
        linkTransactionRef: repeat.linkTransactionRef,
        returnCorrelation: "return-ref-b",
      }),
    ).resolves.toEqual(repeatedLink);

    const conflict = await linking.register({
      accountRef: "account-ref-b",
      expiresAt: new Date("2030-01-01T00:10:00.000Z"),
      returnCorrelation: "return-ref-c",
      tokenDigest: digest("third-token"),
    });
    await expect(
      linking.acceptStart({
        botIdentity: "inside",
        linkToken: { digest: digest("third-token"), kind: "digest" },
        observedAt: new Date("2030-01-01T00:01:00.000Z"),
        telegramUserId: "42",
      }),
    ).resolves.toEqual({ status: "conflict" });
    await expect(
      linking.confirm({
        accountRef: "account-ref-b",
        linkTransactionRef: conflict.linkTransactionRef,
        returnCorrelation: "return-ref-c",
      }),
    ).resolves.toEqual({
      linkTransactionRef: conflict.linkTransactionRef,
      returnCorrelation: "return-ref-c",
      status: "recovery-required",
    });
  });

  it("allows exactly one winner when a link token is consumed concurrently", async () => {
    await linking.register({
      accountRef: "account-ref-a",
      expiresAt: new Date("2030-01-01T00:10:00.000Z"),
      returnCorrelation: "return-ref-a",
      tokenDigest,
    });
    const receipt = {
      botIdentity: "inside",
      linkToken: { digest: tokenDigest, kind: "digest" as const },
      observedAt: new Date("2030-01-01T00:01:00.000Z"),
      telegramUserId: "42",
    };

    const outcomes = await Promise.all([
      linking.acceptStart(receipt),
      linking.acceptStart(receipt),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "pending",
      "replayed",
    ]);
    const candidate = await database
      .selectFrom("link_transactions")
      .select(["candidate_telegram_user_id", "state"])
      .executeTakeFirstOrThrow();
    expect(candidate).toEqual({
      candidate_telegram_user_id: "42",
      state: "received",
    });
  });

  it("returns neutral malformed and expired outcomes without creating a link", async () => {
    await linking.register({
      accountRef: "account-ref-a",
      expiresAt: new Date("2030-01-01T00:01:00.000Z"),
      returnCorrelation: "return-ref-a",
      tokenDigest,
    });

    await expect(
      linking.acceptStart({
        botIdentity: "inside",
        linkToken: { kind: "malformed" },
        observedAt: new Date("2030-01-01T00:00:30.000Z"),
        telegramUserId: "42",
      }),
    ).resolves.toEqual({ status: "malformed" });
    await expect(
      linking.acceptStart({
        botIdentity: "inside",
        linkToken: { digest: tokenDigest, kind: "digest" },
        observedAt: new Date("2030-01-01T00:01:00.000Z"),
        telegramUserId: "42",
      }),
    ).resolves.toEqual({ status: "expired" });
    await expect(
      new IdentityLinking(database, {
        now: () => new Date("2030-01-01T00:01:00.000Z"),
      }).confirm({
        accountRef: "account-ref-a",
        linkTransactionRef: (
          await database
            .selectFrom("link_transactions")
            .select("link_transaction_ref")
            .executeTakeFirstOrThrow()
        ).link_transaction_ref,
        returnCorrelation: "return-ref-a",
      }),
    ).resolves.toMatchObject({ status: "expired" });
    const links = await database
      .selectFrom("platform_links")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(links.count)).toBe(0);
  });

  it("enforces a ten-minute lifetime and the original Account binding", async () => {
    await expect(
      linking.register({
        accountRef: "account-ref-a",
        expiresAt: new Date("2030-01-01T00:10:00.001Z"),
        returnCorrelation: "return-ref-a",
        tokenDigest,
      }),
    ).rejects.toBeInstanceOf(MalformedLinkRequestError);

    const challenge = await registerAndReceive(
      "account-ref-a",
      tokenDigest,
      "42",
      "return-ref-a",
    );
    await expect(
      linking.confirm({
        accountRef: "account-ref-b",
        linkTransactionRef: challenge.linkTransactionRef,
        returnCorrelation: "return-ref-a",
      }),
    ).resolves.toEqual({ status: "malformed" });
    await expect(
      linking.confirm({
        accountRef: "account-ref-a",
        linkTransactionRef: challenge.linkTransactionRef,
        returnCorrelation: "return-ref-a",
      }),
    ).resolves.toMatchObject({ status: "linked" });
  });

  it("does not invent reverse uniqueness for a Platform Account", async () => {
    const first = await registerAndReceive(
      "account-ref-a",
      digest("first-token"),
      "42",
      "return-ref-a",
    );
    await linking.confirm({
      accountRef: "account-ref-a",
      linkTransactionRef: first.linkTransactionRef,
      returnCorrelation: "return-ref-a",
    });

    const second = await registerAndReceive(
      "account-ref-a",
      digest("second-token"),
      "43",
      "return-ref-b",
    );
    await expect(
      linking.confirm({
        accountRef: "account-ref-a",
        linkTransactionRef: second.linkTransactionRef,
        returnCorrelation: "return-ref-b",
      }),
    ).resolves.toMatchObject({ status: "linked" });

    const links = await database
      .selectFrom("platform_links")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(links.count)).toBe(2);
  });

  it("exposes all three commands through the in-memory contract adapter", async () => {
    const adapter = new InMemoryIdentityLinkingAdapter(linking);
    const challenge = await adapter.register({
      accountRef: "account-ref-a",
      contractVersion: "inside.identity-linking.v1",
      expiresAt: "2030-01-01T00:10:00Z",
      returnCorrelation: "return-ref-a",
      tokenDigest,
    });

    await expect(
      adapter.acceptStart({
        botIdentity: "inside",
        contractVersion: "inside.identity-linking.v1",
        observedAt: "2030-01-01T00:01:00Z",
        operation: "accept-start",
        telegramUserId: "42",
        tokenDigest,
      }),
    ).resolves.toEqual({
      contractVersion: "inside.identity-linking.v1",
      operation: "accept-start",
      status: "pending",
    });
    await expect(
      adapter.confirm(challenge.linkTransactionRef, {
        accountRef: "account-ref-a",
        contractVersion: "inside.identity-linking.v1",
        returnCorrelation: "return-ref-a",
      }),
    ).resolves.toMatchObject({
      contractVersion: "inside.identity-linking.v1",
      status: "linked",
      telegramIdentityRef: expect.any(String),
    });
  });
});

async function registerAndReceive(
  accountRef: string,
  tokenDigestValue: string,
  telegramUserId: string,
  returnCorrelation: string,
) {
  const challenge = await linking.register({
    accountRef,
    expiresAt: new Date("2030-01-01T00:10:00.000Z"),
    returnCorrelation,
    tokenDigest: tokenDigestValue,
  });
  await linking.acceptStart({
    botIdentity: "inside",
    linkToken: { digest: tokenDigestValue, kind: "digest" },
    observedAt: new Date("2030-01-01T00:01:00.000Z"),
    telegramUserId,
  });
  return challenge;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
