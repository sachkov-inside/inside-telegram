import type { Transition } from "./author-turn.js";
import { saveDraft } from "../../database/drafts.js";

export async function transition(): Promise<Transition> {
  await saveDraft();
  return { effects: [] };
}
