import { expect } from "vitest";

/** Matches any string; typed `unknown` so object literals that hold it stay type-safe. */
export function anyString(): unknown {
  return expect.any(String);
}
