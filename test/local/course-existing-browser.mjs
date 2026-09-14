import process from "node:process";
import { URL } from "node:url";
import console from "node:console";
import { chromium, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const origin = "http://127.0.0.1:3600";
const user = Number(process.env.COURSE_PROOF_USER);
const output = process.env.COURSE_PROOF_OUTPUT;
if (!/^64[0-9]{5}$/.test(String(user)) || !output)
  throw new Error(
    "Fresh synthetic COURSE_PROOF_USER and COURSE_PROOF_OUTPUT required",
  );
const email = `course64-${String(user)}@example.test`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
let update = Date.now() % 1_000_000_000;
async function send(text) {
  const response = await context.request.post(
    "http://127.0.0.1:3606/webhooks/telegram",
    {
      headers: {
        "x-telegram-bot-api-secret-token": "synthetic-course64-webhook",
      },
      data: {
        update_id: ++update,
        message: {
          message_id: update,
          date: Math.floor(Date.now() / 1000),
          from: { id: user, is_bot: false, first_name: "Synthetic" },
          chat: { id: user, type: "private" },
          text,
        },
      },
    },
  );
  expect(response.status()).toBe(202);
}
async function emailLogin() {
  await page.goto("http://127.0.0.1:3600/account");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('button[type="submit"]').click();
  let code = "";
  await expect
    .poll(
      async () => {
        const state = await (
          await context.request.get("http://127.0.0.1:3625/api/v1/messages")
        ).json();
        const msg = state.messages.find((m) =>
          m.To.some((r) => r.Address === email),
        );
        code = /\b(\d{6})\b/.exec(msg?.Snippet ?? "")?.[1] ?? "";
        return code.length;
      },
      { timeout: 20000 },
    )
    .toBe(6);
  const inputs = page.locator(
    'input[inputmode="numeric"],input[autocomplete="one-time-code"]',
  );
  await expect(inputs.first()).toBeVisible();
  if ((await inputs.count()) === 1) await inputs.fill(code);
  else for (let i = 0; i < 6; i++) await inputs.nth(i).fill(code[i]);
  if (await page.locator('button[type="submit"]').isVisible())
    await page.locator('button[type="submit"]').click();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get("http://127.0.0.1:3600/auth/status")
          ).json()
        ).state,
      { timeout: 30000 },
    )
    .toBe("authenticated");
}
async function purchase() {
  await page.goto(origin + "/account");
  const contact = await (
    await page.request.get(origin + "/api/account/billing/contact")
  ).json();
  if (!contact.contact) {
    const challenge = await (
      await page.request.post(origin + "/api/account/billing/contact/start", {
        headers: { origin },
        form: { operationId: randomUUID(), expectedRevision: "0", email },
      })
    ).json();
    expect(challenge.ok).toBe(true);
    let code = "";
    await expect
      .poll(
        async () => {
          const state = await (
            await context.request.get("http://127.0.0.1:3625/api/v1/messages")
          ).json();
          const msg = state.messages.find(
            (m) =>
              m.To.some((r) => r.Address === email) &&
              !m.From.Address.includes("sign"),
          );
          code = /\b(\d{6})\b/.exec(msg?.Snippet ?? "")?.[1] ?? "";
          return code.length;
        },
        { timeout: 20000 },
      )
      .toBe(6);
    const result = await (
      await page.request.post(origin + "/api/account/billing/contact/confirm", {
        headers: { origin },
        form: {
          operationId: randomUUID(),
          challengeRef: challenge.challengeRef,
          code,
        },
      })
    ).json();
    expect(result.ok).toBe(true);
  }
  await page.goto(origin + "/guides/platform-inside/buy");
  await page.waitForTimeout(700);
  await page.keyboard.press("Escape");
  await page.locator('input[name="one-time-consent-terms"]').check();
  const dismiss = page.getByRole("button", { name: "Позже", exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.getByRole("button", { name: /Купить за/ }).click();
  await page.waitForURL("http://127.0.0.1:38090/**", { timeout: 30000 });

  await page
    .getByRole("button", { name: "Оплата прошла", exact: true })
    .click();
  await page.waitForTimeout(1500);
}
async function activateExisting() {
  await page.goto(origin + "/account");
  await expect
    .poll(
      async () => {
        const value = await (
          await page.request.get(origin + "/api/account/billing")
        ).json();
        return JSON.stringify(value).includes('"source":"paid"');
      },
      { timeout: 90000 },
    )
    .toBe(true);
  await page.goto(
    origin + "/materials/developer-pipeline-bez-poteri-konteksta",
  );
  const dismiss = page.getByRole("button", {
    name: "Закрыть подключение Telegram",
  });
  await page.addLocatorHandler(dismiss, async () => {
    await dismiss.click();
  });
  const action = page.locator("[data-reading-action-state]:visible");
  await expect(action).toHaveAttribute("data-reading-action-state", "ready");
  const button = action.getByRole("button", { name: "Изучено", exact: true });
  if ((await button.getAttribute("aria-pressed")) !== "true")
    await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  const before = await (
    await page.request.get(origin + "/api/account/billing")
  ).json();
  const profile = await page.request.post(origin + "/api/account/profile", {
    headers: { origin },
    form: { displayName: "Synthetic existing course buyer", bio: "" },
  });
  expect(profile.ok()).toBe(true);
  const beforeProfile = await (
    await page.request.get(origin + "/api/account/profile")
  ).json();
  await context.request.post("http://127.0.0.1:3606/proof/source", {
    data: { user: String(user), source: "member" },
  });
  await send("/start a_course64");
  const begin = await (
    await page.request.post(origin + "/api/account/telegram-link/begin", {
      headers: { origin },
      form: {},
    })
  ).json();
  expect(begin.kind).toBe("received");
  await send(
    "/start " + new URL(begin.state.deepLink).searchParams.get("start"),
  );
  await expect
    .poll(
      async () => {
        const r = await (
          await page.request.post(
            origin + "/api/account/telegram-link/confirm",
            { headers: { origin }, form: { linkRef: begin.state.linkRef } },
          )
        ).json();
        return r.state?.status;
      },
      { timeout: 30000 },
    )
    .toBe("linked");
  await send("/start a_course64");
  await expect
    .poll(
      async () => {
        const r = await (
          await page.request.get(origin + "/api/account/billing/enrollments")
        ).json();
        return r.value?.items?.filter((e) => e.origin === "course").length;
      },
      { timeout: 90000 },
    )
    .toBe(1);
  const after = await (
    await page.request.get(origin + "/api/account/billing")
  ).json();
  const paidSnapshot = (value) =>
    JSON.parse(
      JSON.stringify(value, (key, entry) =>
        key === "grounds" ? entry.filter((g) => g.source === "paid") : entry,
      ),
    );
  expect(paidSnapshot(after)).toEqual(paidSnapshot(before));
  const afterProfile = await (
    await page.request.get(origin + "/api/account/profile")
  ).json();
  expect(afterProfile).toEqual(beforeProfile);
  await page.reload();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: resolve(output, "telegram64-existing-reader-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.screenshot({
    path: resolve(output, "telegram64-existing-reader-desktop.png"),
    fullPage: true,
  });

  console.log(
    "PASS existing email Account retained actual paid purchase, profile and persisted reading progress after course activation",
  );
}
try {
  await emailLogin();
  await purchase();
  await activateExisting();
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(
      {
        checks: [
          "PASS real email Account, local bank payment, saved paid rights/profile/progress after browser-owned Telegram linking and course Enrollment",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
