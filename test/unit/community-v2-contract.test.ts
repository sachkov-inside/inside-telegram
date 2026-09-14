import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMUNITY_V2,
  assertCommunityResult,
  parseCommunityRequest,
  validDispatchResponse,
  type CommunityResult,
} from "../../src/modules/community/community-contract.js";
import fixtures from "../../docs/contracts/community-v2/fixtures.json" with { type: "json" };

describe("portable v2 runtime corpus", () => {
  it("ships both schemas inside dist and prevents drift from their portable copies", () => {
    expect(
      readFileSync("src/modules/community/contracts/schema-v2.json"),
    ).toEqual(readFileSync("docs/contracts/community-v2/schema.json"));
    expect(
      readFileSync("src/modules/subscription-activation/contracts/schema.json"),
    ).toEqual(
      readFileSync("docs/contracts/subscription-activation-v1/schema.json"),
    );
  });
  for (const fixture of fixtures) {
    if (fixture.definition === "communityRequest")
      it(fixture.name, () => {
        expect(
          parseCommunityRequest(fixture.value, COMMUNITY_V2).kind !==
            "rejected",
        ).toBe(fixture.valid);
      });
    if (
      fixture.definition === "communityResponse" &&
      fixture.value.operation === "entitlement.result"
    )
      it(fixture.name, () => {
        const run = () =>
          assertCommunityResult(fixture.value as unknown as CommunityResult);
        if (fixture.valid) expect(run).not.toThrow();
        else expect(run).toThrow();
      });
    if (fixture.definition === "authorizationResponse")
      it(fixture.name, () => {
        expect(validDispatchResponse(fixture.value)).toBe(fixture.valid);
      });
  }
});
