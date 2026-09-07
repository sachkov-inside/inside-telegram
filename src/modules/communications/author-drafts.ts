import { CommunicationsError } from "./communications-contract.js";
import type { Action, Context, State } from "./author-admin.js";
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

export function compositions(c: Context) {
  return c.tx
    .selectFrom("communication_author_compositions")
    .selectAll()
    .where("bot_identity", "=", c.input.botIdentity)
    .where("owner_account_ref", "=", c.accountRef);
}
export async function retainComposition(c: Context) {
  const composer = c.state.composing;
  if (!composer) return;
  await c.tx
    .insertInto("communication_author_compositions")
    .values({
      bot_identity: c.input.botIdentity,
      owner_account_ref: c.accountRef,
      destination_id: composer.destination.id,
      state: JSON.stringify(c.state),
    })
    .onConflict((q) =>
      q
        .columns(["bot_identity", "owner_account_ref", "destination_id"])
        .doUpdateSet({ state: JSON.stringify(c.state) }),
    )
    .execute();
}
export async function discardComposition(c: Context, id: string) {
  await c.tx
    .deleteFrom("communication_author_compositions")
    .where("bot_identity", "=", c.input.botIdentity)
    .where("owner_account_ref", "=", c.accountRef)
    .where("destination_id", "=", id)
    .execute();
}
export async function compositionButtons(
  c: Context,
  id: string,
): Promise<[string, Action][]> {
  const pending = await compositions(c)
    .where("destination_id", "=", id)
    .executeTakeFirst();
  if (!pending) return [];
  return [
    ["Продолжить сообщение", { kind: "compose:resume", id }],
    ["Отменить добавление", { kind: "compose:discard", id }],
  ];
}
export async function restoreComposition(c: Context, id: string) {
  const pending = await compositions(c)
    .where("destination_id", "=", id)
    .executeTakeFirst();
  if (!pending) throw new CommunicationsError("not_found");
  c.state = pending.state as State;
}
