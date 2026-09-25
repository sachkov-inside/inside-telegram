import { CommunicationsError } from "./communications-contract.js";
import type { Context } from "./author-admin.js";
import {
  parseAuthorState,
  type AuthorFunnelState,
  type AuthorState,
  type ComposerState,
} from "./author-dialog.js";

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
/** Keeps an edited funnel or intro as a draft, and drops the draft of an unchanged one. */
export async function retainFunnelDraft(
  c: Context,
  s: AuthorFunnelState | undefined,
) {
  const draft =
    s?.target === "intro"
      ? s.intro && {
          id: s.intro.introId,
          kind: "intro" as const,
          name: "Общий вводный блок",
        }
      : s?.funnel && {
          id: s.funnel.funnelId,
          kind: "funnel" as const,
          name: s.funnel.name,
        };
  if (!s || !draft) return;
  if (s.dirty) await saveAuthorDraft(c, draft.id, draft.kind, draft.name, s);
  else await removeAuthorDraft(c, draft.id);
}

function compositions(c: Context) {
  return c.tx
    .selectFrom("communication_author_compositions")
    .selectAll()
    .where("bot_identity", "=", c.input.botIdentity)
    .where("owner_account_ref", "=", c.accountRef);
}
/** Stores the session of an unfinished message so it survives leaving the menu. */
export async function retainComposition(c: Context, state: AuthorState) {
  const composer = state.composing;
  if (!composer) return;
  await c.tx
    .insertInto("communication_author_compositions")
    .values({
      bot_identity: c.input.botIdentity,
      owner_account_ref: c.accountRef,
      destination_id: composer.destination.id,
      state: JSON.stringify(state),
    })
    .onConflict((q) =>
      q
        .columns(["bot_identity", "owner_account_ref", "destination_id"])
        .doUpdateSet({ state: JSON.stringify(state) }),
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
/** The destinations that have an unfinished message. */
export async function pendingCompositions(c: Context): Promise<Set<string>> {
  const rows = await c.tx
    .selectFrom("communication_author_compositions")
    .select("destination_id")
    .where("bot_identity", "=", c.input.botIdentity)
    .where("owner_account_ref", "=", c.accountRef)
    .execute();
  return new Set(rows.map((row) => row.destination_id));
}
export async function loadComposition(
  c: Context,
  id: string,
): Promise<ComposerState> {
  const pending = await compositions(c)
    .where("destination_id", "=", id)
    .executeTakeFirst();
  if (!pending) throw new CommunicationsError("not_found");
  // A composition stores the whole session it came from; an untrusted one is not restored.
  const composer = parseAuthorState(pending.state)?.composing;
  if (!composer) throw new CommunicationsError("not_found");
  return composer;
}
