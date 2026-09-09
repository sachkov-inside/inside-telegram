import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import schema from "./contracts/schema.json" with { type: "json" };
export { canonicalJson, digest } from "../../security/payload-digest.js";

export type Category = "subscription" | "material";
export interface NotificationCommand {
  contractVersion: "inside.notification-delivery.v1";
  operationId: string;
  notificationRef: string;
  deliveryRef: string;
  commandRevision: number;
  sourceEventId: string;
  content: { category: Category; kind: string };
  templateRef: string;
  templateRevision: number;
  text: string;
  issuedAt: string;
  notAfter: string;
  binding: {
    channel: "telegram";
    accountRef: string;
    telegramIdentityRef: string;
    linkRef: string;
    linkRevision: number;
  };
}
export interface DispatchRequest {
  contractVersion: "inside.notification-dispatch.v1";
  operationId: string;
  deliveryOperationId: string;
  deliveryRef: string;
  commandRevision: number;
  payloadDigest: string;
  attemptRef: string;
}
export type Suppression =
  | "expired"
  | "superseded"
  | "preference_disabled"
  | "source_unavailable"
  | "access_denied"
  | "binding_conflict";
export type DispatchResponse = DispatchRequest &
  (
    | { status: "allowed"; permitRef: string; validUntil: string }
    | {
        status: "denied";
        reason:
          | Exclude<Suppression, "source_unavailable">
          | "not_found"
          | "payload_conflict";
      }
    | { status: "error"; code: string }
  );
export type ResultState =
  | { state: "accepted" }
  | {
      state: "unknown";
      reason: "interrupted_attempt" | "lost_response";
      attemptRef: string;
    }
  | { state: "sent"; receiptRef: string; attemptRef: string }
  | {
      state: "retrying";
      reason: "source_unavailable" | "rate_limited" | "provider_unavailable";
      nextAttemptAt: string;
      attemptRef: string | null;
    }
  | {
      state: "failed";
      reason: "recipient_unreachable" | "provider_rejected" | "retry_exhausted";
      attemptRef: string | null;
    }
  | { state: "suppressed"; reason: Suppression };
export type NotificationResult = ResultState & {
  contractVersion: "inside.notification-result.v1";
  messageId: string;
  operationId: string;
  deliveryRef: string;
  commandRevision: number;
  payloadDigest: string;
  resultRevision: number;
  channel: "telegram";
  recordedAt: string;
};
const ajv = new Ajv({ strict: false });
addFormats.default(ajv);
ajv.addSchema(schema);
export const notificationValidator = (definition: string) =>
  ajv.compile({ $ref: `${schema.$id}#/definitions/${definition}` });
const validCommand = notificationValidator("telegramDelivery");
export const validDispatchResponse = ajv.compile({
  oneOf: ["allowed", "denied", "dispatchError"].map((name) => ({
    $ref: `${schema.$id}#/definitions/${name}`,
  })),
});
export interface DeliveryEnvelope {
  exchange: string;
  routingKey: string;
  contentType?: string;
  type?: string;
  messageId?: string;
  persistent?: boolean;
}
export function parseNotification(
  bytes: Buffer,
  envelope: DeliveryEnvelope,
  category: Category,
): NotificationCommand | undefined {
  if (
    bytes.length > 16384 ||
    envelope.exchange !== "inside.notifications.telegram.v1" ||
    envelope.routingKey !== category ||
    envelope.contentType !== "application/json" ||
    envelope.type !== "inside.notification-delivery.v1" ||
    !envelope.persistent
  )
    return;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!validCommand(value)) return;
    const c = value as NotificationCommand;
    if (
      c.content.category !== category ||
      envelope.messageId?.toLowerCase() !== c.operationId.toLowerCase()
    )
      return;
    const issued = Date.parse(c.issuedAt),
      end = Date.parse(c.notAfter);
    if (!(end > issued && end <= issued + 600000)) return;
    for (const key of [
      "operationId",
      "notificationRef",
      "deliveryRef",
      "sourceEventId",
    ] as const)
      c[key] = c[key].toLowerCase();
    c.binding.linkRef = c.binding.linkRef.toLowerCase();
    return c;
  } catch {
    return;
  }
}
