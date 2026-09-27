import type { Database } from "../../database/database.js";
import type { Clock } from "../../shared/clock.js";
import type { GroundOutcome } from "./activation-storage.js";

/** One person whose owner link confirmed no ground, waiting for the owner's decision. */
export interface ActivationReview {
  readonly reviewId: string;
  readonly botIdentity: string;
  readonly telegramUserId: string;
  readonly identityRef: string;
  readonly accountRef: string | null;
  readonly outcomes: readonly GroundOutcome[];
  readonly requestedAt: string;
  readonly updatedAt: string;
}

/**
 * The owner's review queue. Resolving records only that the owner decided; the right itself is
 * the owner's Direct Right on Platform, and a later confirmed ground resolves the request too.
 */
export class ActivationReviews {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async open(): Promise<readonly ActivationReview[]> {
    const rows = await this.db
      .selectFrom("activation_review_requests")
      .selectAll()
      .where("resolved_at", "is", null)
      .orderBy("requested_at")
      .orderBy("review_id")
      .execute();
    return rows.map((row) => ({
      reviewId: row.review_id,
      botIdentity: row.bot_identity,
      telegramUserId: row.telegram_user_id,
      identityRef: row.identity_ref,
      accountRef: row.account_ref,
      outcomes: row.outcomes,
      requestedAt: row.requested_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async resolve(reviewId: string): Promise<"resolved" | "not_found"> {
    const now = this.clock.now();
    const resolved = await this.db
      .updateTable("activation_review_requests")
      .set({ resolved_at: now, resolution: "owner", updated_at: now })
      .where("review_id", "=", reviewId)
      .where("resolved_at", "is", null)
      .returning("review_id")
      .executeTakeFirst();
    return resolved ? "resolved" : "not_found";
  }
}
