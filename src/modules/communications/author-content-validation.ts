import type { AuthorSubject } from "./author-authorization.js";
import type { MessagePart } from "./funnel-types.js";

export const AUTHOR_CONTENT_VALIDATION = Symbol("AUTHOR_CONTENT_VALIDATION");
export interface ContentTargetError {
  readonly url: string;
  readonly reason: "not_found" | "not_published" | "not_free" | "incomplete";
  readonly targetId: string | null;
}
export type AuthorContentValidationResult =
  | {
      readonly status: "ok";
      readonly targetErrors: readonly ContentTargetError[];
    }
  | { readonly status: "denied" | "unavailable" };
export interface AuthorContentValidation {
  validate(
    subject: AuthorSubject,
    parts: readonly MessagePart[],
  ): Promise<AuthorContentValidationResult>;
}
export class DisabledAuthorContentValidation implements AuthorContentValidation {
  async validate(): Promise<AuthorContentValidationResult> {
    return { status: "unavailable" };
  }
}
