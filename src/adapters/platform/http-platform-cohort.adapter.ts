import type {
  CommunityWelcomeDetails,
  CommunityWelcomeDetailsSource,
} from "../../modules/community/community-welcome.js";
import {
  reportCondition,
  reportFailure,
} from "../../shared/failure-diagnostics.js";

// The welcome waits for this read, and its personal link lives only minutes.
const READ_TIMEOUT_MILLISECONDS = 2_000;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Public `GET /billing/cohorts` of Platform, vendored in `src/contracts/platform-billing-cohorts`: the current stream of every product. The course
 * is found by its Platform product UUID, because the response carries no slug.
 */
export class HttpPlatformCohortAdapter implements CommunityWelcomeDetailsSource {
  private readonly guideId: string;

  constructor(
    private readonly endpoint: string,
    guideId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.guideId = guideId.toLowerCase();
  }

  async read(): Promise<CommunityWelcomeDetails> {
    let body: unknown;
    try {
      const response = await this.fetcher(this.endpoint, {
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(READ_TIMEOUT_MILLISECONDS),
      });
      if (response.status !== 200) {
        reportCondition(
          "platform.cohort-read",
          `platform_http_${response.status}`,
        );
        return {};
      }
      body = await response.json();
    } catch (error) {
      reportFailure("platform.cohort-read", error);
      return {};
    }
    const startsOn = this.startsOn(body);
    // A body outside the contract is noticed, not shown: the welcome still goes without a date.
    if (startsOn === undefined)
      reportCondition("platform.cohort-read", "platform_response_invalid");
    return startsOn ? { streamStartsOn: startsOn } : {};
  }

  /** The course's start date, `null` without a stream or date, `undefined` for a foreign body. */
  private startsOn(body: unknown): string | null | undefined {
    if (typeof body !== "object" || body === null || !("items" in body))
      return undefined;
    const { items } = body;
    if (!Array.isArray(items)) return undefined;
    const cohort: unknown = items.find(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "guideId" in item &&
        typeof item.guideId === "string" &&
        item.guideId.toLowerCase() === this.guideId,
    );
    if (cohort === undefined) return null;
    if (
      typeof cohort !== "object" ||
      cohort === null ||
      !("startsOn" in cohort)
    )
      return undefined;
    const { startsOn } = cohort;
    if (startsOn === null) return null;
    return typeof startsOn === "string" && calendarDate(startsOn)
      ? startsOn
      : undefined;
  }
}

/** A real `YYYY-MM-DD` day: a malformed date is left out rather than printed wrong. */
function calendarDate(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
