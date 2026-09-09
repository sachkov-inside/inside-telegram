export interface NotificationConfig {
  brokerUrl: string;
  authorizeUrl: string;
  authorizeSecret: string;
  quarantineKey: string;
  prefetch: number;
  batchSize: number;
}
export function loadNotificationConfig(
  env: NodeJS.ProcessEnv,
): NotificationConfig | undefined {
  if (
    env.TELEGRAM_NOTIFICATIONS_ENABLED === undefined ||
    env.TELEGRAM_NOTIFICATIONS_ENABLED === "false"
  )
    return;
  if (env.TELEGRAM_NOTIFICATIONS_ENABLED !== "true")
    throw new Error("TELEGRAM_NOTIFICATIONS_ENABLED must be true or false");
  const brokerUrl = required(env, "NOTIFICATION_AMQP_URL"),
    authorizeUrl = required(env, "NOTIFICATION_AUTHORIZE_URL");
  for (const [value, secure, local] of [
    [brokerUrl, "amqps:", "amqp:"],
    [authorizeUrl, "https:", "http:"],
  ] as const) {
    const url = new URL(value);
    if (
      url.protocol !== secure &&
      !(
        url.protocol === local &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error("Notifications require TLS outside loopback");
  }
  const endpoint = new URL(authorizeUrl);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/internal/notifications/dispatch/authorize"
  )
    throw new Error("Invalid Notification authorization endpoint");
  const authorizeSecret = required(env, "NOTIFICATION_AUTHORIZE_SECRET");
  if (
    !/^[A-Za-z0-9_-]{32,256}$/.test(authorizeSecret) ||
    [
      env.PLATFORM_INTEGRATION_SECRET,
      env.PLATFORM_AUTHOR_AUTHORIZATION_SECRET,
      env.COMMUNITY_DISPATCH_SECRET,
    ].includes(authorizeSecret)
  )
    throw new Error("Notifications require a separate service secret");
  const quarantineKey = required(env, "NOTIFICATION_QUARANTINE_KEY");
  if (!/^[a-f0-9]{64}$/.test(quarantineKey))
    throw new Error(
      "Notification quarantine key must be 32 bytes in hexadecimal",
    );
  return {
    brokerUrl,
    authorizeUrl,
    authorizeSecret,
    quarantineKey,
    prefetch: bounded(env.NOTIFICATION_PREFETCH, 10, 1, 100),
    batchSize: bounded(env.NOTIFICATION_BATCH_SIZE, 5, 1, 100),
  };
}
function required(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}
function bounded(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error("Invalid notification capacity");
  return n;
}
