import type { ColumnType, Generated, Kysely } from "kysely";

import type { MembershipEvidenceSource } from "../modules/membership-evidence/membership-evidence.js";

export type Contactability = "blocked" | "reachable";
export type UpdateState = "failed" | "pending" | "processed" | "processing";
export type StartResponseDeliveryState =
  | "delivered"
  | "pending"
  | "rejected"
  | "retry_scheduled"
  | "sending"
  | "unknown_exhausted";
export type DeliveryAttemptOutcome =
  "api_rejected" | "api_retryable" | "delivered" | "transport_unknown";
export type LinkTransactionState =
  "conflict" | "linked" | "received" | "registered";
export type IdentityLinkEventType =
  | "confirmation_expired"
  | "confirmation_idempotent"
  | "confirmed"
  | "receipt_accepted"
  | "receipt_conflict"
  | "receipt_expired"
  | "receipt_replayed"
  | "recovery_required"
  | "registered";
export type MembershipCheckState = "completed" | "pending" | "processing";
export type MembershipEvidenceDeliveryState =
  "delivered" | "delivering" | "pending" | "rejected" | "retry_scheduled";
export type MembershipProviderState = "degraded" | "ready" | "unavailable";
export type MembershipReconciliationState = "pending" | "processing";
export type NormalizedMembershipState = "member" | "non_member" | "unavailable";
export type MembershipEventDisposition =
  "evidence" | "ignored_older" | "provider_state" | "unlinked_subject";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type BigIntColumn = ColumnType<
  string,
  bigint | number | string,
  bigint | number | string
>;

export interface TelegramUpdatesTable {
  available_at: Timestamp;
  bot_identity: string;
  failure_code: string | null;
  locked_at: Timestamp | null;
  payload: unknown | null;
  process_attempt_count: number;
  processed_at: Timestamp | null;
  received_at: Timestamp;
  state: UpdateState;
  update_id: BigIntColumn;
}

export interface BotContactsTable {
  bot_identity: string;
  contactability: Contactability;
  first_started_at: Timestamp;
  last_started_at: Timestamp;
  private_chat_id: BigIntColumn;
  telegram_user_id: BigIntColumn;
  updated_at: Timestamp;
}

export interface BotContactEventsTable {
  bot_identity: string;
  contactability: Contactability;
  event_type: "contactability_observed" | "start_observed";
  id: Generated<string>;
  observed_at: Timestamp;
  telegram_user_id: BigIntColumn;
  update_id: BigIntColumn;
}

export interface StartResponseDeliveriesTable {
  edit_message_id: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  sign_in_request_ref: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  attempt_count: number;
  available_at: Timestamp;
  bot_identity: string;
  created_at: Timestamp;
  delivered_at: Timestamp | null;
  diagnostic_code: string | null;
  id: Generated<string>;
  locked_at: Timestamp | null;
  message_text: string;
  private_chat_id: BigIntColumn;
  source_key: string;
  state: StartResponseDeliveryState;
  telegram_user_id: BigIntColumn;
  trigger_update_id: BigIntColumn | null;
  updated_at: Timestamp;
}

export interface StartResponseDeliveryAttemptsTable {
  attempt_number: number;
  attempted_at: Timestamp;
  diagnostic_code: string | null;
  id: Generated<string>;
  outcome: DeliveryAttemptOutcome;
  provider_error_code: number | null;
  provider_message_id: BigIntColumn | null;
  start_response_delivery_id: BigIntColumn;
}

export interface LinkTransactionsTable {
  account_ref: string;
  bot_identity: string | null;
  candidate_telegram_user_id: BigIntColumn | null;
  confirmed_at: Timestamp | null;
  expires_at: Timestamp;
  link_transaction_ref: string;
  received_at: Timestamp | null;
  registered_at: Timestamp;
  return_correlation: string;
  state: LinkTransactionState;
  token_digest: string;
}

export interface PlatformLinksTable {
  account_ref: string;
  bot_identity: string;
  evidence_version: BigIntColumn;
  last_membership_observation_at: Timestamp | null;
  last_membership_observation_update_id: BigIntColumn | null;
  link_transaction_ref: string;
  linked_at: Timestamp;
  telegram_identity_ref: string;
  telegram_user_id: BigIntColumn;
}

export interface MembershipChecksTable {
  attempt_count: number;
  available_at: Timestamp;
  completed_at: Timestamp | null;
  created_at: Timestamp;
  diagnostic_code: string | null;
  id: Generated<string>;
  locked_at: Timestamp | null;
  source_ref: string;
  state: MembershipCheckState;
  telegram_identity_ref: string;
}

export interface MembershipCheckResultsTable {
  diagnostic_code: string | null;
  evidence_ref: string | null;
  evidence_version: BigIntColumn | null;
  id: Generated<string>;
  normalized_state: NormalizedMembershipState;
  observation_update_id: BigIntColumn | null;
  result_ref: string;
  observed_at: Timestamp;
  raw_is_member: boolean | null;
  raw_status: string | null;
  telegram_identity_ref: string;
}

export interface MembershipEvidenceOutboxTable {
  attempt_count: number;
  available_at: Timestamp;
  delivered_at: Timestamp | null;
  diagnostic_code: string | null;
  envelope: unknown;
  id: string;
  locked_at: Timestamp | null;
  result_ref: string;
  source: MembershipEvidenceSource;
  state: MembershipEvidenceDeliveryState;
  updated_at: Timestamp;
}

export interface MembershipProviderStateTable {
  bot_identity: string;
  canonical_chat_id: BigIntColumn;
  diagnostic_code: string | null;
  last_provider_observation_at: Timestamp | null;
  last_provider_observation_update_id: BigIntColumn | null;
  state: MembershipProviderState;
  updated_at: Timestamp;
}

export interface MembershipProviderObservationsTable {
  bot_identity: string;
  diagnostic_code: string | null;
  id: Generated<string>;
  observed_at: Timestamp;
  source_kind: "direct" | "event";
  source_ref: string;
  source_update_id: BigIntColumn | null;
  state: MembershipProviderState;
}

export interface MembershipReconciliationsTable {
  attempt_count: number;
  diagnostic_code: string | null;
  due_at: Timestamp;
  last_completed_at: Timestamp | null;
  lease_token: string | null;
  locked_at: Timestamp | null;
  state: MembershipReconciliationState;
  telegram_identity_ref: string;
  updated_at: Timestamp;
}

export interface MembershipEventAuditTable {
  actor_is_subject: boolean | null;
  bot_identity: string;
  canonical_chat_id: BigIntColumn;
  diagnostic_code: string | null;
  disposition: MembershipEventDisposition;
  event_at: Timestamp;
  event_kind: "provider" | "subject";
  normalized_state: NormalizedMembershipState | null;
  result_ref: string | null;
  subject_linked: boolean | null;
  update_id: BigIntColumn;
}

export interface IdentityLinkEventsTable {
  event_type: IdentityLinkEventType;
  id: Generated<string>;
  link_transaction_ref: string;
  occurred_at: Timestamp;
}

export interface IdentityLinkRecoveriesTable {
  bot_identity: string;
  operator_ref: string;
  reason_ref: string;
  recovery_ref: string;
  source_account_ref: string;
  source_link_transaction_ref: string;
  source_linked_at: Timestamp;
  target_account_ref: string;
  target_link_transaction_ref: string;
  target_linked_at: Timestamp;
  telegram_identity_ref: string;
  telegram_user_id: BigIntColumn;
}

export interface SignInRequestsTable {
  confirmation_message_id: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  request_ref: string;
  bot_identity: string;
  start_token_digest: string;
  browser_secret_digest: string;
  confirmation_code: string;
  state: "pending" | "awaiting_approval" | "approved" | "denied" | "consumed";
  telegram_user_id: BigIntColumn | null;
  private_chat_id: BigIntColumn | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  approved_at: Timestamp | null;
  consumed_at: Timestamp | null;
}

export interface SignInSubjectsTable {
  reserved_for_sign_in: Generated<boolean>;
  subject_ref: string;
  bot_identity: string;
  telegram_user_id: BigIntColumn;
}

export interface DatabaseSchema {
  sign_in_requests: SignInRequestsTable;
  sign_in_subjects: SignInSubjectsTable;
  communication_funnels: {
    funnel_id: string;
    bot_identity: string;
    owner_account_ref: string;
    revision: number;
    published_revision: number | null;
    lifecycle: "draft" | "published" | "paused" | "archived";
    draft: unknown;
    published: unknown | null;
    is_default: boolean;
  };
  communication_publications: {
    funnel_id: string;
    revision: number;
    snapshot: unknown;
    published_at: Timestamp;
  };
  communication_sources: {
    bot_identity: string;
    source_id: string;
    code: string;
    funnel_id: string;
  };
  communication_step_ids: {
    funnel_id: string;
    step_id: string;
    first_published_at: Timestamp;
    part_ids: unknown;
  };
  communication_intro: {
    bot_identity: string;
    owner_account_ref: string;
    snapshot: unknown;
  };
  communication_contacts: {
    contact_id: string;
    bot_identity: string;
    telegram_user_id: BigIntColumn;
    marketing_enabled: boolean;
  };
  communication_enrollments: {
    enrollment_id: string;
    contact_id: string;
    funnel_id: string;
    enrolled_at: Timestamp;
    initial_entry_key: string;
  };
  communication_entries: {
    bot_identity: string;
    update_id: BigIntColumn;
    contact_id: string;
    funnel_id: string | null;
    source_id: string | null;
    source_code: string | null;
    entered_at: Timestamp;
    outcome: string;
  };
  communication_deliveries: {
    delivery_id: string;
    dedup_key: string;
    bot_identity: string;
    contact_id: string;
    funnel_id: string | null;
    step_id: string | null;
    kind: "intro" | "entry" | "step" | "fallback";
    published_revision: number;
    snapshot: unknown;
    parts: unknown;
    revision: number;
    due_at: Timestamp;
    created_at: Timestamp;
    completed_at: Timestamp | null;
    cancel_requested: boolean;
    attempt_id: string | null;
    locked_at: Timestamp | null;
  };
  telegram_transport_slots: {
    bot_identity: string;
    lane: string;
    available_at: Timestamp;
  };

  communication_author_modes: {
    bot_identity: string;
    telegram_user_id: BigIntColumn;
    account_ref: string;
    enabled: boolean;
    last_update_id: BigIntColumn;
  };
  communication_templates: {
    template_id: string;
    bot_identity: string;
    owner_account_ref: string;
    revision: number;
    content: unknown;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  communication_operations: {
    bot_identity: string;
    operation_id: string;
    actor_account_ref: string;
    request: unknown;
    result: unknown;
    created_at: Timestamp;
  };
  communication_intake_receipts: {
    bot_identity: string;
    update_id: BigIntColumn;
    outcome: string;
    template_id: string | null;
  };
  bot_contact_events: BotContactEventsTable;
  bot_contacts: BotContactsTable;
  identity_link_events: IdentityLinkEventsTable;
  identity_link_recoveries: IdentityLinkRecoveriesTable;
  link_transactions: LinkTransactionsTable;
  membership_checks: MembershipChecksTable;
  membership_evidence_outbox: MembershipEvidenceOutboxTable;
  membership_event_audit: MembershipEventAuditTable;
  membership_check_results: MembershipCheckResultsTable;
  membership_provider_observations: MembershipProviderObservationsTable;
  membership_provider_state: MembershipProviderStateTable;
  membership_reconciliations: MembershipReconciliationsTable;
  platform_links: PlatformLinksTable;
  telegram_updates: TelegramUpdatesTable;
  start_response_deliveries: StartResponseDeliveriesTable;
  start_response_delivery_attempts: StartResponseDeliveryAttemptsTable;
}

export type Database = Kysely<DatabaseSchema>;
export const DATABASE = Symbol("DATABASE");
