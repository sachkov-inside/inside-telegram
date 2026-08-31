import "reflect-metadata";

import { createServer, type IncomingMessage } from "node:http";

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import type { ApplicationConfig } from "../src/config/application-config.js";
import { createDatabase } from "../src/database/create-database.js";
import { migrateToLatest } from "../src/database/migrator.js";
import {
  TELEGRAM_MEMBERSHIP,
  type TelegramChatMemberResult,
  type TelegramMembership,
} from "../src/modules/membership-evidence/telegram-membership.js";

const databaseUrl = localProofUrl(required("DATABASE_URL"), "DATABASE_URL");
const evidenceUrl = localProofUrl(
  required("CONFORMANCE_PLATFORM_EVIDENCE_URL"),
  "CONFORMANCE_PLATFORM_EVIDENCE_URL",
);
const appPort = port("CONFORMANCE_TELEGRAM_PORT", 44_102);
const controlPort = port("CONFORMANCE_TELEGRAM_CONTROL_PORT", 44_103);

class ControlledTelegramMembership implements TelegramMembership {
  calls = 0;
  botState: "administrator" | "member" | "unavailable" = "administrator";
  subjectState: "left" | "member" | "unavailable" = "member";

  async getBotChatMember(): Promise<TelegramChatMemberResult> {
    this.calls += 1;
    return result(this.botState);
  }

  async getChatMember(): Promise<TelegramChatMemberResult> {
    this.calls += 1;
    return result(this.subjectState);
  }
}

const config: ApplicationConfig = {
  botIdentity: "inside-proof",
  botToken: "synthetic-proof-token",
  canonicalChatId: "-1000000000000",
  databaseUrl,
  deliveryMode: "disabled",
  evidenceDeliveryMode: "live",
  host: "127.0.0.1",
  linkReceiptText: "Synthetic link receipt",
  linkedMemberText: "Synthetic member",
  linkedNonMemberText: "Synthetic non-member",
  linkedUnavailableText: "Synthetic unavailable",
  membershipMode: "live",
  membershipReconciliationCadenceMilliseconds: 30_000,
  platformEvidenceDeliverySecret: required("CONFORMANCE_EVIDENCE_SECRET"),
  platformEvidenceDeliveryUrl: evidenceUrl,
  platformIntegrationSecret: required("CONFORMANCE_LINK_SECRET"),
  port: appPort,
  webhookSecret: required("CONFORMANCE_WEBHOOK_SECRET"),
  welcomeText: "Synthetic welcome",
  workersEnabled: true,
};

const migrationDatabase = createDatabase(databaseUrl);
await migrateToLatest(migrationDatabase);
await migrationDatabase.destroy();

const membership = new ControlledTelegramMembership();
const module = await Test.createTestingModule({
  imports: [AppModule.register(config)],
})
  .overrideProvider(TELEGRAM_MEMBERSHIP)
  .useValue(membership)
  .compile();
const application = module.createNestApplication<NestFastifyApplication>(
  new FastifyAdapter({ bodyLimit: 1024 * 1024 }),
);
await application.listen(appPort, "127.0.0.1");

const control = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.method === "GET" && request.url === "/state") {
    response.end(
      JSON.stringify({
        botState: membership.botState,
        calls: membership.calls,
        subjectState: membership.subjectState,
      }),
    );
    return;
  }
  if (request.method === "POST" && request.url === "/state") {
    const body = await readBody(request);
    if (isBotState(body.botState)) {
      membership.botState = body.botState;
    }
    if (isSubjectState(body.subjectState)) {
      membership.subjectState = body.subjectState;
    }
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((resolve) =>
  control.listen(controlPort, "127.0.0.1", resolve),
);

process.stdout.write(
  `Telegram conformance provider listening on 127.0.0.1:${String(appPort)}; control 127.0.0.1:${String(controlPort)}\n`,
);

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => control.close(() => resolve()));
  await application.close();
}

process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));

function result(
  state: "administrator" | "left" | "member" | "unavailable",
): TelegramChatMemberResult {
  return state === "unavailable"
    ? { diagnosticCode: "controlled_provider_outage", kind: "unavailable" }
    : { kind: "observed", value: { status: state } };
}

function isBotState(
  value: unknown,
): value is ControlledTelegramMembership["botState"] {
  return (
    value === "administrator" || value === "member" || value === "unavailable"
  );
}

function isSubjectState(
  value: unknown,
): value is ControlledTelegramMembership["subjectState"] {
  return value === "left" || value === "member" || value === "unavailable";
}

async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Control body must be an object");
  }
  return Object.fromEntries(Object.entries(parsed));
}

function localProofUrl(value: string, name: string): string {
  const url = new URL(value);
  if (
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    (name === "DATABASE_URL" &&
      !/(proof|conformance)/u.test(url.pathname.toLowerCase()))
  ) {
    throw new Error(`${name} must target a loopback proof database/endpoint`);
  }
  return value;
}

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid port`);
  }
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
