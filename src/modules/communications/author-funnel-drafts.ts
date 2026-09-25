import { randomUUID } from "node:crypto";
import type { Context } from "./author-admin.js";
import { parseFunnelDraft, type AuthorFunnelState } from "./author-dialog.js";
import { drafts } from "./author-drafts.js";
import { authorRequest } from "./author-request.js";
import type { FunnelListItem } from "./author-turn.js";
import { CommunicationsError } from "./communications-contract.js";
import type { Funnels } from "./funnels.js";

/** Reads the author's funnels and shared intro, preferring an unsaved draft to the saved version. */
export class AuthorFunnelDrafts {
  constructor(private readonly funnels: Funnels) {}

  /** A page of the author's funnels, saved ones and unsaved drafts together. */
  async list(
    c: Context,
    cursor: string | undefined,
  ): Promise<{ items: FunnelListItem[]; nextCursor?: string }> {
    let saved = c.tx
      .selectFrom("communication_funnels")
      .select("funnel_id as id")
      .where("bot_identity", "=", c.input.botIdentity)
      .where("owner_account_ref", "=", c.accountRef);
    let scratch = c.tx
      .selectFrom("communication_author_drafts")
      .select("draft_id as id")
      .where("bot_identity", "=", c.input.botIdentity)
      .where("owner_account_ref", "=", c.accountRef)
      .where("kind", "=", "funnel");
    if (cursor) {
      saved = saved.where("funnel_id", ">", cursor);
      scratch = scratch.where("draft_id", ">", cursor);
    }
    const ids = await saved.union(scratch).orderBy("id").limit(11).execute();
    const items: FunnelListItem[] = [];
    for (const { id } of ids.slice(0, 10)) {
      const draft = await drafts(c)
        .where("draft_id", "=", id)
        .executeTakeFirst();
      if (draft) items.push({ id, name: draft.name, status: "edited" });
      else {
        const result = await this.funnels.execute(
          authorRequest(c.accountRef, "funnels.read", { funnelId: id }),
          c.tx,
        );
        if ("funnel" in result)
          items.push({
            id,
            name: result.funnel.name,
            status: result.funnel.lifecycle,
          });
      }
    }
    return { items, nextCursor: ids.length > 10 ? ids[9]?.id : undefined };
  }

  async read(c: Context, funnelId: string): Promise<AuthorFunnelState> {
    const draft = await drafts(c)
      .where("draft_id", "=", funnelId)
      .where("kind", "=", "funnel")
      .executeTakeFirst();
    const snapshot = parseFunnelDraft(draft?.snapshot);
    if (snapshot) return snapshot;
    const result = await this.funnels.execute(
      authorRequest(c.accountRef, "funnels.read", { funnelId }),
      c.tx,
    );
    if (!("funnel" in result)) throw new CommunicationsError("malformed");
    return { funnel: result.funnel, dirty: false };
  }

  /** The shared intro; a new empty one when the author has none yet. */
  async readIntro(c: Context): Promise<AuthorFunnelState> {
    const draft = await drafts(c)
      .where("kind", "=", "intro")
      .executeTakeFirst();
    const snapshot = parseFunnelDraft(draft?.snapshot);
    if (snapshot) return snapshot;
    try {
      const result = await this.funnels.execute(
        authorRequest(c.accountRef, "intro.read", {}),
        c.tx,
      );
      if (!("intro" in result)) throw new CommunicationsError("malformed");
      return { intro: result.intro, target: "intro", dirty: false };
    } catch (error) {
      if (!(error instanceof CommunicationsError) || error.code !== "not_found")
        throw error;
      return {
        intro: { introId: randomUUID(), revision: 0, parts: [] },
        target: "intro",
        dirty: false,
      };
    }
  }

  /** Whether any published version of the funnel already delivered this message. */
  async published(c: Context, funnelId: string, partId: string) {
    const historical = await c.tx
      .selectFrom("communication_step_ids")
      .select("part_ids")
      .where("funnel_id", "=", funnelId)
      .execute();
    return historical.some((step) =>
      (step.part_ids as string[]).includes(partId),
    );
  }
}
