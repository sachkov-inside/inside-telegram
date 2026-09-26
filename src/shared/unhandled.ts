/** Ends an exhaustive switch; the compiler rejects a call that a new variant could reach. */
export function unhandled(value: never, subject: string): never {
  const received: unknown = value;
  const kind =
    typeof received === "object" && received !== null && "kind" in received
      ? received.kind
      : undefined;
  throw new Error(
    `Unhandled ${subject} ${typeof kind === "string" ? kind : "variant"}`,
  );
}
