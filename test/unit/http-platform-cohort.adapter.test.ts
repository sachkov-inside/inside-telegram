import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpPlatformCohortAdapter } from "../../src/adapters/platform/http-platform-cohort.adapter.js";

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
    for (const items of [
      [],
      [cohort({ guideId: "00000000-0000-4000-8000-000000000001" })],
      [cohort({ stage: "between", startsOn: null, nextEvent: "Скоро" })],
      [cohort({ startsOn: "2026-02-30" })],
      [cohort({ startsOn: "20 октября" })],
    ])
      expect(
        await adapter(() =>
          Promise.resolve(Response.json({ items })),
        ).source.read(),
      ).toEqual({});
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
    ])
      expect(await adapter(response).source.read()).toEqual({});

    const failures = stderr.mock.calls.map((call) => String(call[0]));
    expect(failures.join("")).toContain('"failure":"platform_http_503"');
    expect(failures.join("")).toContain('"failure":"timeout"');
  });
});
