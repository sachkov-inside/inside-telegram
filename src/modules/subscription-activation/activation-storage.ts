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
  };
}
