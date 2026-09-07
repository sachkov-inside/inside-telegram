import type { Context } from "./author-admin.js";
import type { AuthorFunnelState } from "./author-funnels.js";

type Kind = "broadcast" | "funnel" | "intro";
export function drafts(c: Context) {
  return c.tx
    .selectFrom("communication_author_drafts")
    .selectAll()
    .where("bot_identity", "=", c.input.botIdentity)
    .where("owner_account_ref", "=", c.accountRef);
}
export async function saveAuthorDraft(
  c: Context,
  id: string,
  kind: Kind,
  name: string,
  snapshot: unknown,
) {
  await c.tx
    .insertInto("communication_author_drafts")
    .values({
      bot_identity: c.input.botIdentity,
      owner_account_ref: c.accountRef,
      draft_id: id,
      kind,
      name,
      snapshot: snapshot === null ? null : JSON.stringify(snapshot),
    })
    .onConflict((q) =>
      q.columns(["bot_identity", "owner_account_ref", "draft_id"]).doUpdateSet({
        name,
        snapshot: snapshot === null ? null : JSON.stringify(snapshot),
      }),
    )
    .execute();
}
export async function removeAuthorDraft(c: Context, id: string) {
  await c.tx
    .deleteFrom("communication_author_drafts")
    .where("bot_identity", "=", c.input.botIdentity)
    .where("owner_account_ref", "=", c.accountRef)
    .where("draft_id", "=", id)
    .execute();
}
export async function retainFunnelDraft(c: Context) {
  const s: AuthorFunnelState | undefined = c.state.funnelAuthor;
  const id = s?.target === "intro" ? s.intro?.introId : s?.funnel?.funnelId;
  if (!s || !id) return;
  if (s.dirty)
    await saveAuthorDraft(
      c,
      id,
      s.target === "intro" ? "intro" : "funnel",
      s.target === "intro" ? "Общий вводный блок" : s.funnel!.name,
      s,
    );
  else await removeAuthorDraft(c, id);
}
