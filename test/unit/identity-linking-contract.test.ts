import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import fixtures from "../../src/modules/identity-linking/contracts/inside-identity-linking-v1/fixtures.json" with { type: "json" };
import schema from "../../src/modules/identity-linking/contracts/inside-identity-linking-v1/schema.json" with { type: "json" };
import {
  readBeginLinkEnvelope,
  readConfirmationEnvelope,
  readTokenReceiptEnvelope,
} from "../../src/modules/identity-linking/identity-linking-http.contract.js";

describe("inside.identity-linking.v1 contract", () => {
  const ajv = new Ajv2020.default({ allErrors: true, strict: true });
  addFormats.default(ajv);
  const validate = ajv.compile(schema);

  it.each(fixtures.messages)("validates $name", (fixture) => {
    expect(validate(fixture.envelope)).toBe(fixture.expectedValid);

    if (fixture.parseAs === "begin") {
      expect(readBeginLinkEnvelope(fixture.envelope) !== undefined).toBe(
        fixture.expectedValid,
      );
    } else if (fixture.parseAs === "confirmation") {
      expect(
        readConfirmationEnvelope("link-transaction-ref-a", fixture.envelope) !==
          undefined,
      ).toBe(fixture.expectedValid);
    } else if (fixture.parseAs === "receipt") {
      expect(readTokenReceiptEnvelope(fixture.envelope) !== undefined).toBe(
        fixture.expectedValid,
      );
    }
  });
});
