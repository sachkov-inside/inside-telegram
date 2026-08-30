export function isOpaqueRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    value.trim().length > 0
  );
}
