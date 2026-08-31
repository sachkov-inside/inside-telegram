import { createHash, randomInt } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { sql } from "kysely";

import type { Database } from "../database/database.js";
import { normalizeChatMember } from "../modules/membership-evidence/membership-normalization.js";
import { TELEGRAM_WEBHOOK_ALLOWED_UPDATES } from "../modules/webhook/telegram-webhook.js";

const ASSIGNABLE_ADMIN_RIGHTS = [
  "is_anonymous",
  "can_change_info",
  "can_delete_messages",
  "can_delete_stories",
  "can_edit_messages",
  "can_edit_stories",
  "can_invite_users",
  "can_manage_direct_messages",
  "can_manage_tags",
  "can_manage_topics",
  "can_manage_video_chats",
  "can_pin_messages",
  "can_post_messages",
  "can_post_stories",
  "can_promote_members",
  "can_restrict_members",
  "can_send_welcome_messages",
] as const;

const SNAPSHOT_LABEL_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

export const CREDENTIAL_PROOF_CAPTURE_PATH = ".credentialed-proof/chat-id";
export const CREDENTIAL_PROOF_EVIDENCE_PATH =
  ".credentialed-proof/evidence.json";

export interface TelegramProofEnvironment {
  readonly botId: string;
  readonly botIdentity: string;
  readonly botToken: string;
  readonly botUsername: string;
  readonly capturePath: string;
  readonly chatId?: string;
  readonly evidencePath: string;
  readonly minimumAdminConfirmed?: string;
  readonly retryMarker?: string;
  readonly snapshotLabel?: string;
  readonly temporaryResourcesDisposed?: string;
  readonly webhookSecret?: string;
  readonly webhookUrl?: string;
}

export async function runCredentialedProofCommand(
  command: string,
  environment: TelegramProofEnvironment,
  database?: Database,
): Promise<Record<string, unknown> | string> {
  if (command === "begin-proof-run") {
    await archiveExistingEvidence(environment.evidencePath);
    await writeEvidence(environment.evidencePath, {
      proofVersion: "inside.telegram-credentialed-proof.v1",
      observations: { proofRun: { started: true } },
    });
    return { ok: true, stage: "proof-run-started" };
  }
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
    await writePrivateValue(
      environment.capturePath,
      latestGroupChatId(updates),
    );
    await recordObservation(environment.evidencePath, "chatUpdateCaptured", {
      groupUpdateCaptured: true,
    });
    return { ok: true, stage: "chat-update-captured" };
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
    const observation = validateChatAdministration(
      chat,
      member,
      environment.minimumAdminConfirmed === "true",
    );
    await appendObservation(
      environment.evidencePath,
      "chatAdministrationTransitions",
      observation,
    );
    return { ok: true, stage: "chat-administration" };
  }
  if (command === "observe-chat-demoted") {
    const chatId = required(environment.chatId, "TELEGRAM_CANONICAL_CHAT_ID");
    const member = await telegramResult(environment.botToken, "getChatMember", {
      chat_id: chatId,
      user_id: environment.botId,
    });
    const observation = validateChatDemotion(member);
    await appendObservation(
      environment.evidencePath,
      "chatAdministrationTransitions",
      observation,
    );
    return { ok: true, stage: "chat-demotion" };
  }
  if (command === "configure-webhook") {
    const webhookUrl = validateWebhookUrl(environment.webhookUrl);
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
  if (command === "suppress-membership-events") {
    const webhookUrl = validateWebhookUrl(environment.webhookUrl);
    const webhookSecret = required(
      environment.webhookSecret,
      "TELEGRAM_WEBHOOK_SECRET",
    );
    const allowedUpdates = TELEGRAM_WEBHOOK_ALLOWED_UPDATES.filter(
      (update) => update !== "chat_member",
    );
    await telegramResult(environment.botToken, "setWebhook", {
      allowed_updates: allowedUpdates,
      drop_pending_updates: false,
      secret_token: webhookSecret,
      url: webhookUrl,
    });
    const info = providerRecord(
      await telegramResult(environment.botToken, "getWebhookInfo", {}),
    );
    const observed = Array.isArray(info.allowed_updates)
      ? info.allowed_updates.filter(
          (update): update is string => typeof update === "string",
        )
      : [];
    if (
      [...observed].sort().join(",") !== [...allowedUpdates].sort().join(",")
    ) {
      throw new Error("Membership event suppression was not configured");
    }
    await recordObservation(
      environment.evidencePath,
      "membershipEventSuppression",
      { chatMemberTemporarilyExcluded: true },
    );
    return { ok: true, stage: "membership-events-suppressed" };
  }
  if (command === "verify-webhook-auth") {
    if (!database) {
      throw new Error("DATABASE_URL is required for webhook auth proof");
    }
    const webhookUrl = validateWebhookUrl(environment.webhookUrl);
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
    if (!database) {
      throw new Error("DATABASE_URL is required for webhook retry proof");
    }
    const retryMarker = required(
      environment.retryMarker,
      "TELEGRAM_PROOF_RETRY_MARKER",
    );
    const observation = validateWebhookInfo(
      await telegramResult(environment.botToken, "getWebhookInfo", {}),
      validateWebhookUrl(environment.webhookUrl),
    );
    const markerItems = await retryMarkerInboxItems(database, retryMarker);
    if (
      !observation.hasLastError ||
      !observation.lastErrorIsHttp503 ||
      observation.pendingUpdates < 1
    ) {
      throw new Error("Telegram has not observed a webhook delivery error yet");
    }
    if (markerItems !== 0) {
      throw new Error(
        "Failed webhook marker reached the inbox before recovery",
      );
    }
    await recordObservation(environment.evidencePath, "webhookOutage", {
      failedMarkerAbsentFromInbox: true,
      providerDeliveryErrorObserved: true,
      providerHttp503Observed: true,
      providerHasPendingUpdates: true,
    });
    return { ok: true, stage: "webhook-outage-observed" };
  }
  if (command === "verify-webhook-recovered") {
    if (!database) {
      throw new Error("DATABASE_URL is required for webhook retry proof");
    }
    const retryMarker = required(
      environment.retryMarker,
      "TELEGRAM_PROOF_RETRY_MARKER",
    );
    const observation = validateWebhookInfo(
      await telegramResult(environment.botToken, "getWebhookInfo", {}),
      validateWebhookUrl(environment.webhookUrl),
    );
    const markerItems = await retryMarkerInboxItems(database, retryMarker);
    if (markerItems !== 1 || observation.pendingUpdates !== 0) {
      throw new Error(
        "Failed webhook marker was not durably retried exactly once",
      );
    }
    await recordObservation(environment.evidencePath, "webhookRecovered", {
      durableInboxItemsForFailedMarker: 1,
      failedUpdateRetried: true,
      providerPendingUpdatesDrained: true,
    });
    return { ok: true, stage: "webhook-recovered" };
  }
  if (command === "snapshot") {
    if (!database) {
      throw new Error("DATABASE_URL is required for the snapshot command");
    }
    const snapshotLabel = required(
      environment.snapshotLabel,
      "credentialed proof snapshot label",
    );
    if (!SNAPSHOT_LABEL_PATTERN.test(snapshotLabel)) {
      throw new Error("Credentialed proof snapshot label is malformed");
    }
    const snapshot = await redactedDatabaseSnapshot(database);
    if (snapshotLabel === "reconciliation-repaired") {
      const suppressedSnapshot = await findApplicationSnapshot(
        environment.evidencePath,
        "removal-event-suppressed",
      );
      validateReconciliationRepair(
        snapshot.membershipTransitions,
        suppressedSnapshot.membershipTransitions,
      );
    }
    const observation = { label: snapshotLabel, ...snapshot };
    await appendObservation(
      environment.evidencePath,
      "applicationSnapshots",
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
  if (command === "record-resource-disposal") {
    if (environment.temporaryResourcesDisposed !== "true") {
      throw new Error("Temporary resource disposal is not owner-confirmed");
    }
    await recordObservation(environment.evidencePath, "resourceDisposal", {
      temporaryChatDisposed: true,
      temporaryEndpointDisposed: true,
      temporaryPlatformCredentialsDisposed: true,
    });
    return { ok: true, stage: "temporary-resources-disposed" };
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
    !username.endsWith("bot") ||
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
  minimumClientConfigurationConfirmed: boolean,
): {
  assignableRights: Record<string, boolean>;
  botStatus: "administrator";
  chatType: "group" | "supergroup";
  minimumClientConfigurationConfirmed: true;
  impliedManageChat: true;
} {
  const chat = providerRecord(chatValue);
  const member = providerRecord(memberValue);
  if (chat.type !== "group" && chat.type !== "supergroup") {
    throw new Error("Canonical proof chat must be a group or supergroup");
  }
  if (member.status !== "administrator") {
    throw new Error("Dedicated bot must be an administrator in the proof chat");
  }
  const assignableRights = Object.fromEntries(
    ASSIGNABLE_ADMIN_RIGHTS.map((right) => [right, member[right] === true]),
  );
  if (member.can_manage_chat !== true || !minimumClientConfigurationConfirmed) {
    throw new Error(
      "Minimum client-assignable administrator configuration is not confirmed",
    );
  }
  if (Object.values(assignableRights).some(Boolean)) {
    throw new Error(
      "Dedicated bot has elevated client-assignable administrator rights",
    );
  }
  return {
    assignableRights,
    botStatus: member.status,
    chatType: chat.type,
    impliedManageChat: true,
    minimumClientConfigurationConfirmed: true,
  };
}

export function validateChatDemotion(memberValue: unknown): {
  botIsAdministrator: false;
  botStatus: "kicked" | "left" | "member" | "restricted";
} {
  const member = providerRecord(memberValue);
  if (!isNonAdministratorStatus(member.status)) {
    throw new Error("Dedicated bot has not been demoted");
  }
  return { botIsAdministrator: false, botStatus: member.status };
}

function isNonAdministratorStatus(
  value: unknown,
): value is "kicked" | "left" | "member" | "restricted" {
  return (
    value === "kicked" ||
    value === "left" ||
    value === "member" ||
    value === "restricted"
  );
}

export function validateWebhookInfo(
  value: unknown,
  expectedUrl: string,
): {
  allowedUpdatesMatch: true;
  hasCustomCertificate: boolean;
  hasLastError: boolean;
  lastErrorIsHttp503: boolean;
  pendingUpdates: number;
  urlMatches: true;
} {
  const info = providerRecord(value);
  const allowedUpdates = Array.isArray(info.allowed_updates)
    ? info.allowed_updates.filter(
        (update): update is string => typeof update === "string",
      )
    : [];
  const lastErrorMessage =
    typeof info.last_error_message === "string" ? info.last_error_message : "";
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
    lastErrorIsHttp503: /(?:^|\D)503(?:\D|$)/u.test(lastErrorMessage),
    pendingUpdates:
      typeof info.pending_update_count === "number"
        ? info.pending_update_count
        : 0,
    urlMatches: true,
  };
}

export async function redactedDatabaseSnapshot(
  database: Database,
): Promise<Record<string, unknown>> {
  const [
    updates,
    contacts,
    deliveryStates,
    deliveries,
    linkTransactions,
    linkEvents,
    membershipChecks,
    evidenceDeliveries,
    membershipResults,
    membershipRawStatuses,
    membershipEvents,
    membershipEventStates,
    providerStates,
    providerObservations,
    reconciliations,
    completedReconciliations,
    membershipTransitions,
    evidenceVersions,
    recoveries,
  ] = await Promise.all([
    groupedCounts(database, "telegram_updates", "state"),
    groupedCounts(database, "bot_contacts", "contactability"),
    groupedCounts(database, "start_response_deliveries", "state"),
    groupedCounts(database, "start_response_delivery_attempts", "outcome"),
    groupedCounts(database, "link_transactions", "state"),
    groupedCounts(database, "identity_link_events", "event_type"),
    groupedCounts(database, "membership_checks", "state"),
    groupedCounts(database, "membership_evidence_outbox", "state"),
    groupedCounts(database, "membership_check_results", "normalized_state"),
    groupedNonNullCounts(database, "membership_check_results", "raw_status"),
    groupedCounts(database, "membership_event_audit", "disposition"),
    groupedNonNullCounts(
      database,
      "membership_event_audit",
      "normalized_state",
    ),
    groupedCounts(database, "membership_provider_state", "state"),
    groupedCounts(database, "membership_provider_observations", "state"),
    groupedCounts(database, "membership_reconciliations", "state"),
    sql<{ count: string }>`
        select count(*)::text as count
        from membership_reconciliations
        where last_completed_at is not null
      `.execute(database),
    redactedMembershipTransitions(database),
    sql<{ count: string; maximum: string | null; minimum: string | null }>`
        select
          count(evidence_version)::text as count,
          min(evidence_version)::text as minimum,
          max(evidence_version)::text as maximum
        from membership_check_results
        where evidence_version is not null
      `.execute(database),
    sql<{ count: string }>`
        select count(*)::text as count from identity_link_recoveries
      `.execute(database),
  ]);
  const versionRange = evidenceVersions.rows[0];
  return {
    botContactsByState: contacts,
    deliveryAttemptsByOutcome: deliveries,
    deliveriesByState: deliveryStates,
    evidenceDeliveriesByState: evidenceDeliveries,
    evidenceVersions: {
      count: Number(versionRange?.count ?? 0),
      maximum: versionRange?.maximum ?? null,
      minimum: versionRange?.minimum ?? null,
    },
    identityLinkEventsByType: linkEvents,
    linkTransactionsByState: linkTransactions,
    membershipChecksByState: membershipChecks,
    membershipEventsByDisposition: membershipEvents,
    membershipEventsByNormalizedState: membershipEventStates,
    membershipResultsByNormalizedState: membershipResults,
    membershipResultsByRawStatus: membershipRawStatuses,
    membershipTransitions,
    ownerRecoveries: Number(recoveries.rows[0]?.count ?? 0),
    providerObservationsByState: providerObservations,
    providerRowsByState: providerStates,
    reconciliationsCompleted: Number(
      completedReconciliations.rows[0]?.count ?? 0,
    ),
    reconciliationsByState: reconciliations,
    telegramUpdatesByState: updates,
  };
}

export interface RedactedMembershipTransition {
  readonly decision: string | null;
  readonly eventDisposition: string | null;
  readonly eventKind: string | null;
  readonly freshnessBounded: boolean;
  readonly freshnessObserved: boolean;
  readonly identityFingerprint: string;
  readonly isCurrentRevision: boolean;
  readonly mappingObserved: boolean;
  readonly normalizedState: string;
  readonly rawIsMember: boolean | null;
  readonly rawStatus: string | null;
  readonly revision: string | null;
  readonly sequence: number;
  readonly source: string | null;
  readonly validitySeconds: number | null;
}

async function redactedMembershipTransitions(
  database: Database,
): Promise<RedactedMembershipTransition[]> {
  const result = await sql<{
    decision: string | null;
    event_disposition: string | null;
    event_kind: string | null;
    evidence_version: string | null;
    is_current_revision: boolean;
    normalized_state: string;
    raw_is_member: boolean | null;
    raw_status: string | null;
    sequence: string;
    source: string | null;
    telegram_identity_ref: string;
    validity_seconds: string | null;
  }>`
    select
      row_number() over (
        order by results.observed_at, results.id
      )::text as sequence,
      results.telegram_identity_ref,
      outbox.source,
      results.raw_status,
      results.raw_is_member,
      results.normalized_state,
      results.evidence_version::text,
      audit.event_kind,
      audit.disposition as event_disposition,
      outbox.envelope ->> 'decision' as decision,
      case
        when outbox.envelope ->> 'decision' in ('member', 'not_member')
        then round(extract(epoch from (
          (outbox.envelope ->> 'validUntil')::timestamptz
          - (outbox.envelope ->> 'checkedAt')::timestamptz
        )))::text
        else null
      end as validity_seconds,
      results.evidence_version is not null
        and results.evidence_version = links.evidence_version
        as is_current_revision
    from membership_check_results as results
    left join membership_evidence_outbox as outbox
      on outbox.result_ref = results.result_ref
    left join membership_event_audit as audit
      on audit.result_ref = results.result_ref
    inner join platform_links as links
      on links.telegram_identity_ref = results.telegram_identity_ref
    order by results.observed_at, results.id
  `.execute(database);

  return result.rows.map((row) => {
    const normalizedState = validateRecordedMembershipNormalization(row);
    const validitySeconds =
      row.validity_seconds === null ? null : Number(row.validity_seconds);
    const freshnessObserved =
      row.decision === "member" ||
      row.decision === "not_member" ||
      row.decision === "unavailable";
    const freshnessBounded =
      row.decision === "unavailable" ||
      (validitySeconds !== null &&
        validitySeconds > 0 &&
        validitySeconds <= 300);
    if (freshnessObserved && !freshnessBounded) {
      throw new Error("Credentialed proof found unbounded Membership evidence");
    }
    return {
      decision: row.decision,
      eventDisposition: row.event_disposition,
      eventKind: row.event_kind,
      freshnessBounded,
      freshnessObserved,
      identityFingerprint: fingerprint(row.telegram_identity_ref),
      isCurrentRevision: row.is_current_revision,
      mappingObserved: row.raw_status !== null,
      normalizedState,
      rawIsMember: row.raw_is_member,
      rawStatus: row.raw_status,
      revision: row.evidence_version,
      sequence: Number(row.sequence),
      source: row.source,
      validitySeconds,
    };
  });
}

export function validateRecordedMembershipNormalization(row: {
  normalized_state: string;
  raw_is_member: boolean | null;
  raw_status: string | null;
}): string {
  const expected =
    row.raw_status === null
      ? row.normalized_state
      : normalizeChatMember({
          ...(row.raw_is_member === null
            ? {}
            : { isMember: row.raw_is_member }),
          status: row.raw_status,
        });
  if (row.normalized_state !== expected) {
    throw new Error(
      "Credentialed proof found a Membership normalization mismatch",
    );
  }
  return row.normalized_state;
}

export function validateReconciliationRepair(
  value: unknown,
  priorValue: unknown,
): void {
  if (!Array.isArray(value) || !Array.isArray(priorValue)) {
    throw new Error("Membership transition evidence is unavailable");
  }
  const transitions = value as RedactedMembershipTransition[];
  const priorTransitions = priorValue as RedactedMembershipTransition[];
  const priorMembers = new Map<
    string,
    { readonly revision: bigint; readonly sequence: number }
  >();
  for (const transition of priorTransitions) {
    if (
      transition.normalizedState === "member" &&
      transition.decision === "member" &&
      transition.freshnessBounded &&
      transition.isCurrentRevision &&
      transition.revision
    ) {
      priorMembers.set(transition.identityFingerprint, {
        revision: BigInt(transition.revision),
        sequence: transition.sequence,
      });
    }
  }
  const repaired = transitions.some((transition) => {
    const priorMember = priorMembers.get(transition.identityFingerprint);
    return (
      transition.source === "reconciliation" &&
      transition.normalizedState === "non_member" &&
      transition.decision === "not_member" &&
      transition.freshnessBounded &&
      transition.isCurrentRevision &&
      transition.revision !== null &&
      priorMember !== undefined &&
      transition.sequence > priorMember.sequence &&
      BigInt(transition.revision) > priorMember.revision
    );
  });
  if (!repaired) {
    throw new Error(
      "Reconciliation did not supersede positive Membership evidence with a current bounded denial",
    );
  }
}

async function findApplicationSnapshot(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  const observations = await readObservations(path);
  const snapshots = observations.applicationSnapshots;
  if (!Array.isArray(snapshots)) {
    throw new Error("Credentialed proof application snapshots are unavailable");
  }
  for (const value of [...snapshots].reverse()) {
    const snapshot = providerRecord(value);
    if (snapshot.label === label) {
      return snapshot;
    }
  }
  throw new Error(`Credentialed proof snapshot ${label} is unavailable`);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function groupedNonNullCounts(
  database: Database,
  table: string,
  column: string,
): Promise<Record<string, number>> {
  const result = await sql<{ count: string; key: string }>`
    select ${sql.ref(column)}::text as key, count(*)::text as count
    from ${sql.table(table)}
    where ${sql.ref(column)} is not null
    group by ${sql.ref(column)}
    order by ${sql.ref(column)}
  `.execute(database);
  return Object.fromEntries(
    result.rows.map((row) => [row.key, Number(row.count)]),
  );
}

async function retryMarkerInboxItems(
  database: Database,
  retryMarker: string,
): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*)::text as count
    from telegram_updates
    where payload #>> '{message,text}' = ${retryMarker}
  `.execute(database);
  return Number(result.rows[0]?.count ?? 0);
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
  const observations = await readObservations(path);
  await writeEvidence(path, {
    proofVersion: "inside.telegram-credentialed-proof.v1",
    observations: { ...observations, [name]: observation },
  });
}

async function appendObservation(
  path: string,
  name: string,
  observation: unknown,
): Promise<void> {
  const observations = await readObservations(path);
  const existing = observations[name];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error(`Credentialed proof observation ${name} is not a sequence`);
  }
  await writeEvidence(path, {
    proofVersion: "inside.telegram-credentialed-proof.v1",
    observations: {
      ...observations,
      [name]: [...(existing ?? []), observation],
    },
  });
}

async function readObservations(
  path: string,
): Promise<Record<string, unknown>> {
  let current: Record<string, unknown>;
  try {
    current = providerRecord(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissingFile(error)) {
      return {};
    }
    throw error;
  }
  if (
    current.proofVersion !== "inside.telegram-credentialed-proof.v1" ||
    typeof current.observations !== "object" ||
    current.observations === null ||
    Array.isArray(current.observations)
  ) {
    throw new Error("Credentialed proof evidence has an unexpected shape");
  }
  return providerRecord(current.observations);
}

async function writeEvidence(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function archiveExistingEvidence(path: string): Promise<void> {
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }
    throw error;
  }
  await readObservations(path);
  const archiveDirectory = `${dirname(path)}/archive`;
  await mkdir(archiveDirectory, { mode: 0o700, recursive: true });
  await chmod(archiveDirectory, 0o700);
  const archivePath = `${archiveDirectory}/evidence-${String(Date.now())}-${String(process.pid)}.json`;
  await rename(path, archivePath);
  await chmod(archivePath, 0o600);
}

async function writePrivateValue(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${value}\n`, { mode: 0o600 });
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

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function validateWebhookUrl(value: string | undefined): string {
  const requiredValue = required(value, "TELEGRAM_PROOF_WEBHOOK_URL");
  const url = new URL(requiredValue);
  const webhookPort = url.port === "" ? "443" : url.port;
  if (
    url.protocol !== "https:" ||
    !new Set(["80", "88", "443", "8443"]).has(webhookPort) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "TELEGRAM_PROOF_WEBHOOK_URL must be a direct HTTPS URL on a Telegram-supported port",
    );
  }
  return requiredValue;
}

export function validateCredentialedProofDatabaseUrl(
  value: string | undefined,
): string {
  const requiredValue = required(value, "DATABASE_URL");
  const url = new URL(requiredValue);
  const database = decodeURIComponent(url.pathname.slice(1)).toLowerCase();
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname) ||
    url.search !== "" ||
    url.hash !== "" ||
    !/(?:issue9|proof)/u.test(database)
  ) {
    throw new Error(
      "DATABASE_URL must select an isolated loopback issue9/proof database without routing parameters",
    );
  }
  return requiredValue;
}
