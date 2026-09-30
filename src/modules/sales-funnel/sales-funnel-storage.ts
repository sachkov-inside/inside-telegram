import type { ColumnType, Generated } from "kysely";

import type { JsonColumn } from "../../database/database.js";
import type { SalesFunnelEvent } from "./sales-funnel-events.js";

type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface SalesFunnelTables {
  /** One row per event for Platform, written in the transaction of the fact it reports. */
  sales_funnel_event_outbox: {
    sequence_id: Generated<string>;
    event_id: string;
    bot_identity: string;
    kind: SalesFunnelEvent["kind"];
    event: JsonColumn<SalesFunnelEvent>;
    created_at: Timestamp;
    state: Generated<
      "pending" | "delivering" | "retry_scheduled" | "delivered" | "rejected"
    >;
    attempt_count: Generated<number>;
    available_at: Timestamp;
    locked_at: Timestamp | null;
    delivered_at: Timestamp | null;
    diagnostic_code: string | null;
  };
}
