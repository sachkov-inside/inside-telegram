import { createHash } from "node:crypto";

/**
 * Sorted object keys, original array order, no incidental whitespace.
 * Both integration protocols fingerprint the exact schema-valid wire payload,
 * so this stays the single canonical form for every cross-application digest.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
