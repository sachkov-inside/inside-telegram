import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../../src/app.module.js";
import { loadApplicationConfig } from "../../src/config/application-config.js";
import { createDatabase } from "../../src/database/create-database.js";
import { migrateToLatest } from "../../src/database/migrator.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const database = createDatabase(databaseUrl);
const execute = promisify(execFile);
let application: NestFastifyApplication;
let port: string;

beforeAll(async () => {
  await migrateToLatest(database);
  await sql`create schema readiness_empty`.execute(database);
  const config = loadApplicationConfig({
    DATABASE_URL: databaseUrl,
    TELEGRAM_BOT_IDENTITY: "inside",
    TELEGRAM_CANONICAL_CHAT_ID: "-1000000000000",
    TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook_secret",
    PLATFORM_INTEGRATION_SECRET: "synthetic_platform_secret",
    TELEGRAM_WELCOME_TEXT: "Synthetic welcome",
    TELEGRAM_LINK_RECEIPT_TEXT: "Synthetic receipt",
    TELEGRAM_LINKED_MEMBER_TEXT: "Synthetic member",
    TELEGRAM_LINKED_NON_MEMBER_TEXT: "Synthetic non-member",
    TELEGRAM_LINKED_UNAVAILABLE_TEXT: "Synthetic unavailable",
    WORKERS_ENABLED: "false",
  });
  application = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    new FastifyAdapter(),
    { logger: false },
  );
  await application.listen(0, "127.0.0.1");
  port = new URL(await application.getUrl()).port;
});

afterAll(async () => {
  await application?.close();
  await sql`drop schema if exists readiness_empty`.execute(database);
  await database.destroy();
});

function probe(connectionString: string, applicationPort = port) {
  return execute(
    process.execPath,
    ["--import", "tsx", "src/operations/check-readiness.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: connectionString,
        PORT: applicationPort,
      },
      timeout: 7000,
    },
  );
}

describe("production readiness", () => {
  it("accepts the running authenticated application and migrated database", async () => {
    await expect(probe(databaseUrl)).resolves.toMatchObject({ stderr: "" });
  });

  it("rejects an available PostgreSQL database without application tables", async () => {
    const emptySchemaUrl = new URL(databaseUrl);
    emptySchemaUrl.searchParams.set(
      "options",
      "-c search_path=readiness_empty",
    );
    await expect(probe(emptySchemaUrl.toString())).rejects.toMatchObject({
      code: 1,
      stderr: "Telegram application or database is not ready\n",
    });
  });

  it("rejects an unavailable database without exposing connection details", async () => {
    const unreachableUrl = new URL(databaseUrl);
    unreachableUrl.port = "1";
    await expect(probe(unreachableUrl.toString())).rejects.toMatchObject({
      code: 1,
      stderr: "Telegram application or database is not ready\n",
    });
  });

  it("rejects an unavailable application even when the database is ready", async () => {
    await expect(probe(databaseUrl, "1")).rejects.toMatchObject({ code: 1 });
  });
});
