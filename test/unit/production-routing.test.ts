import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const template = readFileSync(
  "infra/production/telegram.caddy.example",
  "utf8",
);
const pattern = template.match(/^\s*path_regexp provider (\S+)$/m)?.[1];
if (!pattern) throw new Error("Production provider route matcher is missing");
const paths = new RegExp(pattern);

describe("production provider routes", () => {
  it("restricts the authenticated upstream to POST and keeps a closed fallback", () => {
    expect(template.match(/^\s*method (.+)$/m)?.[1]).toBe("POST");
    expect(template).toContain("respond 404");
    expect(template).toContain("reverse_proxy 127.0.0.1:3303");
  });

  it.each([
    "/webhooks/telegram",
    "/integrations/platform/v1/identity-links",
    "/integrations/platform/v1/community-entitlements",
    "/integrations/platform/v1/identity-links/reference/confirm",
    "/integrations/identity/v1/sign-in",
    "/integrations/identity/v1/sign-in/reference/status",
    "/integrations/identity/v1/sign-in/reference/consume",
    "/integrations/identity/v1/sign-in/reference/account-link",
  ])("admits the existing provider endpoint %s", (path) => {
    expect(paths.test(path)).toBe(true);
  });

  it.each([
    "/",
    "/health",
    "/webhooks/telegram/extra",
    "/integrations/identity/v1/sign-in/",
    "/integrations/identity/v1/sign-in/reference",
    "/integrations/identity/v1/sign-in//status",
    "/integrations/identity/v1/sign-in/a/b/status",
    "/integrations/identity/v1/sign-in/reference/status/extra",
    "/integrations/identity/v1/sign-in/reference/complete",
    "/integrations/platform/v1/identity-links/a/b/confirm",
    "/integrations/platform/v1/communications",
    "/integrations/platform/v1/community-entitlements/extra",
    "/prefix/integrations/identity/v1/sign-in",
  ])("rejects paths outside the production boundary: %s", (path) => {
    expect(paths.test(path)).toBe(false);
  });
});
