import "reflect-metadata";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module.js";
import { loadApplicationConfig } from "../src/config/application-config.js";
import { createDatabase } from "../src/database/create-database.js";
import { migrateToLatest } from "../src/database/migrator.js";
import {
  TELEGRAM_MESSAGES,
  type TelegramMessages,
} from "../src/modules/outbound/telegram-messages.js";
import { StartResponseDeliveryProcessor } from "../src/modules/outbound/start-response-delivery-processor.js";
import { CLOCK } from "../src/modules/identity-linking/clock.js";
import {
  COMMUNICATION_TRANSPORT,
  type CommunicationMessage,
} from "../src/modules/communications/communication-delivery.js";
import { FunnelScheduler } from "../src/modules/communications/funnel-scheduler.js";
import { TelegramUpdateProcessor } from "../src/modules/update-inbox/telegram-update-processor.js";
import {
  localProofDatabaseUrl,
  loopbackHttpUrl,
} from "./conformance-safety.js";

// Repository-owned adapter environment: real HTTP/DB/application, synthetic clock and send port.
// No bot token is loaded, and every callback is constrained to loopback.
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    encoding: "utf8",
  }).trim().length > 0;
const databaseUrl = localProofDatabaseUrl(
  process.env.DATABASE_URL ?? "",
  "DATABASE_URL",
);
const platform = loopbackHttpUrl(
  process.env.CONFORMANCE_PLATFORM_URL ?? "http://127.0.0.1:44111",
  "CONFORMANCE_PLATFORM_URL",
);
const config = {
  ...loadApplicationConfig({
    DATABASE_URL: databaseUrl,
    TELEGRAM_BOT_IDENTITY: "synthetic-bot",
    TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
    TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook",
    PLATFORM_INTEGRATION_SECRET: "synthetic_communications_secret",
    PLATFORM_AUTHOR_AUTHORIZATION_URL: `${platform}/integrations/telegram/v1/communications/authorize`,
    PLATFORM_AUTHOR_CONTENT_VALIDATION_URL: `${platform}/integrations/telegram/v1/communications/validate-content`,
    PLATFORM_AUTHOR_AUTHORIZATION_SECRET: "synthetic_authorization_secret",
    PLATFORM_TRACKING_REDIRECT_URL: "https://inside.example/c",
    PLATFORM_TRACKING_TARGET_PREFIXES: JSON.stringify([
      "https://inside.example/materials/",
      "https://inside.example/series/",
    ]),
    TELEGRAM_WELCOME_TEXT: "Synthetic welcome",
    TELEGRAM_LINK_RECEIPT_TEXT: "Synthetic receipt",
    TELEGRAM_LINKED_MEMBER_TEXT: "Synthetic member",
    TELEGRAM_LINKED_NON_MEMBER_TEXT: "Synthetic non-member",
    TELEGRAM_LINKED_UNAVAILABLE_TEXT: "Synthetic unavailable",
    TELEGRAM_MARKETING_ENABLED: "true",
    WORKERS_ENABLED: "false",
  }),
};
const database = createDatabase(databaseUrl);
await migrateToLatest(database);
await database.destroy();
let now = new Date();
let outcome:
  "delivered" | "transport_unknown" | "retry_after" | "permanent_failure" =
  "delivered";
const sent: CommunicationMessage[] = [];
const serviceMessages: string[] = [];
const serviceTransport: TelegramMessages = {
  async sendText(message) {
    serviceMessages.push(message.text);
    return { kind: "delivered", providerMessageId: "123" };
  },
  async editText() {
    return { kind: "delivered", providerMessageId: "123" };
  },
};
const module = await Test.createTestingModule({
  imports: [AppModule.register(config)],
})
  .overrideProvider(CLOCK)
  .useValue({ now: () => new Date(now) })
  .overrideProvider(TELEGRAM_MESSAGES)
  .useValue(serviceTransport)
  .overrideProvider(COMMUNICATION_TRANSPORT)
  .useValue({
    async send(message: CommunicationMessage) {
      sent.push(message);
      if (outcome === "delivered")
        return { kind: outcome, providerMessageId: `synthetic-${sent.length}` };
      if (outcome === "retry_after")
        return {
          kind: "api_retryable",
          providerErrorCode: 429,
          retryAfterSeconds: 30,
        };
      if (outcome === "permanent_failure")
        return { kind: "api_rejected", providerErrorCode: 400 };
      return { kind: outcome };
    },
  })
  .compile();
const app = module.createNestApplication<NestFastifyApplication>(
  new FastifyAdapter(),
  { logger: false },
);
await app.listen(44112, "127.0.0.1");
const control = Fastify();
control.addHook("onRequest", async (request, reply) => {
  if (request.headers.authorization !== "Bearer synthetic_control_secret")
    await reply.code(401).send({ error: "unauthorized" });
});
control.get("/state", () => ({
  now: now.toISOString(),
  revision,
  dirty,
  sent,
  serviceMessages,
  simulated: true,
}));
control.post<{
  Body: {
    advanceSeconds?: number;
    outcome?: typeof outcome;
    limit?: number;
    marketingEnabled?: boolean;
  };
}>(
  "/tick",
  {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          advanceSeconds: { type: "integer", minimum: 0, maximum: 31536000 },
          limit: { type: "integer", minimum: 0, maximum: 100 },
          outcome: {
            enum: [
              "delivered",
              "transport_unknown",
              "retry_after",
              "permanent_failure",
            ],
          },
          marketingEnabled: { type: "boolean" },
        },
      },
    },
  },
  async (request) => {
    now = new Date(+now + (request.body.advanceSeconds ?? 0) * 1000);
    if (request.body.outcome) outcome = request.body.outcome;
    if (request.body.marketingEnabled !== undefined)
      Object.assign(config, {
        marketingEnabled: request.body.marketingEnabled,
      });
    await app.get(TelegramUpdateProcessor).processAvailable(100, now);
    await app.get(StartResponseDeliveryProcessor).processAvailable(100, now);
    const processed = await app
      .get(FunnelScheduler)
      .processAvailable(request.body.limit ?? 100);
    return { processed, now: now.toISOString(), simulated: true };
  },
);
await control.listen({ host: "127.0.0.1", port: 44113 });
process.stdout.write(
  "Communications provider ready on loopback 44112; synthetic control 44113. No Telegram sends.\n",
);
async function shutdown() {
  await control.close();
  await app.close();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
