import { randomInt } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { sql } from "kysely";

import type { Database } from "../database/database.js";
import { TELEGRAM_WEBHOOK_ALLOWED_UPDATES } from "../modules/webhook/telegram-webhook.js";

const OPTIONAL_ADMIN_RIGHTS = [
  "can_change_info",
  "can_delete_messages",
  "can_edit_messages",
  "can_invite_users",
  "can_manage_chat",
  "can_manage_topics",
  "can_manage_video_chats",
  "can_pin_messages",
  "can_post_messages",
  "can_promote_members",
  "can_restrict_members",
] as const;

export interface TelegramProofEnvironment {
  readonly botId: string;
  readonly botIdentity: string;
  readonly botToken: string;
  readonly botUsername: string;
  readonly chatId?: string;
  readonly evidencePath: string;
  readonly webhookSecret?: string;
  readonly webhookUrl?: string;
}

export async function runCredentialedProofCommand(
  command: string,
  environment: TelegramProofEnvironment,
  database?: Database,
): Promise<Record<string, unknown> | string> {
  if (command === "verify-bot") {
    const bot = validateBotIdentity(
      await telegramResult(environment.botToken, "getMe", {}),
      environment.botId,
      environment.botUsername,
    );
    await recordObservation(environment.evidencePath, "botIdentity", bot);
    return { ok: true, stage: "bot-identity" };
  }
  if (command === "capture-chat-id") {
    const updates = await telegramResult(environment.botToken, "getUpdates", {
      allowed_updates: TELEGRAM_WEBHOOK_ALLOWED_UPDATES,
      timeout: 0,
    });
    return latestGroupChatId(updates);
  }
  if (command === "verify-chat") {
    const chatId = required(environment.chatId, "TELEGRAM_CANONICAL_CHAT_ID");
    const chat = await telegramResult(environment.botToken, "getChat", {
      chat_id: chatId,
    });
    const member = await telegramResult(environment.botToken, "getChatMember", {
      chat_id: chatId,
      user_id: environment.botId,
    });
    const observation = validateChatAdministration(chat, member);
    await recordObservation(
      environment.evidencePath,
      "chatAdministration",
      observation,
    );
    return { ok: true, stage: "chat-administration" };
  }
  if (command === "configure-webhook") {
    const webhookUrl = secureWebhookUrl(environment.webhookUrl);
    const webhookSecret = required(
      environment.webhookSecret,
      "TELEGRAM_WEBHOOK_SECRET",
    );
    await telegramResult(environment.botToken, "setWebhook", {
      allowed_updates: TELEGRAM_WEBHOOK_ALLOWED_UPDATES,
      drop_pending_updates: false,
      secret_token: webhookSecret,
      url: webhookUrl,
    });
    const observation = validateWebhookInfo(
      await telegramResult(environment.botToken, "getWebhookInfo", {}),
      webhookUrl,
    );
    await recordObservation(
      environment.evidencePath,
      "webhookConfigured",
      observation,
    );
    return { ok: true, stage: "webhook-configured" };
  }
  if (command === "verify-webhook-auth") {
    if (!database) {
      throw new Error("DATABASE_URL is required for webhook auth proof");
    }
    const webhookUrl = secureWebhookUrl(environment.webhookUrl);
    const webhookSecret = required(
      environment.webhookSecret,
      "TELEGRAM_WEBHOOK_SECRET",
    );
    const updateId = String(randomInt(1_500_000_000, 1_900_000_000));
    const statuses = {
      correct: await postSyntheticWebhook(webhookUrl, updateId, webhookSecret),
      duplicate: await postSyntheticWebhook(
        webhookUrl,
        updateId,
        webhookSecret,
      ),
      missing: await postSyntheticWebhook(webhookUrl, updateId),
      wrong: await postSyntheticWebhook(
        webhookUrl,
        updateId,
        "wrong_synthetic_secret",
      ),
    };
    const inbox = await database
      .selectFrom("telegram_updates")
      .select(({ fn }) => fn.countAll().as("count"))
      .where("bot_identity", "=", environment.botIdentity)
      .where("update_id", "=", updateId)
      .executeTakeFirstOrThrow();
    if (
      statuses.correct !== 202 ||
      statuses.duplicate !== 202 ||
      statuses.missing !== 401 ||
      statuses.wrong !== 401 ||
      Number(inbox.count) !== 1
    ) {
      throw new Error("Webhook authentication or durable deduplication failed");
    }
    const observation = {
      correctAcceptedAfterCommit: true,
      duplicateAcknowledged: true,
      durableInboxItems: 1,
      missingSecretRejected: true,
      wrongSecretRejected: true,
    };
    await recordObservation(
      environment.evidencePath,
      "webhookAuthentication",
      observation,
    );
    return { ok: true, stage: "webhook-auth-and-dedup" };
  }
  if (command === "observe-webhook-outage") {
    const observation = validateWebhookInfo(
      await telegramResult(environment.botToken, "getWebhookInfo", {}),
      secureWebhookUrl(environment.webhookUrl),
    );
    if (!observation.hasLastError) {
      throw new Error("Telegram has not observed a webhook delivery error yet");
    }
    await recordObservation(
      environment.evidencePath,
      "webhookOutage",
      observation,
    );
    return { ok: true, stage: "webhook-outage-observed" };
  }
  if (command === "verify-webhook-recovered") {
    const observation = validateWebhookInfo(
      await telegramResult(environment.botToken, "getWebhookInfo", {}),
      secureWebhookUrl(environment.webhookUrl),
    );
    await recordObservation(
      environment.evidencePath,
      "webhookRecovered",
      observation,
    );
    return { ok: true, stage: "webhook-recovered" };
  }
  if (command === "snapshot") {
    if (!database) {
      throw new Error("DATABASE_URL is required for the snapshot command");
    }
    const observation = await redactedDatabaseSnapshot(database);
    await recordObservation(
      environment.evidencePath,
      "applicationSnapshot",
      observation,
    );
    return { ok: true, stage: "application-snapshot" };
  }
  if (command === "remove-webhook") {
    await telegramResult(environment.botToken, "deleteWebhook", {
      drop_pending_updates: true,
    });
    const info = providerRecord(
      await telegramResult(environment.botToken, "getWebhookInfo", {}),
    );
    if (info.url !== "") {
      throw new Error("Telegram webhook is still configured");
    }
    await recordObservation(environment.evidencePath, "webhookDisposed", {
      pendingUpdatesDropped: true,
      urlRemoved: true,
    });
    return { ok: true, stage: "webhook-disposed" };
  }
  if (command === "verify-revoked") {
    const revoked = await telegramCredentialRejected(environment.botToken);
    if (!revoked) {
      throw new Error("Telegram credential is still accepted");
    }
    await recordObservation(environment.evidencePath, "tokenDisposed", {
      oldCredentialRejected: true,
    });
    return { ok: true, stage: "token-disposed" };
  }
  throw new Error("Unknown credentialed proof command");
}

export function validateBotIdentity(
  value: unknown,
  expectedId: string,
  expectedUsername: string,
): { idMatches: true; isBot: true; usernameMatches: true } {
  const bot = providerRecord(value);
  const username = normalizeUsername(expectedUsername);
  if (
    String(bot.id) !== expectedId ||
    bot.is_bot !== true ||
    typeof bot.username !== "string" ||
    normalizeUsername(bot.username) !== username
  ) {
    throw new Error("getMe did not match the configured dedicated bot");
  }
  return { idMatches: true, isBot: true, usernameMatches: true };
}

export function validateChatAdministration(
  chatValue: unknown,
  memberValue: unknown,
): {
  botStatus: "administrator" | "creator";
  chatType: "group" | "supergroup";
  enabledOptionalRights: string[];
} {
  const chat = providerRecord(chatValue);
  const member = providerRecord(memberValue);
  if (chat.type !== "group" && chat.type !== "supergroup") {
    throw new Error("Canonical proof chat must be a group or supergroup");
  }
  if (member.status !== "administrator" && member.status !== "creator") {
    throw new Error("Dedicated bot must be an administrator in the proof chat");
  }
  return {
    botStatus: member.status,
    chatType: chat.type,
    enabledOptionalRights: OPTIONAL_ADMIN_RIGHTS.filter(
      (right) => member[right] === true,
    ),
  };
}

export function validateWebhookInfo(
  value: unknown,
  expectedUrl: string,
): {
  allowedUpdatesMatch: true;
  hasCustomCertificate: boolean;
  hasLastError: boolean;
  pendingUpdates: number;
  urlMatches: true;
} {
  const info = providerRecord(value);
  const allowedUpdates = Array.isArray(info.allowed_updates)
    ? info.allowed_updates.filter(
        (update): update is string => typeof update === "string",
      )
    : [];
  if (
    info.url !== expectedUrl ||
    [...allowedUpdates].sort().join(",") !==
      [...TELEGRAM_WEBHOOK_ALLOWED_UPDATES].sort().join(",")
  ) {
    throw new Error(
      "Webhook URL or allowed_updates does not match proof scope",
    );
  }
  return {
    allowedUpdatesMatch: true,
    hasCustomCertificate: info.has_custom_certificate === true,
    hasLastError:
      typeof info.last_error_date === "number" ||
      typeof info.last_error_message === "string",
    pendingUpdates:
      typeof info.pending_update_count === "number"
        ? info.pending_update_count
        : 0,
    urlMatches: true,
  };
}

async function redactedDatabaseSnapshot(
  database: Database,
): Promise<Record<string, unknown>> {
  const [updates, contacts, deliveries, membershipEvents, recoveries] =
    await Promise.all([
      groupedCounts(database, "telegram_updates", "state"),
      groupedCounts(database, "bot_contacts", "contactability"),
      groupedCounts(database, "start_response_delivery_attempts", "outcome"),
      groupedCounts(database, "membership_event_audit", "disposition"),
      sql<{ count: string }>`
        select count(*)::text as count from identity_link_recoveries
      `.execute(database),
    ]);
  return {
    botContactsByState: contacts,
    deliveryAttemptsByOutcome: deliveries,
    membershipEventsByDisposition: membershipEvents,
    ownerRecoveries: Number(recoveries.rows[0]?.count ?? 0),
    telegramUpdatesByState: updates,
  };
}

async function groupedCounts(
  database: Database,
  table: string,
  column: string,
): Promise<Record<string, number>> {
  const result = await sql<{ count: string; key: string }>`
    select ${sql.ref(column)}::text as key, count(*)::text as count
    from ${sql.table(table)}
    group by ${sql.ref(column)}
    order by ${sql.ref(column)}
  `.execute(database);
  return Object.fromEntries(
    result.rows.map((row) => [row.key, Number(row.count)]),
  );
}

async function telegramResult(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  const payload = providerRecord(await response.json());
  if (!response.ok || payload.ok !== true) {
    throw new Error("Telegram Bot API rejected the proof request");
  }
  return payload.result;
}

async function telegramCredentialRejected(token: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: "POST",
    });
    if (!response.ok) {
      return true;
    }
    const payload = providerRecord(await response.json());
    return payload.ok !== true;
  } catch {
    return false;
  }
}

async function postSyntheticWebhook(
  webhookUrl: string,
  updateId: string,
  secret?: string,
): Promise<number> {
  const response = await fetch(webhookUrl, {
    body: JSON.stringify({ update_id: Number(updateId) }),
    headers: {
      ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
      "content-type": "application/json",
    },
    method: "POST",
  });
  return response.status;
}

function latestGroupChatId(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new Error("getUpdates did not return an update list");
  }
  for (const update of [...value].reverse()) {
    const record = providerRecord(update);
    for (const field of ["message", "my_chat_member", "chat_member"] as const) {
      if (!(field in record)) {
        continue;
      }
      const envelope = providerRecord(record[field]);
      const chat = providerRecord(envelope.chat);
      if (
        (chat.type === "group" || chat.type === "supergroup") &&
        (typeof chat.id === "number" || typeof chat.id === "string")
      ) {
        return String(chat.id);
      }
    }
  }
  throw new Error("No group or supergroup update is available");
}

async function recordObservation(
  path: string,
  name: string,
  observation: unknown,
): Promise<void> {
  let current: Record<string, unknown>;
  try {
    current = providerRecord(JSON.parse(await readFile(path, "utf8")));
  } catch {
    current = {};
  }
  const observations =
    typeof current.observations === "object" &&
    current.observations !== null &&
    !Array.isArray(current.observations)
      ? providerRecord(current.observations)
      : {};
  const next = {
    proofVersion: "inside.telegram-credentialed-proof.v1",
    observations: { ...observations, [name]: observation },
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function providerRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Telegram provider response has an unexpected shape");
  }
  return Object.fromEntries(Object.entries(value));
}

function normalizeUsername(value: string): string {
  return value.replace(/^@/u, "").toLowerCase();
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function secureWebhookUrl(value: string | undefined): string {
  const requiredValue = required(value, "TELEGRAM_PROOF_WEBHOOK_URL");
  const url = new URL(requiredValue);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("TELEGRAM_PROOF_WEBHOOK_URL must be a direct HTTPS URL");
  }
  return requiredValue;
}
