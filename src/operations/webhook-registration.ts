import {
  TELEGRAM_WEBHOOK_ALLOWED_UPDATES,
  TELEGRAM_WEBHOOK_PATH,
} from "../modules/webhook/telegram-webhook.js";
import { assertServiceSecret } from "../config/service-secret.js";

const WEBHOOK_PATH = `/${TELEGRAM_WEBHOOK_PATH}`;
/** Telegram delivers webhooks only to these HTTPS ports; 88 is the relay route. */
const WEBHOOK_PORTS = new Set(["", "80", "88", "443", "8443"]);

export interface WebhookRegistrationRequest {
  readonly url: string;
  readonly ip_address?: string;
  readonly max_connections?: number;
  readonly allowed_updates: readonly string[];
  readonly secret_token: string;
  readonly drop_pending_updates: false;
}

/** Operator output: no token, secret, hostname or address. */
export interface WebhookRegistrationSummary {
  readonly port: string;
  readonly ipAddressPreserved: boolean;
  readonly maxConnections: number | null;
  readonly addedUpdates: readonly string[];
  readonly removedUpdates: readonly string[];
  readonly pendingUpdateCount: number | null;
}

export type WebhookRegistrationPlan =
  | {
      readonly kind: "refused";
      readonly reason: "not_registered" | "url_mismatch" | "custom_certificate";
    }
  | { readonly kind: "current"; readonly summary: WebhookRegistrationSummary }
  | {
      readonly kind: "update";
      readonly request: WebhookRegistrationRequest;
      readonly summary: WebhookRegistrationSummary;
    };

/**
 * Changes only the subscribed update types of an existing registration. The exact URL
 * (including the relay port), ip_address and connection limit are read back from
 * Telegram and kept; an unexpected registration is refused instead of overwritten.
 */
export function planWebhookRegistration(
  info: unknown,
  expectedUrl: string,
  secretToken: string,
): WebhookRegistrationPlan {
  assertWebhookUrl(expectedUrl);
  assertServiceSecret(secretToken, "TELEGRAM_WEBHOOK_SECRET");
  const current = isRecord(info) ? info : {};
  const url = typeof current.url === "string" ? current.url : "";
  if (!url) return { kind: "refused", reason: "not_registered" };
  if (url !== expectedUrl) return { kind: "refused", reason: "url_mismatch" };
  if (current.has_custom_certificate === true)
    return { kind: "refused", reason: "custom_certificate" };

  const subscribed = updateNames(current.allowed_updates);
  const required: readonly string[] = TELEGRAM_WEBHOOK_ALLOWED_UPDATES;
  const ipAddress =
    typeof current.ip_address === "string" && current.ip_address
      ? current.ip_address
      : undefined;
  const maxConnections = Number.isSafeInteger(current.max_connections)
    ? (current.max_connections as number)
    : undefined;
  const summary: WebhookRegistrationSummary = {
    port: new URL(url).port || "443",
    ipAddressPreserved: ipAddress !== undefined,
    maxConnections: maxConnections ?? null,
    addedUpdates: required.filter((name) => !subscribed.includes(name)),
    removedUpdates: subscribed.filter((name) => !required.includes(name)),
    pendingUpdateCount: Number.isSafeInteger(current.pending_update_count)
      ? (current.pending_update_count as number)
      : null,
  };
  if (!summary.addedUpdates.length && !summary.removedUpdates.length)
    return { kind: "current", summary };
  return {
    kind: "update",
    request: {
      url,
      ...(ipAddress ? { ip_address: ipAddress } : {}),
      ...(maxConnections !== undefined
        ? { max_connections: maxConnections }
        : {}),
      allowed_updates: [...required],
      secret_token: secretToken,
      drop_pending_updates: false,
    },
    summary,
  };
}

/** A timeout is never success: only a read-back with every kept field confirms it. */
export function webhookRegistrationApplied(
  request: WebhookRegistrationRequest,
  info: unknown,
): boolean {
  if (!isRecord(info) || info.url !== request.url) return false;
  if (
    request.ip_address !== undefined &&
    info.ip_address !== request.ip_address
  )
    return false;
  if (
    request.max_connections !== undefined &&
    info.max_connections !== request.max_connections
  )
    return false;
  const subscribed = updateNames(info.allowed_updates);
  return (
    subscribed.length === request.allowed_updates.length &&
    request.allowed_updates.every((name) => subscribed.includes(name))
  );
}

function assertWebhookUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TELEGRAM_WEBHOOK_URL must be the registered HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== WEBHOOK_PATH ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !WEBHOOK_PORTS.has(url.port)
  )
    throw new Error(
      `TELEGRAM_WEBHOOK_URL must be https://<host>[:${[...WEBHOOK_PORTS].filter(Boolean).join("|")}]${WEBHOOK_PATH} without query or credentials`,
    );
}

function updateNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
