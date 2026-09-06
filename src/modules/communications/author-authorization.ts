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
  async authorize(): Promise<"unavailable"> {
    return "unavailable";
  }
}
