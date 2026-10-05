import type { ColumnType } from "kysely";
import type {
  ActivationEvidence,
  ActivationResponse,
  ActivationResult,
} from "./activation-contract.js";
type Timestamp = ColumnType<Date, Date, Date>;
export interface ActivationTables {
  telegram_identity_reservations: {
    bot_identity: string;
    telegram_user_id: string;
    identity_ref: string;
  };
  activation_attempts: {
    attempt_id: string;
    bot_identity: string;
    telegram_user_id: string;
    private_chat_id: string;
    identity_ref: string;
    code: string;
    trigger_update_id: string;
    state:
      | "pending"
      | "needs_account"
      | "retry"
      | "pending_review"
      | "completed"
      | "rejected";
    evidence: ActivationEvidence | null;
    result: ActivationResult<ActivationResponse> | null;
    created_at: Timestamp;
    expires_at: Timestamp;
    due_at: Timestamp;
    lease_token: string | null;
    lease_until: Timestamp | null;
    attempts: number;
    diagnostic_code: string | null;
    /** When Platform first granted this ground; never cleared by a later retry. */
    confirmed_at: Timestamp | null;
  };
  invitation_redemptions: {
    redemption_id: string;
    bot_identity: string;
    telegram_user_id: string;
    private_chat_id: string;
    identity_ref: string;
    code: string;
    trigger_update_id: string;
    state: "pending" | "needs_account" | "retry" | "completed";
    created_at: Timestamp;
    expires_at: Timestamp;
    due_at: Timestamp;
    lease_token: string | null;
    lease_until: Timestamp | null;
    attempts: number;
    diagnostic_code: string | null;
  };
  activation_review_requests: {
    review_id: string;
    bot_identity: string;
    telegram_user_id: string;
    identity_ref: string;
    account_ref: string | null;
    /** Written as JSON text: node-postgres would send a bare array as a PostgreSQL array. */
    outcomes: ColumnType<readonly GroundOutcome[], string, string>;
    requested_at: Timestamp;
    updated_at: Timestamp;
    resolved_at: Timestamp | null;
    resolution: "confirmed" | "owner" | null;
  };
}
/** What one checked ground returned; codes and states only, never source payload. */
export interface GroundOutcome {
  readonly code: string;
  readonly outcome: string;
}
