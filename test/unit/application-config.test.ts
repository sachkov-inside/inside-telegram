import { describe, expect, it } from "vitest";

import { loadApplicationConfig } from "../../src/config/application-config.js";

const validEnvironment = {
  DATABASE_URL: "postgresql://inside:inside@127.0.0.1:5432/inside",
  PLATFORM_INTEGRATION_SECRET: "synthetic_platform_secret_for_tests_only",
  TELEGRAM_BOT_IDENTITY: "inside",
  TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
  TELEGRAM_LINK_RECEIPT_TEXT: "Synthetic link receipt",
  TELEGRAM_LINKED_MEMBER_TEXT: "Synthetic member status",
  TELEGRAM_LINKED_NON_MEMBER_TEXT: "Synthetic non-member status",
  TELEGRAM_LINKED_UNAVAILABLE_TEXT: "Synthetic unavailable status",
  TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook_secret_for_tests_only",
  TELEGRAM_WELCOME_TEXT: "Synthetic welcome",
};

describe("application configuration", () => {
  it("keeps content validation disabled until a secure authenticated endpoint is configured", () => {
    expect(
      loadApplicationConfig(validEnvironment)
        .platformAuthorContentValidationUrl,
    ).toBeUndefined();
    const authorization = {
      ...validEnvironment,
      PLATFORM_AUTHOR_AUTHORIZATION_URL: "https://platform.test/authorize",
      PLATFORM_AUTHOR_AUTHORIZATION_SECRET:
        "synthetic-authorization-secret-for-tests",
    };
    const url =
      "https://platform.test/integrations/telegram/v1/communications/validate-content";
    expect(
      loadApplicationConfig({
        ...authorization,
        PLATFORM_AUTHOR_CONTENT_VALIDATION_URL: url,
      }).platformAuthorContentValidationUrl,
    ).toBe(url);
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        PLATFORM_AUTHOR_CONTENT_VALIDATION_URL: url,
      }),
    ).toThrow("requires author authorization");
    for (const bad of [
      "http://platform.test/validate",
      "https://user:password@platform.test/validate",
      "https://platform.test/validate?token=secret",
      "https://platform.test/validate#fragment",
    ])
      expect(() =>
        loadApplicationConfig({
          ...authorization,
          PLATFORM_AUTHOR_CONTENT_VALIDATION_URL: bad,
        }),
      ).toThrow("PLATFORM_AUTHOR_CONTENT_VALIDATION_URL");
  });

  it("keeps external delivery disabled by default", () => {
    const config = loadApplicationConfig(validEnvironment);

    expect(config.deliveryMode).toBe("disabled");
    expect(config.signInEnabled).toBe(false);
    expect(config.signInIntegrationSecret).toBeUndefined();
    expect(config.evidenceDeliveryMode).toBe("disabled");
    expect(config.membershipMode).toBe("disabled");
    expect(config.membershipReconciliationCadenceMilliseconds).toBe(240_000);
    expect(config.workersEnabled).toBe(true);
  });

  it("requires a separate sign-in credential only when enabled", () => {
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_SIGN_IN_ENABLED: "true",
      }),
    ).toThrow("TELEGRAM_SIGN_IN_INTEGRATION_SECRET");
    const credential = "synthetic_sign_in_credential_for_tests_only";
    expect(
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_SIGN_IN_ENABLED: "true",
        TELEGRAM_SIGN_IN_INTEGRATION_SECRET: credential,
      }).signInEnabled,
    ).toBe(true);
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        PLATFORM_INTEGRATION_SECRET: credential,
        TELEGRAM_SIGN_IN_ENABLED: "true",
        TELEGRAM_SIGN_IN_INTEGRATION_SECRET: credential,
      }),
    ).toThrow("separate");
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_SIGN_IN_ENABLED: "yes",
      }),
    ).toThrow("TELEGRAM_SIGN_IN_ENABLED");
  });

  it("requires a complete secure author authorization endpoint while defaulting to disabled", () => {
    expect(
      loadApplicationConfig(validEnvironment).platformAuthorAuthorizationUrl,
    ).toBeUndefined();
    const auth = {
      PLATFORM_AUTHOR_AUTHORIZATION_URL:
        "https://platform.example.test/authorize",
      PLATFORM_AUTHOR_AUTHORIZATION_SECRET:
        "synthetic_author_secret_for_tests_only",
    };
    expect(
      loadApplicationConfig({ ...validEnvironment, ...auth })
        .platformAuthorAuthorizationUrl,
    ).toBe(auth.PLATFORM_AUTHOR_AUTHORIZATION_URL);
    for (const changed of [
      { PLATFORM_AUTHOR_AUTHORIZATION_SECRET: undefined },
      { PLATFORM_AUTHOR_AUTHORIZATION_URL: undefined },
      {
        PLATFORM_AUTHOR_AUTHORIZATION_URL:
          "http://platform.example.test/authorize",
      },
      {
        PLATFORM_AUTHOR_AUTHORIZATION_URL:
          "https://user:password@platform.example.test/authorize",
      },
      {
        PLATFORM_AUTHOR_AUTHORIZATION_URL:
          "https://platform.example.test/authorize?secret=synthetic",
      },
      {
        PLATFORM_AUTHOR_AUTHORIZATION_URL:
          "https://platform.example.test/authorize#secret",
      },
    ])
      expect(() =>
        loadApplicationConfig({ ...validEnvironment, ...auth, ...changed }),
      ).toThrow("PLATFORM_AUTHOR_AUTHORIZATION");
  });
  it("requires a token before live external delivery can start", () => {
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_DELIVERY_MODE: "live",
      }),
    ).toThrow("TELEGRAM_BOT_TOKEN is required");
  });

  it("rejects an invalid webhook secret alphabet", () => {
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_WEBHOOK_SECRET: "contains spaces",
      }),
    ).toThrow("TELEGRAM_WEBHOOK_SECRET");
  });

  it("refuses a webhook secret shorter than 32 characters", () => {
    for (const [secret, accepted] of [
      ["w".repeat(31), false],
      ["w".repeat(32), true],
      ["w".repeat(256), true],
      ["w".repeat(257), false],
    ] as const) {
      const load = () =>
        loadApplicationConfig({
          ...validEnvironment,
          TELEGRAM_WEBHOOK_SECRET: secret,
        });
      if (accepted) expect(load().webhookSecret).toBe(secret);
      else expect(load).toThrow("TELEGRAM_WEBHOOK_SECRET");
    }
  });

  it("refuses an integration secret shorter than 32 characters", () => {
    const short = "s".repeat(31);
    const evidence = {
      PLATFORM_EVIDENCE_DELIVERY_MODE: "live",
      PLATFORM_EVIDENCE_DELIVERY_URL: "https://platform.test/evidence",
      PLATFORM_EVIDENCE_DELIVERY_SECRET:
        "synthetic_evidence_secret_for_tests_only",
    };
    const author = {
      PLATFORM_AUTHOR_AUTHORIZATION_URL: "https://platform.test/authorize",
      PLATFORM_AUTHOR_AUTHORIZATION_SECRET:
        "synthetic_author_secret_for_tests_only",
    };
    expect(
      loadApplicationConfig({ ...validEnvironment, ...evidence, ...author }),
    ).toBeDefined();
    for (const [name, base] of [
      ["PLATFORM_INTEGRATION_SECRET", {}],
      ["PLATFORM_EVIDENCE_DELIVERY_SECRET", evidence],
      ["PLATFORM_AUTHOR_AUTHORIZATION_SECRET", author],
    ] as const)
      expect(() =>
        loadApplicationConfig({ ...validEnvironment, ...base, [name]: short }),
      ).toThrow(name);
  });

  it("keeps the communications API closed until its own credential is configured", () => {
    expect(
      loadApplicationConfig(validEnvironment).communicationsSecret,
    ).toBeUndefined();
    const secret = "synthetic_communications_secret_for_tests";
    expect(
      loadApplicationConfig({
        ...validEnvironment,
        PLATFORM_COMMUNICATIONS_SECRET: secret,
      }).communicationsSecret,
    ).toBe(secret);
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        PLATFORM_COMMUNICATIONS_SECRET: "s".repeat(31),
      }),
    ).toThrow("PLATFORM_COMMUNICATIONS_SECRET");
  });

  it("refuses any service secret shared between two directions", () => {
    const secrets = {
      TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook_secret_for_tests_only",
      PLATFORM_INTEGRATION_SECRET: "synthetic_platform_secret_for_tests_only",
      PLATFORM_COMMUNICATIONS_SECRET:
        "synthetic_communications_secret_for_tests",
      TELEGRAM_SIGN_IN_INTEGRATION_SECRET:
        "synthetic_sign_in_secret_for_tests_only",
      PLATFORM_COMMUNITY_INTEGRATION_SECRET:
        "synthetic_community_inbound_secret",
      PLATFORM_COMMUNITY_DISPATCH_SECRET: "synthetic_community_dispatch_secret",
      PLATFORM_EVIDENCE_DELIVERY_SECRET:
        "synthetic_evidence_secret_for_tests_only",
      PLATFORM_AUTHOR_AUTHORIZATION_SECRET:
        "synthetic_author_secret_for_tests_only",
      NOTIFICATION_AUTHORIZE_SECRET: "synthetic_notification_secret_for_tests",
      PLATFORM_ACTIVATION_SECRET: "synthetic_activation_secret_for_tests",
    };
    const everyDirection = {
      ...validEnvironment,
      ...secrets,
      TELEGRAM_SIGN_IN_ENABLED: "true",
      TELEGRAM_COMMUNITY_CONTRACT_VERSION: "inside.community-entitlement.v2",
      PLATFORM_COMMUNITY_DISPATCH_URL:
        "https://platform.test/internal/billing-dispatch/authorize",
      PLATFORM_EVIDENCE_DELIVERY_MODE: "live",
      PLATFORM_EVIDENCE_DELIVERY_URL: "https://platform.test/evidence",
      PLATFORM_AUTHOR_AUTHORIZATION_URL: "https://platform.test/authorize",
      TELEGRAM_NOTIFICATIONS_ENABLED: "true",
      NOTIFICATION_AMQP_URL: "amqps://telegram:synthetic@broker.test/inside",
      NOTIFICATION_AUTHORIZE_URL:
        "https://platform.test/internal/notifications/dispatch/authorize",
      NOTIFICATION_QUARANTINE_KEY: "a".repeat(64),
      TELEGRAM_ACTIVATION_ENABLED: "true",
      PLATFORM_ACTIVATION_URL: "https://platform.test/activation",
      PLATFORM_ACCOUNT_URL: "https://platform.test/account",
      TELEGRAM_ACTIVATION_SOURCES: "[]",
    };
    expect(loadApplicationConfig(everyDirection)).toBeDefined();
    const names = Object.keys(secrets) as (keyof typeof secrets)[];
    for (const [index, first] of names.entries())
      for (const second of names.slice(index + 1))
        expect(
          () =>
            loadApplicationConfig({
              ...everyDirection,
              [second]: secrets[first],
            }),
          `${first} reused as ${second}`,
        ).toThrow(/must be separate service secrets/);
  });

  it("requires a distinct Platform integration credential", () => {
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        PLATFORM_INTEGRATION_SECRET: undefined,
      }),
    ).toThrow("PLATFORM_INTEGRATION_SECRET is required");
  });

  it("rejects a canonical chat identity outside Telegram's safe integer range", () => {
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_CANONICAL_CHAT_ID: "9007199254740992",
      }),
    ).toThrow("TELEGRAM_CANONICAL_CHAT_ID");
  });

  it("requires Telegram and Platform credentials for live Membership Evidence", () => {
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_MEMBERSHIP_MODE: "live",
      }),
    ).toThrow("TELEGRAM_BOT_TOKEN is required");

    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        PLATFORM_EVIDENCE_DELIVERY_MODE: "live",
      }),
    ).toThrow("PLATFORM_EVIDENCE_DELIVERY_URL is required");
  });

  it("delivers Membership Evidence only to a plain HTTPS endpoint outside loopback", () => {
    const evidence = {
      ...validEnvironment,
      PLATFORM_EVIDENCE_DELIVERY_MODE: "live",
      PLATFORM_EVIDENCE_DELIVERY_SECRET:
        "synthetic_evidence_secret_for_tests_only",
    };
    for (const url of [
      "https://platform.test/integrations/telegram/v1/membership-evidence",
      "http://127.0.0.1:3001/integrations/telegram/v1/membership-evidence",
    ])
      expect(
        loadApplicationConfig({
          ...evidence,
          PLATFORM_EVIDENCE_DELIVERY_URL: url,
        }).platformEvidenceDeliveryUrl,
      ).toBe(url);
    for (const bad of [
      "http://platform.test/evidence",
      "https://user:password@platform.test/evidence",
      "https://platform.test/evidence?token=synthetic",
      "https://platform.test/evidence#fragment",
    ])
      expect(() =>
        loadApplicationConfig({
          ...evidence,
          PLATFORM_EVIDENCE_DELIVERY_URL: bad,
        }),
      ).toThrow("PLATFORM_EVIDENCE_DELIVERY_URL requires HTTPS");
  });

  it("keeps reconciliation cadence inside the evidence validity bound", () => {
    expect(
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_MEMBERSHIP_RECONCILIATION_CADENCE_MS: "120000",
      }).membershipReconciliationCadenceMilliseconds,
    ).toBe(120_000);
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_MEMBERSHIP_RECONCILIATION_CADENCE_MS: "300000",
      }),
    ).toThrow("TELEGRAM_MEMBERSHIP_RECONCILIATION_CADENCE_MS");
  });

  it("keeps community effects disabled and fails the endpoint closed by default", () => {
    const config = loadApplicationConfig(validEnvironment);
    expect(config.communityMode).toBe("disabled");
    expect(config.communityIntegrationSecret).toBeUndefined();
    expect(config.communityReconciliationCadenceMilliseconds).toBe(60_000);
  });

  it("requires a bot token and both dispatch credentials for live community effects", () => {
    const community = {
      ...validEnvironment,
      TELEGRAM_COMMUNITY_CONTRACT_VERSION: "inside.community-entitlement.v2",
      TELEGRAM_COMMUNITY_MODE: "live",
      PLATFORM_COMMUNITY_INTEGRATION_SECRET:
        "synthetic_community_inbound_secret",
      PLATFORM_COMMUNITY_DISPATCH_URL:
        "https://platform.test/internal/authorize",
      PLATFORM_COMMUNITY_DISPATCH_SECRET: "synthetic_community_dispatch_secret",
    };
    expect(() => loadApplicationConfig(community)).toThrow(
      "TELEGRAM_BOT_TOKEN is required for live community effects",
    );
    const withToken = { ...community, TELEGRAM_BOT_TOKEN: "synthetic-token" };
    expect(loadApplicationConfig(withToken).communityMode).toBe("live");
    for (const missing of [
      "PLATFORM_COMMUNITY_INTEGRATION_SECRET",
      "PLATFORM_COMMUNITY_DISPATCH_URL",
      "PLATFORM_COMMUNITY_DISPATCH_SECRET",
    ]) {
      expect(() =>
        loadApplicationConfig({ ...withToken, [missing]: "" }),
      ).toThrow("Live community mode requires");
    }
  });

  it("refuses a community secret shared with another direction", () => {
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_COMMUNITY_CONTRACT_VERSION: "inside.community-entitlement.v2",
        PLATFORM_COMMUNITY_INTEGRATION_SECRET:
          "synthetic_community_shared_secret",
        PLATFORM_COMMUNITY_DISPATCH_SECRET: "synthetic_community_shared_secret",
      }),
    ).toThrow("must be separate service secrets");
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        PLATFORM_COMMUNITY_INTEGRATION_SECRET: "short",
      }),
    ).toThrow("base64url credential");
  });

  it("refuses a community dispatch URL that is not a plain HTTPS endpoint", () => {
    for (const bad of [
      "http://platform.test/authorize",
      "https://user:password@platform.test/authorize",
      "https://platform.test/authorize?token=1",
      "https://platform.test/authorize#fragment",
    ]) {
      expect(() =>
        loadApplicationConfig({
          ...validEnvironment,
          PLATFORM_COMMUNITY_DISPATCH_URL: bad,
        }),
      ).toThrow("PLATFORM_COMMUNITY_DISPATCH_URL");
    }
  });

  it("bounds the community reconciliation cadence to at most one minute", () => {
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_COMMUNITY_RECONCILIATION_CADENCE_MS: "120000",
      }),
    ).toThrow("TELEGRAM_COMMUNITY_RECONCILIATION_CADENCE_MS");
  });

  it("requires community v2 to be named explicitly once the community integration is configured", () => {
    const configured = {
      ...validEnvironment,
      PLATFORM_COMMUNITY_INTEGRATION_SECRET:
        "synthetic_community_inbound_secret",
    };
    expect(() => loadApplicationConfig(configured)).toThrow(
      "TELEGRAM_COMMUNITY_CONTRACT_VERSION=inside.community-entitlement.v2 is required",
    );
    expect(
      loadApplicationConfig({
        ...configured,
        TELEGRAM_COMMUNITY_CONTRACT_VERSION: "inside.community-entitlement.v2",
      }).communityContractVersion,
    ).toBe("inside.community-entitlement.v2");
    expect(
      loadApplicationConfig(validEnvironment).communityContractVersion,
    ).toBeUndefined();
  });

  it("refuses to start with an incompatible community contract version", () => {
    for (const version of [
      "inside.community-entitlement.v1",
      "inside.community-entitlement.v3",
      "v2",
    ]) {
      expect(() =>
        loadApplicationConfig({
          ...validEnvironment,
          TELEGRAM_COMMUNITY_CONTRACT_VERSION: version,
        }),
      ).toThrow(
        "TELEGRAM_COMMUNITY_CONTRACT_VERSION must be inside.community-entitlement.v2",
      );
    }
  });

  it("keeps community removals off by default and names the flag it rejects", () => {
    expect(
      loadApplicationConfig(validEnvironment).communityRemovalsEnabled,
    ).toBe(false);
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_COMMUNITY_REMOVALS_ENABLED: "no",
      }),
    ).toThrow("TELEGRAM_COMMUNITY_REMOVALS_ENABLED must be true or false");
  });

  it("accepts an explicit Tribute bot identity only as a Telegram user id distinct from this bot", () => {
    expect(
      loadApplicationConfig(validEnvironment).communityTributeBotTelegramUserId,
    ).toBeUndefined();
    expect(
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID: "7000001",
      }).communityTributeBotTelegramUserId,
    ).toBe("7000001");
    for (const bad of ["-7000001", "0", "tribute", "7000001.5"]) {
      expect(() =>
        loadApplicationConfig({
          ...validEnvironment,
          TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID: bad,
        }),
      ).toThrow("TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID");
    }
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        TELEGRAM_BOT_TOKEN: "7000001:synthetic",
        TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID: "7000001",
      }),
    ).toThrow("TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID");
  });

  it("refuses a Notifications secret shared with the community dispatch direction", () => {
    const dispatchSecret = "synthetic_community_dispatch_secret_value";
    expect(() =>
      loadApplicationConfig({
        ...validEnvironment,
        PLATFORM_COMMUNITY_DISPATCH_SECRET: dispatchSecret,
        TELEGRAM_COMMUNITY_CONTRACT_VERSION: "inside.community-entitlement.v2",
        TELEGRAM_NOTIFICATIONS_ENABLED: "true",
        NOTIFICATION_AMQP_URL: "amqp://127.0.0.1:5673/inside-notifications",
        NOTIFICATION_AUTHORIZE_URL:
          "http://127.0.0.1:3001/internal/notifications/dispatch/authorize",
        NOTIFICATION_AUTHORIZE_SECRET: dispatchSecret,
        NOTIFICATION_QUARANTINE_KEY: "a".repeat(64),
      }),
    ).toThrow("must be separate service secrets");
  });
});
