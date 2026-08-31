import { describe, expect, it } from "vitest";

import {
  localProofDatabaseUrl,
  loopbackHttpUrl,
} from "../../scripts/conformance-safety.js";

describe("conformance harness safety", () => {
  it("accepts only direct loopback proof databases", () => {
    const safe = "postgresql://inside:inside@127.0.0.1:5433/issue8_proof";

    expect(localProofDatabaseUrl(safe, "DATABASE_URL")).toBe(safe);
    expect(() =>
      localProofDatabaseUrl(
        `${safe}?host=production-db.example&port=5432`,
        "DATABASE_URL",
      ),
    ).toThrow(/without routing parameters/u);
    expect(() =>
      localProofDatabaseUrl(
        "postgresql://inside:inside@production-db.example/issue8_proof",
        "DATABASE_URL",
      ),
    ).toThrow(/direct loopback/u);
    expect(() =>
      localProofDatabaseUrl(
        "postgresql://inside:inside@127.0.0.1/ordinary_database",
        "DATABASE_URL",
      ),
    ).toThrow(/proof database/u);
  });

  it("accepts only direct loopback HTTP endpoints", () => {
    const safe = "http://127.0.0.1:44101/evidence";

    expect(loopbackHttpUrl(safe, "ENDPOINT")).toBe(safe);
    expect(() =>
      loopbackHttpUrl("https://platform.example/evidence", "ENDPOINT"),
    ).toThrow(/direct loopback/u);
  });
});
