import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpPlatformCohortAdapter } from "../../src/adapters/platform/http-platform-cohort.adapter.js";
import fixtures from "../../src/contracts/platform-billing-cohorts/fixtures.json" with { type: "json" };
import provenance from "../../src/contracts/platform-billing-cohorts/provenance.json" with { type: "json" };
import schema from "../../src/contracts/platform-billing-cohorts/schema.json" with { type: "json" };

const endpoint = "https://platform.test/billing/cohorts";
const guideId = "5f0c2a4e-8d1b-4c3a-9e7f-1a2b3c4d5e6f";
const cohort = (overrides: Record<string, unknown> = {}) => ({
  guideId,
  revision: 1,
  name: "Поток 1",
  stage: "preorder",
  startsOn: "2026-10-20",
  nextEvent: "",
  ...overrides,
});
const adapter = (response: () => Promise<Response>) => {
  const fetcher = vi.fn<typeof fetch>(() => response());
  return {
    fetcher,
    source: new HttpPlatformCohortAdapter(endpoint, guideId, fetcher),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

const ajv = new Ajv.default({ allErrors: true, strict: false });
addFormats.default(ajv);
// Platform's OpenAPI 3.0 writes `exclusiveMinimum: true` beside `minimum`; Ajv reads the numeric form.
const validResponse = ajv.compile(
  JSON.parse(JSON.stringify(schema.response), (_key, value: unknown) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("exclusiveMinimum" in value) ||
      value.exclusiveMinimum !== true ||
      !("minimum" in value)
    )
      return value;
    const { minimum, ...rest } = value;
    return { ...rest, exclusiveMinimum: minimum };
  }),
);

describe("Platform GET /billing/cohorts contract", () => {
  it("keeps the vendored files as recorded in their provenance", () => {
    for (const [file, sha256] of Object.entries(provenance.files))
      expect(
        createHash("sha256")
          .update(
            readFileSync(`src/contracts/platform-billing-cohorts/${file}`),
          )
          .digest("hex"),
      ).toBe(sha256);
  });

  it("rejects a response Platform would never send", () => {
    const [first] = fixtures.valid;
    const item = first?.response.items[0];
    for (const invalid of [
      { items: [{ ...item, startsOn: "20 октября" }] },
      { items: [{ ...item, revision: 0 }] },
      { items: [{ ...item, stage: "sold_out" }] },
      { items: [item], total: 1 },
    ])
      expect(validResponse(invalid)).toBe(false);
  });

  it.each(fixtures.valid)(
    "Platform may answer $name, and the welcome takes its date",
    async (fixture) => {
      expect(validResponse(fixture.response)).toBe(true);
      const source = new HttpPlatformCohortAdapter(
        endpoint,
        fixtures.courseGuideId,
        () => Promise.resolve(Response.json(fixture.response)),
      );
      expect(await source.read()).toEqual(
        "streamStartsOn" in fixture
          ? { streamStartsOn: fixture.streamStartsOn }
          : {},
      );
    },
  );
});

describe("Platform current stream of the course", () => {
  it("reads the course's start date from the public cohorts list", async () => {
    const { fetcher, source } = adapter(() =>
      Promise.resolve(
        Response.json({
          items: [
            cohort({
              guideId: "00000000-0000-4000-8000-000000000001",
              startsOn: "2027-01-01",
            }),
            cohort({ guideId: guideId.toUpperCase() }),
          ],
        }),
      ),
    );

    expect(await source.read()).toEqual({ streamStartsOn: "2026-10-20" });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(endpoint);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves the date out when the course has no stream or the stream no date", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    for (const items of [
      [],
      [cohort({ guideId: "00000000-0000-4000-8000-000000000001" })],
      [cohort({ stage: "between", startsOn: null, nextEvent: "Скоро" })],
    ])
      expect(
        await adapter(() =>
          Promise.resolve(Response.json({ items })),
        ).source.read(),
      ).toEqual({});
    // An absent stream or date is an ordinary catalogue state, not a failure.
    expect(stderr).not.toHaveBeenCalled();
  });

  it("answers without a date when Platform is unavailable, slow or malformed", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const timeout = Object.assign(new Error("timed out"), {
      name: "TimeoutError",
    });
    for (const response of [
      () =>
        Promise.resolve(
          Response.json({ type: "dependency_unavailable" }, { status: 503 }),
        ),
      () => Promise.reject(timeout),
      () => Promise.resolve(new Response("not json", { status: 200 })),
      () => Promise.resolve(Response.json({ items: "none" })),
      () =>
        Promise.resolve(
          Response.json({ items: [cohort({ startsOn: "2026-02-30" })] }),
        ),
      () =>
        Promise.resolve(
          Response.json({ items: [cohort({ startsOn: "20 октября" })] }),
        ),
    ])
      expect(await adapter(response).source.read()).toEqual({});

    const failures = stderr.mock.calls.map((call) => String(call[0]));
    expect(failures.join("")).toContain('"failure":"platform_http_503"');
    expect(failures.join("")).toContain('"failure":"timeout"');
    expect(
      failures.filter((line) => line.includes("platform_response_invalid")),
    ).toHaveLength(3);
  });
});
