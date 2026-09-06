import { isDeepStrictEqual } from "node:util";
import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Transaction } from "kysely";
import {
  DATABASE,
  type Database,
  type DatabaseSchema,
} from "../../database/database.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { CLOCK, type Clock } from "../identity-linking/clock.js";
import { communicationLock } from "./communication-state.js";
import {
  CommunicationsError,
  type CommunicationsRequest,
  type TemplateContent,
} from "./communications-contract.js";

export function isTrackingDestination(
  value: string,
  config: ApplicationConfig,
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname.replace(/\.$/, "") === "api.telegram.org"
  )
    return false;
  // Match normalized URL path boundaries, never a caller-provided redirect target.
  return (config.platformTrackingTargetPrefixes ?? []).some((prefix) => {
    const allowed = new URL(prefix);
    return (
      allowed.origin === url.origin &&
      url.pathname.startsWith(allowed.pathname) &&
      url.pathname !== allowed.pathname
    );
  });
}
export async function trackedContent(
  tx: Transaction<DatabaseSchema>,
  config: ApplicationConfig,
  deliveryId: string,
  partId: string,
  content: TemplateContent,
  now: Date,
): Promise<TemplateContent> {
  if (!config.platformTrackingRedirectUrl) return content;
  async function link(value: string): Promise<string> {
    if (!isTrackingDestination(value, config)) return value;
    const existing = await tx
      .selectFrom("communication_tracking_tokens")
      .select("token")
      .where("delivery_id", "=", deliveryId)
      .where("part_id", "=", partId)
      .where("destination", "=", value)
      .executeTakeFirst();
    const token = existing?.token ?? randomBytes(32).toString("base64url");
    if (!existing)
      await tx
        .insertInto("communication_tracking_tokens")
        .values({
          token,
          bot_identity: config.botIdentity,
          delivery_id: deliveryId,
          part_id: partId,
          destination: value,
          created_at: now,
        })
        .execute();
    const redirect = new URL(config.platformTrackingRedirectUrl!);
    redirect.searchParams.set("token", token);
    return redirect.toString();
  }
  const buttons = [];
  for (const button of content.buttons)
    buttons.push({ ...button, url: await link(button.url) });
  const entities = [];
  for (const entity of content.entities) {
    if (entity.type === "text_link" && entity.url)
      entities.push({ ...entity, url: await link(entity.url) });
    else if (entity.type === "url") {
      const original = content.text.slice(
        entity.offset,
        entity.offset + entity.length,
      );
      const tracked = await link(original);
      entities.push(
        tracked === original
          ? entity
          : { ...entity, type: "text_link", url: tracked },
      );
    } else entities.push(entity);
  }
  return { ...content, buttons, entities };
}
@Injectable()
export class CommunicationTracking {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  async execute(request: CommunicationsRequest) {
    if (
      !("serviceRef" in request.actor) ||
      request.actor.serviceRef !== "platform-tracking"
    )
      throw new CommunicationsError("forbidden");
    if (!["tracking.resolve", "tracking.recordHit"].includes(request.operation))
      throw new CommunicationsError("forbidden");
    return this.database.transaction().execute(async (tx) => {
      if (request.operation === "tracking.recordHit") {
        await communicationLock(
          tx,
          `communications-operation:${this.config.botIdentity}:${request.operationId}`,
        );
        const operation = await tx
          .selectFrom("communication_operations")
          .selectAll()
          .where("bot_identity", "=", this.config.botIdentity)
          .where("operation_id", "=", request.operationId)
          .executeTakeFirst();
        if (
          operation &&
          (operation.actor_account_ref !== "service:platform-tracking" ||
            !isDeepStrictEqual(operation.request, request))
        )
          throw new CommunicationsError("operation_conflict");
        if (!operation)
          await tx
            .insertInto("communication_operations")
            .values({
              bot_identity: this.config.botIdentity,
              operation_id: request.operationId,
              actor_account_ref: "service:platform-tracking",
              request: JSON.stringify(request),
              result: JSON.stringify({ eventId: request.payload.eventId }),
              created_at: this.clock.now(),
            })
            .execute();
      }
      const token = await tx
        .selectFrom("communication_tracking_tokens")
        .selectAll()
        .where("bot_identity", "=", this.config.botIdentity)
        .where("token", "=", request.payload.token!)
        .executeTakeFirst();
      if (!token || !isTrackingDestination(token.destination, this.config))
        throw new CommunicationsError("not_found");
      if (request.operation === "tracking.resolve")
        return { safeUrl: token.destination };
      const now = this.clock.now();
      const occurred = new Date(request.payload.occurredAt!);
      if (+occurred > +now + 60_000 || +occurred < +token.created_at - 60_000)
        throw new CommunicationsError("malformed");
      await communicationLock(
        tx,
        `communications-hit:${this.config.botIdentity}:${request.payload.eventId}`,
      );
      const prior = await tx
        .selectFrom("communication_tracking_hits")
        .selectAll()
        .where("bot_identity", "=", this.config.botIdentity)
        .where("event_id", "=", request.payload.eventId!)
        .executeTakeFirst();
      if (prior) {
        if (
          prior.token !== token.token ||
          +prior.occurred_at !== +occurred ||
          prior.traffic !== request.payload.traffic
        )
          throw new CommunicationsError("operation_conflict");
        return { eventId: prior.event_id, outcome: "duplicate" };
      }
      await tx
        .insertInto("communication_tracking_hits")
        .values({
          bot_identity: this.config.botIdentity,
          event_id: request.payload.eventId!,
          token: token.token,
          occurred_at: occurred,
          received_at: now,
          traffic: request.payload.traffic!,
        })
        .execute();
      return { eventId: request.payload.eventId!, outcome: "recorded" };
    });
  }
}
