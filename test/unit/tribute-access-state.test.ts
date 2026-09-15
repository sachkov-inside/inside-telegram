import { describe, expect, it } from "vitest";
import { HttpActivationPlatform } from "../../src/adapters/platform/http-activation-platform.adapter.js";
import {
  ACTIVATION_VERSION,
  type ActivationResponse,
  type EnrollmentView,
  type OwnAccess,
  validActivationResponse,
  validOwnAccessResponse,
} from "../../src/modules/subscription-activation/activation-contract.js";
import { ownAccessText } from "../../src/modules/subscription-activation/activation-view.js";
import fixtures from "../../docs/contracts/subscription-activation-v1/fixtures.json" with { type: "json" };

const ownFixture = fixtures.find(
  (fixture) => fixture.name === "own-tribute-pending_verification",
)?.value as { ok: true; value: OwnAccess };
const activationFixture = fixtures.find(
  (fixture) => fixture.name === "nested-enrollment-pending_verification",
)?.value as { ok: true; value: ActivationResponse };
const enrollmentFixture = (() => {
  const enrollment = ownFixture.value.enrollments[0];
  if (!enrollment)
    throw new Error("Portable own-access fixture has no Enrollment");
  return enrollment;
})();
const binding = {
  accountRef: "synthetic-account",
  identityRef: "synthetic-identity",
  linkRef: "62500000-0000-4000-8000-000000000005",
  linkRevision: 1,
};
const states = [
  ["scheduled", "Начнётся позже"],
  ["active", "Действует"],
  ["expired", "Срок завершён"],
  ["revoked", "Отозвано"],
  ["pending_verification", "Ожидает подтверждения Tribute"],
  ["suspended_source", "Источник Tribute завершён"],
] as const;

describe("Platform-owned shared Enrollment state", () => {
  it.each(states)("accepts %s in both HTTP response paths", async (state) => {
    const enrollment = { ...enrollmentFixture, state };
    const own = {
      ...ownFixture,
      value: { ...ownFixture.value, enrollments: [enrollment] },
    };
    const activation = {
      ...activationFixture,
      value: { ...activationFixture.value, enrollment },
    };
    const consumer = new HttpActivationPlatform(
      "https://platform.example/activation",
      "synthetic-secret",
      async (url) =>
        Response.json(String(url).endsWith("/own-access") ? own : activation),
    );
    expect(await consumer.own(binding)).toEqual(own);
    expect(
      await consumer.begin({
        contractVersion: ACTIVATION_VERSION,
        attemptId: activation.value.attemptId,
        identityRef: binding.identityRef,
        code: "course",
      }),
    ).toEqual(activation);
  });

  it.each(["pending_verification", "suspended_source"])(
    "does not widen activation outcome to %s",
    (state) => {
      const payload = structuredClone(activationFixture);
      expect(
        validActivationResponse({
          ...payload,
          value: { ...payload.value, state },
        }),
      ).toBe(false);
    },
  );

  it.each(["unknown", "source_ended", "observation_stale"])(
    "rejects non-wire Enrollment state %s in both paths",
    (state) => {
      const enrollment = { ...enrollmentFixture, state };
      expect(
        validOwnAccessResponse({
          ok: true,
          value: { ...ownFixture.value, enrollments: [enrollment] },
        }),
      ).toBe(false);
      expect(
        validActivationResponse({
          ok: true,
          value: { ...activationFixture.value, enrollment },
        }),
      ).toBe(false);
    },
  );

  it("keeps nested Enrollment objects strict", () => {
    const enrollment = {
      ...enrollmentFixture,
      restoreOnMember: true,
    };
    expect(
      validOwnAccessResponse({
        ok: true,
        value: { ...ownFixture.value, enrollments: [enrollment] },
      }),
    ).toBe(false);
    expect(
      validActivationResponse({
        ok: true,
        value: { ...activationFixture.value, enrollment },
      }),
    ).toBe(false);
  });
});

function accessWith(state: EnrollmentView["state"]): OwnAccess {
  return {
    ...structuredClone(ownFixture.value),
    enrollments: [{ ...enrollmentFixture, state }],
  };
}

describe("own-access next steps", () => {
  it.each(states)("renders %s without changing its meaning", (state, label) => {
    const text = ownAccessText(accessWith(state));
    expect(text).toContain(label);
    expect(text).not.toContain("undefined");
    if (state !== "active") expect(text).not.toContain(". Действует.");
  });

  it("offers checking/help for unconfirmed temporary access", () => {
    const text = ownAccessText(accessWith("pending_verification"));
    expect(text).toContain(
      "Временный доступ по этому основанию не подтверждён",
    );
    expect(text).toContain("Повторите проверку позже");
    expect(text).toContain("Нужна помощь");
  });

  it("does not promise restoration through retry or fresh membership", () => {
    const text = ownAccessText(accessWith("suspended_source"));
    expect(text).toContain(
      "Обратитесь к владельцу для подтверждения нового периода",
    );
    expect(text).toContain(
      "Повторная проверка и вступление в группу не восстанавливают это основание",
    );
  });

  it("keeps independent active course and paid Guide grounds visible", () => {
    const pending = accessWith("pending_verification");
    const text = ownAccessText({
      ...pending,
      enrollments: [
        ...pending.enrollments,
        ...accessWith("suspended_source").enrollments,
        {
          ...enrollmentFixture,
          id: "62500000-0000-4000-8000-000000000006",
          origin: "course",
          state: "active",
          tier: {
            name: "Независимый курс",
            benefits: ["materials", "community"],
          },
        },
      ],
      grounds: [
        {
          source: "paid",
          capabilities: ["guide:synthetic-guide", "community"],
          startsAt: "2030-01-01T00:00:00.000Z",
          validUntil: null,
          active: true,
        },
      ],
      admission: { state: "ready", admissionRestriction: "none" },
    });
    expect(text).toContain(
      "Независимый курс\nПредоставлено за курс. Действует.",
    );
    expect(text).toContain("Действующее основание: покупка");
    expect(text).toContain("купленный продукт");
    expect(text).toContain("Право на сообщество действует");
  });
});
