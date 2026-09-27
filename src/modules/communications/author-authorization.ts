import { externalRead } from "../../database/external-reads.js";
import type { Actor } from "./communications-contract.js";
export const AUTHOR_AUTHORIZATION = Symbol("AUTHOR_AUTHORIZATION");
export type AuthorSubject =
  | (Actor & { readonly kind: "account" })
  | (Actor & {
      readonly kind: "telegram";
      readonly telegramIdentityRef: string;
      readonly botIdentity: string;
    });
export interface AuthorAuthorization {
  authorize(
    subject: AuthorSubject,
  ): Promise<"allowed" | "denied" | "unavailable">;
}
export class DisabledAuthorAuthorization implements AuthorAuthorization {
  authorize(): Promise<"unavailable"> {
    return Promise.resolve("unavailable");
  }
}

/**
 * Asks Platform whether the subject may act as an author. Inside
 * {@link transactionWithExternalReads} the call runs with no transaction open.
 */
export function authorizeAuthor(
  authorization: AuthorAuthorization,
  subject: AuthorSubject,
): Promise<"allowed" | "denied" | "unavailable"> {
  return externalRead(`author-authorization:${JSON.stringify(subject)}`, () =>
    authorization.authorize(subject),
  );
}
