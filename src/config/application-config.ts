export type DeliveryMode = "disabled" | "live";
export type EvidenceDeliveryMode = "disabled" | "live";
export type MembershipMode = "disabled" | "live";

export interface ApplicationConfig {
  readonly botIdentity: string;
  readonly botToken?: string;
  readonly canonicalChatId: string;
  readonly databaseUrl: string;
  readonly deliveryMode: DeliveryMode;
  readonly evidenceDeliveryMode: EvidenceDeliveryMode;
  readonly host: string;
  readonly linkReceiptText: string;
  readonly linkedMemberText: string;
  readonly linkedNonMemberText: string;
  readonly linkedUnavailableText: string;
  readonly membershipMode: MembershipMode;
  readonly membershipReconciliationCadenceMilliseconds: number;
  readonly platformEvidenceDeliverySecret?: string;
  readonly platformEvidenceDeliveryUrl?: string;
  readonly platformIntegrationSecret: string;
  readonly port: number;
  readonly webhookSecret: string;
  readonly welcomeText: string;
  readonly workersEnabled: boolean;
}

export const APPLICATION_CONFIG = Symbol("APPLICATION_CONFIG");

export function loadApplicationConfig(
  environment: NodeJS.ProcessEnv,
): ApplicationConfig {
  const databaseUrl = required(environment, "DATABASE_URL");
  assertPostgresUrl(databaseUrl);

  const botIdentity = required(environment, "TELEGRAM_BOT_IDENTITY");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(botIdentity)) {
    throw new Error(
      "TELEGRAM_BOT_IDENTITY must be a lowercase internal identifier",
    );
  }

  const webhookSecret = required(environment, "TELEGRAM_WEBHOOK_SECRET");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must use Telegram's documented secret-token alphabet",
    );
  }

  const platformIntegrationSecret = required(
    environment,
    "PLATFORM_INTEGRATION_SECRET",
  );
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(platformIntegrationSecret)) {
    throw new Error(
      "PLATFORM_INTEGRATION_SECRET must be a base64url credential of at least 16 characters",
    );
  }

  const deliveryMode = environment.TELEGRAM_DELIVERY_MODE ?? "disabled";
  assertExternalMode(deliveryMode, "TELEGRAM_DELIVERY_MODE");

  const membershipMode = environment.TELEGRAM_MEMBERSHIP_MODE ?? "disabled";
  assertExternalMode(membershipMode, "TELEGRAM_MEMBERSHIP_MODE");
  const membershipReconciliationCadenceMilliseconds = parseBoundedInteger(
    environment.TELEGRAM_MEMBERSHIP_RECONCILIATION_CADENCE_MS,
    240_000,
    30_000,
    240_000,
    "TELEGRAM_MEMBERSHIP_RECONCILIATION_CADENCE_MS",
  );

  const evidenceDeliveryMode =
    environment.PLATFORM_EVIDENCE_DELIVERY_MODE ?? "disabled";
  assertExternalMode(evidenceDeliveryMode, "PLATFORM_EVIDENCE_DELIVERY_MODE");

  const botToken = environment.TELEGRAM_BOT_TOKEN;
  if ((deliveryMode === "live" || membershipMode === "live") && !botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for live delivery");
  }

  const canonicalChatId = required(environment, "TELEGRAM_CANONICAL_CHAT_ID");
  if (!isSafeTelegramId(canonicalChatId)) {
    throw new Error(
      "TELEGRAM_CANONICAL_CHAT_ID must be a non-zero safe Telegram integer",
    );
  }

  let platformEvidenceDeliveryUrl: string | undefined;
  let platformEvidenceDeliverySecret: string | undefined;
  if (evidenceDeliveryMode === "live") {
    platformEvidenceDeliveryUrl = required(
      environment,
      "PLATFORM_EVIDENCE_DELIVERY_URL",
    );
    assertHttpUrl(
      platformEvidenceDeliveryUrl,
      "PLATFORM_EVIDENCE_DELIVERY_URL",
    );
    platformEvidenceDeliverySecret = required(
      environment,
      "PLATFORM_EVIDENCE_DELIVERY_SECRET",
    );
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(platformEvidenceDeliverySecret)) {
      throw new Error(
        "PLATFORM_EVIDENCE_DELIVERY_SECRET must be a base64url credential of at least 16 characters",
      );
    }
  }

  return Object.freeze({
    botIdentity,
    ...(botToken ? { botToken } : {}),
    canonicalChatId,
    databaseUrl,
    deliveryMode,
    evidenceDeliveryMode,
    host: environment.HOST ?? "127.0.0.1",
    linkReceiptText: required(environment, "TELEGRAM_LINK_RECEIPT_TEXT"),
    linkedMemberText: required(environment, "TELEGRAM_LINKED_MEMBER_TEXT"),
    linkedNonMemberText: required(
      environment,
      "TELEGRAM_LINKED_NON_MEMBER_TEXT",
    ),
    linkedUnavailableText: required(
      environment,
      "TELEGRAM_LINKED_UNAVAILABLE_TEXT",
    ),
    membershipMode,
    membershipReconciliationCadenceMilliseconds,
    ...(platformEvidenceDeliverySecret
      ? { platformEvidenceDeliverySecret }
      : {}),
    ...(platformEvidenceDeliveryUrl ? { platformEvidenceDeliveryUrl } : {}),
    platformIntegrationSecret,
    port: parsePort(environment.PORT),
    webhookSecret,
    welcomeText: required(environment, "TELEGRAM_WELCOME_TEXT"),
    workersEnabled: parseBoolean(environment.WORKERS_ENABLED, true),
  });
}

function assertExternalMode(
  value: string,
  name: string,
): asserts value is "disabled" | "live" {
  if (value !== "disabled" && value !== "live") {
    throw new Error(`${name} must be disabled or live`);
  }
}

function isSafeTelegramId(value: string): boolean {
  if (!/^-?[1-9][0-9]{0,15}$/.test(value)) {
    return false;
  }
  return Number.isSafeInteger(Number(value));
}

function assertHttpUrl(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an HTTP URL`);
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertPostgresUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 3002 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("WORKERS_ENABLED must be true or false");
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}
