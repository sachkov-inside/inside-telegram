import type { Context } from "./author-admin.js";
import { parseBroadcastDraft, type AuthorBroadcast } from "./author-dialog.js";
import { authorRequest } from "./author-request.js";
import { drafts } from "./author-drafts.js";
import { CommunicationsError } from "./communications-contract.js";
import type { Funnels } from "./funnels.js";

/** Reads the author's broadcasts, including the unsaved ones that exist only as drafts. */
export class AuthorBroadcastDrafts {
  constructor(private readonly funnels: Funnels) {}
  async read(
    c: Context,
    id: string,
  ): Promise<{ broadcast: AuthorBroadcast; name: string }> {
    const draft = await drafts(c)
      .where("draft_id", "=", id)
      .where("kind", "=", "broadcast")
      .executeTakeFirst();
    let broadcast: AuthorBroadcast;
    try {
      const response = await this.funnels.execute(
        authorRequest(c.accountRef, "broadcasts.read", { broadcastId: id }),
        c.tx,
      );
      if (!("broadcast" in response))
        throw new CommunicationsError("malformed");
      broadcast = response.broadcast;
    } catch (error) {
      const snapshot = parseBroadcastDraft(draft?.snapshot);
      if (
        !(error instanceof CommunicationsError) ||
        error.code !== "not_found" ||
        snapshot?.revision !== 0
      )
        throw error;
      broadcast = snapshot;
    }
    return {
      broadcast,
      name:
        draft?.name ??
        broadcast.parts[0]?.content.text.slice(0, 128) ??
        "Рассылка",
    };
  }
  async list(c: Context, cursor?: string) {
    let published = c.tx
      .selectFrom("communication_broadcasts")
      .select("broadcast_id as id")
      .where("bot_identity", "=", c.input.botIdentity)
      .where("owner_account_ref", "=", c.accountRef);
    let empty = c.tx
      .selectFrom("communication_author_drafts")
      .select("draft_id as id")
      .where("bot_identity", "=", c.input.botIdentity)
      .where("owner_account_ref", "=", c.accountRef)
      .where("kind", "=", "broadcast")
      .where("snapshot", "is not", null);
    if (cursor) {
      published = published.where("broadcast_id", ">", cursor);
      empty = empty.where("draft_id", ">", cursor);
    }
    const ids = await published.union(empty).orderBy("id").limit(11).execute();
    const items = [];
    for (const { id } of ids.slice(0, 10)) items.push(await this.read(c, id));
    return { items, nextCursor: ids.length > 10 ? ids[9]?.id : undefined };
  }
}
