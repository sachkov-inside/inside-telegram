import type { ColumnType, Generated, Kysely } from "kysely";

export type Contactability = "blocked" | "reachable";
export type UpdateState = "failed" | "pending" | "processed" | "processing";
export type WelcomeDeliveryState =
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

export interface WelcomeDeliveriesTable {
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
  state: WelcomeDeliveryState;
  telegram_user_id: BigIntColumn;
  trigger_update_id: BigIntColumn;
  updated_at: Timestamp;
}

export interface WelcomeDeliveryAttemptsTable {
  attempt_number: number;
  attempted_at: Timestamp;
  diagnostic_code: string | null;
  id: Generated<string>;
  outcome: DeliveryAttemptOutcome;
  provider_error_code: number | null;
  provider_message_id: BigIntColumn | null;
  welcome_delivery_id: BigIntColumn;
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
  link_transaction_ref: string;
  linked_at: Timestamp;
  telegram_identity_ref: string;
  telegram_user_id: BigIntColumn;
}

export interface IdentityLinkEventsTable {
  event_type: IdentityLinkEventType;
  id: Generated<string>;
  link_transaction_ref: string;
  occurred_at: Timestamp;
}

export interface DatabaseSchema {
  bot_contact_events: BotContactEventsTable;
  bot_contacts: BotContactsTable;
  identity_link_events: IdentityLinkEventsTable;
  link_transactions: LinkTransactionsTable;
  platform_links: PlatformLinksTable;
  telegram_updates: TelegramUpdatesTable;
  welcome_deliveries: WelcomeDeliveriesTable;
  welcome_delivery_attempts: WelcomeDeliveryAttemptsTable;
}

export type Database = Kysely<DatabaseSchema>;
export const DATABASE = Symbol("DATABASE");
