export type DeliveryMode = "disabled" | "live";

export interface ApplicationConfig {
  readonly botIdentity: string;
  readonly botToken?: string;
  readonly databaseUrl: string;
  readonly deliveryMode: DeliveryMode;
  readonly host: string;
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
  if (deliveryMode !== "disabled" && deliveryMode !== "live") {
    throw new Error("TELEGRAM_DELIVERY_MODE must be disabled or live");
  }

  const botToken = environment.TELEGRAM_BOT_TOKEN;
  if (deliveryMode === "live" && !botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for live delivery");
  }

  return Object.freeze({
    botIdentity,
    ...(botToken ? { botToken } : {}),
    databaseUrl,
    deliveryMode,
    host: environment.HOST ?? "127.0.0.1",
    platformIntegrationSecret,
    port: parsePort(environment.PORT),
    webhookSecret,
    welcomeText: required(environment, "TELEGRAM_WELCOME_TEXT"),
    workersEnabled: parseBoolean(environment.WORKERS_ENABLED, true),
  });
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
