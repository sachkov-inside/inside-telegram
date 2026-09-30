import { Inject, Injectable } from "@nestjs/common";

import { DATABASE, type Database } from "../../database/database.js";
import {
  claimNext,
  retryDelay,
  settle,
  type DurableQueue,
  type QueueValues,
} from "../../database/durable-queue.js";
import { unhandled } from "../../shared/unhandled.js";
import {
  reportCondition,
  reportFailure,
} from "../../shared/failure-diagnostics.js";
import {
  SALES_FUNNEL_DELIVERY,
  type SalesFunnelDelivery,
  type SalesFunnelDeliveryResult,
} from "./sales-funnel-delivery.js";

const eventOutbox: DurableQueue<"sales_funnel_event_outbox"> = {
  table: "sales_funnel_event_outbox",
  key: ["event_id"],
  order: ["available_at", "sequence_id"],
  ready: ["pending", "retry_scheduled"],
  leased: "delivering",
  due: "available_at",
  attempts: "attempt_count",
  leasedAt: "locked_at",
  leaseMs: 60_000,
  retry: { initialMs: 1000, maxMs: 5 * 60_000 },
};

/**
 * Delivers queued sales funnel events to Platform. An event is retried with the same id until
 * Platform answers `200` or `409`; a `409` is a contract error and is logged, never retried.
 */
@Injectable()
export class SalesFunnelDeliveryProcessor {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SALES_FUNNEL_DELIVERY)
    private readonly platform: SalesFunnelDelivery,
  ) {}

  async processNext(
    now = new Date(),
  ): Promise<SalesFunnelDeliveryResult["kind"] | undefined> {
    const claimed = await claimNext(
      this.database,
      eventOutbox,
      now,
      {
        available_at: now,
        diagnostic_code: "worker_lease_expired",
        locked_at: null,
        state: "retry_scheduled",
      },
      { select: ["event", "event_id"] },
    );
    if (!claimed) return undefined;
    let result: SalesFunnelDeliveryResult;
    try {
      result = await this.platform.deliver(claimed.row.event);
    } catch (error) {
      reportFailure("sales-funnel.delivery", error, {
        event_id: claimed.row.event_id,
      });
      result = {
        kind: "retryable",
        diagnosticCode: "platform_transport_unavailable",
      };
    }
    const settled = await settle(this.database, eventOutbox, claimed, {
      ...outcome(result, now, claimed.attempt),
      locked_at: null,
    });
    // A lease lost to another worker leaves the report to the holder that settles the row.
    if (settled && result.kind === "conflict")
      reportCondition("sales-funnel.delivery", "event_conflict", {
        event_id: claimed.row.event_id,
      });
    return result.kind;
  }

  async processAvailable(limit = 50, now = new Date()): Promise<number> {
    let processed = 0;
    for (; processed < limit; processed += 1) {
      if (!(await this.processNext(now))) break;
    }
    return processed;
  }
}

function outcome(
  result: SalesFunnelDeliveryResult,
  now: Date,
  attempt: number,
): QueueValues<"sales_funnel_event_outbox"> {
  switch (result.kind) {
    case "delivered":
      return {
        state: "delivered",
        available_at: now,
        delivered_at: now,
        diagnostic_code: null,
      };
    case "conflict":
      return {
        state: "rejected",
        available_at: now,
        diagnostic_code: "platform_event_conflict",
      };
    case "retryable":
      return {
        state: "retry_scheduled",
        available_at: new Date(
          now.getTime() + retryDelay(eventOutbox, attempt),
        ),
        diagnostic_code: result.diagnosticCode,
      };
    default:
      return unhandled(result, "sales funnel delivery result");
  }
}
