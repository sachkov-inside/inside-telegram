import { type Kysely } from "kysely";

export interface Transition {
  readonly effects: readonly unknown[];
  readonly database?: Kysely<unknown>;
}

export { type Transaction } from "kysely";
