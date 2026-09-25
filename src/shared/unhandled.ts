/** Ends an exhaustive switch; the compiler rejects a call that a new variant could reach. */
export function unhandled(value: never, subject: string): never {
  throw new Error(
    `Unhandled ${subject} ${(value as { kind?: unknown }).kind as string}`,
  );
}
