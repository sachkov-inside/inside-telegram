import type { ColumnType, Generated } from "kysely";
import type {
  NotificationCommand,
  NotificationResult,
} from "./notification-contract.js";
type Timestamp = ColumnType<Date, Date, Date>;
export interface NotificationTables {
  notification_deliveries: {
    delivery_ref: string;
    latest_operation: string;
    result_revision: number;
  };
  notification_commands: {
    operation_id: string;
    delivery_ref: string;
    bot_identity: string;
    command_revision: number;
    payload_digest: string;
    command: NotificationCommand;
    result: NotificationResult;
    state: NotificationResult["state"];
    category: string;
    available_at: Timestamp;
    retry_count: number;
    created_at: Timestamp;
  };
  notification_attempts: {
    attempt_ref: string;
    operation_id: string;
    permit_ref: string;
    started_at: Timestamp;
    outcome: "started" | "unknown" | "sent" | "not_sent" | "rejected";
    receipt_ref: string | null;
    provider_message_id: string | null;
  };
  notification_result_outbox: {
    message_id: string;
    result: NotificationResult;
    published_at: Timestamp | null;
    created_at: Timestamp;
  };
  notification_quarantine: {
    id: Generated<string>;
    digest: string;
    reason: string;
    encrypted_payload: string | null;
    created_at: Timestamp;
  };
}
