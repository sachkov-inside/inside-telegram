// Readers for JSON that crosses a test boundary: a fixture, a request a double received, or the
// output of a script. Each fails the test when the value has a different shape.

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a JSON object");
  return Object.fromEntries(Object.entries(value));
}

export function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a JSON array");
  const items: readonly unknown[] = value;
  return items.map(record);
}

export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a JSON string");
  return value;
}

/** Parses JSON text that holds an object. */
export function jsonRecord(source: string): Record<string, unknown> {
  return record(JSON.parse(source));
}

/** The body a fetch double received; adapters under test send JSON text. */
export function requestBody(init: RequestInit | undefined): string {
  return text(init?.body);
}

/** The address a fetch double was called with. */
export function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

/** A fixture value the contract validator accepts, typed as the shape it describes. */
export function conforming<Shape>(
  value: unknown,
  valid: (value: unknown) => value is Shape,
): Shape {
  if (!valid(value)) throw new Error("Fixture does not match its contract");
  return value;
}
