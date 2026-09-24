/**
 * Names why an operation failed without exposing what it carried.
 *
 * Error messages and details can contain tokens, chat identifiers or row values, so only
 * classification fields leave this module: SQLSTATE, Telegram `error_code`, HTTP status,
 * a network error code, a timeout, a domain error code, or the error class name.
 */
export function failureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const fields = error as Error & {
    readonly code?: unknown;
    readonly error_code?: unknown;
    readonly severity?: unknown;
    readonly status?: unknown;
    readonly cause?: unknown;
  };
  if (error.name === "TimeoutError" || error.name === "AbortError")
    return "timeout";
  if (error.name === "GrammyError" && typeof fields.error_code === "number")
    return `telegram_${fields.error_code}`;
  if (error.name === "HttpError") return "telegram_network";
  if (
    typeof fields.code === "string" &&
    typeof fields.severity === "string" &&
    /^[0-9A-Z]{5}$/.test(fields.code)
  )
    return `pg_${fields.code}`;
  if (typeof fields.code === "string" && /^E[A-Z_]+$/.test(fields.code))
    return `network_${fields.code}`;
  if (typeof fields.status === "number") return `http_${fields.status}`;
  if (error.name === "CommunicationsError" && typeof fields.code === "string")
    return `communications_${fields.code}`;
  if (fields.cause instanceof Error) {
    const cause = failureCode(fields.cause);
    if (cause !== `error_${normalized(fields.cause.name)}`) return cause;
  }
  return `error_${normalized(error.name)}`;
}

/**
 * Writes one structured line for a failure that the caller absorbs. References must be
 * opaque identifiers (update ID, delivery ID); message text and payloads never belong here.
 */
export function reportFailure(
  scope: string,
  error: unknown,
  references: Readonly<Record<string, string | number>> = {},
): string {
  const failure = failureCode(error);
  reportCondition(scope, failure, references);
  return failure;
}

/** Writes one structured line for an abnormal outcome that is not an exception. */
export function reportCondition(
  scope: string,
  condition: string,
  references: Readonly<Record<string, string | number>> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({ level: "error", scope, failure: condition, ...references })}\n`,
  );
}

function normalized(name: string): string {
  return (
    name
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .slice(0, 48) || "unnamed"
  );
}
