import {
  loadNotificationConfig,
  type NotificationConfig,
} from "./notification-config.js";
export type DeliveryMode = "disabled" | "live";
export type EvidenceDeliveryMode = "disabled" | "live";
export type MembershipMode = "disabled" | "live";
export type CommunityMode = "disabled" | "live";

/** Private-chat wording for the contact's own admission request. */
export interface CommunityTexts {
  readonly invite: string;
  readonly preparing: string;
  readonly member: string;
  readonly unavailable: string;
}

export interface ApplicationConfig {
  readonly notifications?: NotificationConfig;
  readonly botIdentity: string;
  readonly botToken?: string;
  readonly canonicalChatId: string;
  readonly communityMode: CommunityMode;
  readonly communityIntegrationSecret?: string;
  readonly communityDispatchUrl?: string;
  readonly communityDispatchSecret?: string;
  readonly communityReconciliationCadenceMilliseconds: number;
  readonly communityTexts: CommunityTexts;
  readonly databaseUrl: string;
  readonly deliveryMode: DeliveryMode;
  readonly marketingEnabled: boolean;
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
  readonly platformAuthorAuthorizationUrl?: string;
  readonly platformAuthorContentValidationUrl?: string;
  readonly platformAuthorAuthorizationSecret?: string;
  readonly platformIntegrationSecret: string;
  readonly platformTrackingRedirectUrl?: string;
  readonly platformTrackingTargetPrefixes?: readonly string[];
  readonly port: number;
  readonly signInEnabled?: boolean;
  readonly signInIntegrationSecret?: string;
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

  const signInFlag = environment.TELEGRAM_SIGN_IN_ENABLED ?? "false";
  if (signInFlag !== "true" && signInFlag !== "false") {
    throw new Error("TELEGRAM_SIGN_IN_ENABLED must be true or false");
  }
  const signInEnabled = signInFlag === "true";
  const signInIntegrationSecret = signInEnabled
    ? required(environment, "TELEGRAM_SIGN_IN_INTEGRATION_SECRET")
    : environment.TELEGRAM_SIGN_IN_INTEGRATION_SECRET?.trim() || undefined;
  if (
    signInIntegrationSecret &&
    (!/^[A-Za-z0-9_-]{32,256}$/.test(signInIntegrationSecret) ||
      signInIntegrationSecret === platformIntegrationSecret)
  ) {
    throw new Error(
      "TELEGRAM_SIGN_IN_INTEGRATION_SECRET must be a separate base64url credential of at least 32 characters",
    );
  }

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

  const communityMode = environment.TELEGRAM_COMMUNITY_MODE ?? "disabled";
  assertExternalMode(communityMode, "TELEGRAM_COMMUNITY_MODE");
  const communityReconciliationCadenceMilliseconds = parseBoundedInteger(
    environment.TELEGRAM_COMMUNITY_RECONCILIATION_CADENCE_MS,
    60_000,
    15_000,
    60_000,
    "TELEGRAM_COMMUNITY_RECONCILIATION_CADENCE_MS",
  );
  const communityTexts: CommunityTexts = Object.freeze({
    invite:
      environment.TELEGRAM_COMMUNITY_INVITE_TEXT?.trim() ||
      "Ссылка на вход в сообщество. Она действует несколько минут и только для вас.",
    preparing:
      environment.TELEGRAM_COMMUNITY_PREPARING_TEXT?.trim() ||
      "Готовим вход в сообщество. Напишите /community ещё раз через минуту.",
    member:
      environment.TELEGRAM_COMMUNITY_MEMBER_TEXT?.trim() ||
      "Вы уже участник сообщества.",
    unavailable:
      environment.TELEGRAM_COMMUNITY_UNAVAILABLE_TEXT?.trim() ||
      "Сейчас у вас нет действующего права на участие в сообществе.",
  });
  const communityIntegrationSecret =
    environment.PLATFORM_COMMUNITY_INTEGRATION_SECRET?.trim() || undefined;
  const communityDispatchUrl =
    environment.PLATFORM_COMMUNITY_DISPATCH_URL?.trim() || undefined;
  const communityDispatchSecret =
    environment.PLATFORM_COMMUNITY_DISPATCH_SECRET?.trim() || undefined;
  for (const [name, value] of [
    ["PLATFORM_COMMUNITY_INTEGRATION_SECRET", communityIntegrationSecret],
    ["PLATFORM_COMMUNITY_DISPATCH_SECRET", communityDispatchSecret],
  ] as const) {
    if (value && !/^[A-Za-z0-9_-]{32,256}$/.test(value)) {
      throw new Error(
        `${name} must be a base64url credential of at least 32 characters`,
      );
    }
  }
  // Each direction keeps its own service secret; no existing caller inherits community authority.
  if (
    communityIntegrationSecret &&
    [
      platformIntegrationSecret,
      signInIntegrationSecret,
      communityDispatchSecret,
    ].includes(communityIntegrationSecret)
  ) {
    throw new Error(
      "PLATFORM_COMMUNITY_INTEGRATION_SECRET must differ from every other service secret",
    );
  }
  if (communityDispatchUrl) {
    assertHttpUrl(communityDispatchUrl, "PLATFORM_COMMUNITY_DISPATCH_URL");
    const url = new URL(communityDispatchUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ) {
      throw new Error(
        "PLATFORM_COMMUNITY_DISPATCH_URL requires HTTPS (HTTP only on loopback), without credentials, query or fragment",
      );
    }
  }
  if (communityMode === "live") {
    if (!botToken) {
      throw new Error(
        "TELEGRAM_BOT_TOKEN is required for live community effects",
      );
    }
    if (
      !communityIntegrationSecret ||
      !communityDispatchUrl ||
      !communityDispatchSecret
    ) {
      throw new Error(
        "Live community mode requires PLATFORM_COMMUNITY_INTEGRATION_SECRET, PLATFORM_COMMUNITY_DISPATCH_URL and PLATFORM_COMMUNITY_DISPATCH_SECRET",
      );
    }
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

  const platformAuthorAuthorizationUrl =
    environment.PLATFORM_AUTHOR_AUTHORIZATION_URL;
  const platformAuthorAuthorizationSecret =
    environment.PLATFORM_AUTHOR_AUTHORIZATION_SECRET;
  if (platformAuthorAuthorizationUrl || platformAuthorAuthorizationSecret) {
    if (
      !platformAuthorAuthorizationUrl ||
      !platformAuthorAuthorizationSecret ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(platformAuthorAuthorizationSecret)
    )
      throw new Error(
        "Both PLATFORM_AUTHOR_AUTHORIZATION_URL and a valid PLATFORM_AUTHOR_AUTHORIZATION_SECRET are required",
      );
    assertHttpUrl(
      platformAuthorAuthorizationUrl,
      "PLATFORM_AUTHOR_AUTHORIZATION_URL",
    );
    const url = new URL(platformAuthorAuthorizationUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error(
        "PLATFORM_AUTHOR_AUTHORIZATION_URL requires HTTPS (HTTP only on loopback), without credentials, query or fragment",
      );
  }

  const platformAuthorContentValidationUrl =
    environment.PLATFORM_AUTHOR_CONTENT_VALIDATION_URL;
  if (platformAuthorContentValidationUrl) {
    if (!platformAuthorAuthorizationUrl || !platformAuthorAuthorizationSecret)
      throw new Error(
        "PLATFORM_AUTHOR_CONTENT_VALIDATION_URL requires author authorization configuration",
      );
    assertHttpUrl(
      platformAuthorContentValidationUrl,
      "PLATFORM_AUTHOR_CONTENT_VALIDATION_URL",
    );
    const url = new URL(platformAuthorContentValidationUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error(
        "PLATFORM_AUTHOR_CONTENT_VALIDATION_URL requires HTTPS (HTTP only on loopback), without credentials, query or fragment",
      );
  }

  let platformTrackingRedirectUrl = environment.PLATFORM_TRACKING_REDIRECT_URL;
  let platformTrackingTargetPrefixes: string[] | undefined;
  if (
    platformTrackingRedirectUrl ||
    environment.PLATFORM_TRACKING_TARGET_PREFIXES
  ) {
    if (
      !platformTrackingRedirectUrl ||
      !environment.PLATFORM_TRACKING_TARGET_PREFIXES
    )
      throw new Error(
        "Both tracking redirect URL and target prefixes are required",
      );
    const prefixes: unknown = JSON.parse(
      environment.PLATFORM_TRACKING_TARGET_PREFIXES,
    );
    if (
      !Array.isArray(prefixes) ||
      !prefixes.length ||
      prefixes.length > 20 ||
      prefixes.some((p) => typeof p !== "string")
    )
      throw new Error("Invalid tracking target prefixes");
    platformTrackingTargetPrefixes = prefixes as string[];
    for (const value of [
      platformTrackingRedirectUrl,
      ...platformTrackingTargetPrefixes,
    ]) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.hostname.replace(/\.$/, "") === "api.telegram.org"
      )
        throw new Error(
          "Tracking URLs require HTTPS without credentials, query or fragment",
        );
    }
    if (
      platformTrackingTargetPrefixes.some((p) => {
        const u = new URL(p);
        return (
          u.pathname === "/" || !u.pathname.endsWith("/") || p !== u.toString()
        );
      })
    )
      throw new Error(
        "Tracking target prefixes require normalized non-root paths ending in slash",
      );
    platformTrackingRedirectUrl = new URL(
      platformTrackingRedirectUrl,
    ).toString();
    if (
      platformTrackingTargetPrefixes.some((p) =>
        platformTrackingRedirectUrl!.startsWith(p),
      )
    )
      throw new Error("Tracking redirect cannot be a tracking destination");
  }
  return Object.freeze({
    notifications: loadNotificationConfig(environment),
    ...(platformTrackingRedirectUrl
      ? { platformTrackingRedirectUrl, platformTrackingTargetPrefixes }
      : {}),
    ...(platformAuthorContentValidationUrl
      ? { platformAuthorContentValidationUrl }
      : {}),
    ...(platformAuthorAuthorizationUrl
      ? { platformAuthorAuthorizationUrl, platformAuthorAuthorizationSecret }
      : {}),
    botIdentity,
    ...(botToken ? { botToken } : {}),
    canonicalChatId,
    communityMode,
    ...(communityIntegrationSecret ? { communityIntegrationSecret } : {}),
    ...(communityDispatchUrl ? { communityDispatchUrl } : {}),
    ...(communityDispatchSecret ? { communityDispatchSecret } : {}),
    communityReconciliationCadenceMilliseconds,
    communityTexts,
    databaseUrl,
    deliveryMode,
    marketingEnabled: parseBoolean(
      environment.TELEGRAM_MARKETING_ENABLED,
      false,
    ),
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
    signInEnabled,
    ...(signInIntegrationSecret ? { signInIntegrationSecret } : {}),
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
