import { createHash } from "node:crypto";

import { externalRead } from "../../database/external-reads.js";
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
  validate(): Promise<AuthorContentValidationResult> {
    return Promise.resolve({ status: "unavailable" });
  }
}

/**
 * Asks Platform to validate content links. Inside {@link transactionWithExternalReads} the
 * call runs with no transaction open; the answer is reused only for identical content.
 */
export function validateAuthorContent(
  validation: AuthorContentValidation,
  subject: AuthorSubject,
  parts: readonly MessagePart[],
): Promise<AuthorContentValidationResult> {
  const request = createHash("sha256")
    .update(JSON.stringify({ subject, parts }))
    .digest("hex");
  return externalRead(`author-content-validation:${request}`, () =>
    validation.validate(subject, parts),
  );
}
