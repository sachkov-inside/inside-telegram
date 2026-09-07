import { randomUUID } from "node:crypto";
import type { Context } from "./author-admin.js";
import { authorRequest } from "./author-request.js";
import type { broadcastView } from "./broadcasts.js";
import { drafts, saveAuthorDraft } from "./author-drafts.js";
import { CommunicationsError } from "./communications-contract.js";
import type { Funnels } from "./funnels.js";
export const broadcastNames = {
  draft: "Черновик",
  scheduled: "Запланирована",
  running: "Отправляется",
  paused: "Приостановлена",
  cancelled: "Отменена",
  completed: "Завершена",
};
export type AuthorBroadcast = ReturnType<typeof broadcastView>;
export function newBroadcast(
  parts: AuthorBroadcast["parts"] = [],
): AuthorBroadcast {
  return {
    broadcastId: randomUUID(),
    revision: 0,
    state: "draft",
    parts: parts.map((p) => ({ ...p, partId: randomUUID() })),
    audience: { kind: "all" },
    scheduledAt: null,
    audienceSnapshotId: null,
    snapshotSize: 0,
  };
}
export async function retainBroadcast(c: Context) {
  const b = c.state.broadcast;
  if (!b) return;
  await saveAuthorDraft(
    c,
    b.broadcastId,
    "broadcast",
    c.state.broadcastName ?? "Новая рассылка",
    b.revision === 0 ? b : null,
  );
}
export class AuthorBroadcastDrafts {
  constructor(private readonly funnels: Funnels) {}
  async read(c: Context, id: string) {
    const draft = await drafts(c)
      .where("draft_id", "=", id)
      .where("kind", "=", "broadcast")
      .executeTakeFirst();
    try {
      const response = await this.funnels.execute(
        authorRequest(c.accountRef, "broadcasts.read", { broadcastId: id }),
        c.tx,
      );
      if (!("broadcast" in response))
        throw new CommunicationsError("malformed");
      c.state.broadcast = response.broadcast;
    } catch (error) {
      if (
        !(error instanceof CommunicationsError) ||
        error.code !== "not_found" ||
        !draft?.snapshot
      )
        throw error;
      const snapshot = draft.snapshot as AuthorBroadcast;
      if (snapshot.revision !== 0) throw error;
      c.state.broadcast = snapshot;
    }
    c.state.broadcastName =
      draft?.name ??
      c.state.broadcast.parts[0]?.content.text.slice(0, 128) ??
      "Рассылка";
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
    const result = [];
    for (const { id } of ids.slice(0, 10)) {
      await this.read(c, id);
      result.push({
        broadcast: c.state.broadcast!,
        name: c.state.broadcastName!,
      });
    }
    return { items: result, nextCursor: ids.length > 10 ? ids[9]!.id : null };
  }
}
