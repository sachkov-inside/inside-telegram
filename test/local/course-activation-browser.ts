import { AxeBuilder } from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 30_000 });

// Separate local acceptance command: no production address, token, or Account fixture is accepted.
const web = "http://127.0.0.1:3600";
const provider = "http://127.0.0.1:3606";
const identity = "https://identity.inside.localhost:3631";
const user = Number(process.env.COURSE_PROOF_USER);
if (!/^64[0-9]{5}$/.test(String(user)))
  throw new Error("Use a fresh synthetic COURSE_PROOF_USER (64xxxxx)");
const output = process.env.COURSE_PROOF_OUTPUT;
if (!output) throw new Error("COURSE_PROOF_OUTPUT is required outside Git");
const source = process.env.COURSE_PROOF_SOURCE === "left" ? "left" : "member";
const mobile = process.env.COURSE_PROOF_MOBILE === "true";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: mobile
    ? { width: 390, height: 844 }
    : { width: 1440, height: 1024 },
});
const page = await context.newPage();
let updateId = Date.now() % 1_000_000_000;
const from = { id: user, is_bot: false, first_name: "Synthetic" };
const chat = { id: user, type: "private" };
const transcript: string[] = [];
async function webhook(value: Record<string, unknown>) {
  const response = await context.request.post(`${provider}/webhooks/telegram`, {
    headers: {
      "x-telegram-bot-api-secret-token": "synthetic-course64-webhook",
    },
    data: { update_id: ++updateId, ...value },
  });
  expect(response.status()).toBe(202);
}
async function send(text: string) {
  await webhook({
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      from,
      chat,
      text,
    },
  });
}
interface Message {
  chatId: string;
  id: string;
  text: string;
  buttons?: { url?: string; callbackData?: string }[];
}
async function messages(): Promise<Message[]> {
  const state = await (
    await context.request.get(`${provider}/proof/state`)
  ).json();
  return (state.messages as Message[]).filter((m) => m.chatId === String(user));
}
async function enrollments() {
  const response = await page.request.get(
    `${web}/api/account/billing/enrollments`,
  );
  expect(response.status()).toBe(200);
  const state = await response.json();
  expect(state.ok).toBe(true);
  return state.value.items as {
    id: string;
    origin: string;
    startsAt: string;
    endsAt: string | null;
    revision: number;
  }[];
}
try {
  await context.request.post(`${provider}/proof/source`, {
    data: { user: String(user), source },
  });
  await send("/start a_course64");
  await expect
    .poll(
      async () =>
        (await messages()).some((m) =>
          m.buttons?.some((b) => b.url === `${web}/account`),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  const prompt = (await messages()).find((m) =>
    m.buttons?.some((b) => b.url === `${web}/account`),
  )!;
  await page.goto(prompt.buttons!.find((b) => b.url)!.url!);
  const signIn = page
    .locator("#content")
    .getByRole("button", { name: "Войти", exact: true });
  await signIn.focus();
  await expect(signIn).toBeFocused();
  await signIn.press("Enter");
  const telegramSignIn = page.getByRole("button", { name: /Telegram/u });
  await telegramSignIn.focus();
  await expect(telegramSignIn).toBeFocused();
  await telegramSignIn.press("Enter");
  transcript.push(
    "PASS browser sign-in controls support keyboard focus and activation",
  );
  await expect(page.locator("#bot")).toBeVisible();
  const token = new URL(
    (await page.locator("#bot").getAttribute("href"))!,
  ).searchParams.get("start");
  const state = await (
    await page.request.get(`${identity}/api/inside-telegram/status`)
  ).json();
  expect(state.status).toBe("pending");
  await page.screenshot({
    path: resolve(output, "browser-login.png"),
    fullPage: true,
  });
  await send(`/start ${String(token)}`);
  await expect
    .poll(
      async () =>
        (await messages()).some((m) =>
          m.buttons?.some(
            (b) =>
              b.callbackData === `signin:approve:${String(state.requestRef)}`,
          ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  const approval = (await messages()).find((m) =>
    m.buttons?.some(
      (b) => b.callbackData === `signin:approve:${String(state.requestRef)}`,
    ),
  )!;
  await webhook({
    callback_query: {
      id: `proof-${String(updateId)}`,
      from,
      chat_instance: "synthetic",
      message: {
        message_id: Number(approval.id),
        date: Math.floor(Date.now() / 1000),
        chat,
      },
      data: `signin:approve:${String(state.requestRef)}`,
    },
  });
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`${web}/auth/status`)).json()).state,
      { timeout: 60_000 },
    )
    .toBe("authenticated");
  await expect
    .poll(
      async () =>
        (await messages()).some((m) =>
          m.text.includes(
            source === "member"
              ? "Назначение тарифа подтверждено"
              : "Автоматическая проверка не подтвердила",
          ),
        ),
      { timeout: 90_000 },
    )
    .toBe(true);
  const before = await enrollments();
  expect(before.filter((e) => e.origin === "course")).toHaveLength(
    source === "member" ? 1 : 0,
  );
  transcript.push(
    source === "member"
      ? "PASS real browser linking and one Platform course Enrollment"
      : "PASS forwarded link to nonmember gives no Enrollment",
  );
  await send("/access");
  await expect
    .poll(
      async () =>
        (await messages()).some((m) => m.text.includes("Мои доступы")),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.goto(`${web}/account/subscription`);
  if (source === "member")
    await expect(
      page.getByRole("heading", {
        name: "Курс 64 · локальная практика",
        exact: true,
      }),
    ).toBeVisible();
  await expect(
    page.getByText("Загружаем подписку…", { exact: true }),
  ).toBeHidden({ timeout: 30_000 });
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    audit.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    ),
  ).toEqual([]);
  transcript.push("PASS cabinet accessibility and viewport checks");
  await page.screenshot({
    path: resolve(output, "cabinet.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  if (source === "member") {
    await page.goto(`${web}/materials/developer-pipeline-bez-poteri-konteksta`);
    await expect(
      page.locator("[data-reading-action-state]:visible"),
    ).toHaveAttribute("data-reading-action-state", "ready");
    await expect(
      page
        .locator("[data-reading-action-state]:visible")
        .getByRole("button", { name: "Изучено", exact: true }),
    ).toBeEnabled();
    await expect(
      page
        .getByText("Закрытое содержимое для участников.", { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    transcript.push("PASS protected guide material body is readable");
    await page.screenshot({
      path: resolve(output, "reader.png"),
      fullPage: true,
    });
    let invite: string | undefined;
    await expect
      .poll(
        async () => {
          await send("/community");
          invite = (await messages())
            .map((m) => /https:\/\/t\.me\/\+\S+/u.exec(m.text)?.[0])
            .find(Boolean);
          return Boolean(invite);
        },
        { timeout: 150_000, intervals: [5000] },
      )
      .toBe(true);
    await webhook({
      chat_join_request: {
        chat: { id: -1000000000000, type: "supergroup" },
        from,
        user_chat_id: user,
        date: Math.floor(Date.now() / 1000),
        invite_link: {
          invite_link: invite,
          creator: { id: 1234, is_bot: true, first_name: "SyntheticBot" },
          creates_join_request: true,
          is_primary: false,
          is_revoked: false,
        },
      },
    });
    await expect
      .poll(
        async () =>
          (await (await context.request.get(`${provider}/proof/state`)).json())
            .members[String(user)],
        { timeout: 30_000 },
      )
      .toBe("member");
    transcript.push(
      "PASS intended join via actual Platform v2 dispatch permit",
    );
    await context.request.post(`${provider}/proof/source`, {
      data: { user: String(user), source: "left" },
    });
    await send("/start a_course64");
    await expect
      .poll(
        async () =>
          (await messages()).filter((m) =>
            m.text.includes("Назначение тарифа подтверждено"),
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    expect(await enrollments()).toEqual(before);
    transcript.push(
      "PASS repeated start and source exit preserve Enrollment identity, revision and dates",
    );
    const unbans = async () =>
      (
        await (await context.request.get(`${provider}/proof/state`)).json()
      ).effects.filter(
        (effect: { method: string; user?: string }) =>
          effect.method === "unban" && effect.user === String(user),
      ).length;
    const beforeUnbans = await unbans();
    await context.request.post(`${provider}/proof/source`, {
      data: { user: String(user), community: "banned" },
    });
    await webhook({
      chat_member: {
        chat: { id: -1000000000000, type: "supergroup" },
        from: { id: 6400099, is_bot: false, first_name: "Synthetic moderator" },
        date: Math.floor(Date.now() / 1000),
        old_chat_member: { user: from, status: "member" },
        new_chat_member: { user: from, status: "kicked", until_date: 0 },
      },
    });
    await expect
      .poll(
        async () => {
          await send("/community");
          return (await messages()).some((message) =>
            message.text.includes("Вступление ограничено"),
          );
        },
        { timeout: 150_000, intervals: [5000] },
      )
      .toBe(true);
    await send("/start a_course64");
    await send("/access");
    await expect
      .poll(
        async () =>
          (await messages()).some(
            (message) =>
              message.text.startsWith("Мои доступы") &&
              message.text.includes("Вступление ограничено"),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await page.goto(`${web}/account/subscription`);
    await expect(
      page.getByText(/Вступление в сообщество ограничено модерацией/u),
    ).toBeVisible();
    await page.screenshot({
      path: resolve(output, "moderation.png"),
      fullPage: true,
    });
    await page.goto(`${web}/materials/developer-pipeline-bez-poteri-konteksta`);
    await expect(
      page
        .getByText("Закрытое содержимое для участников.", { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    expect(await enrollments()).toEqual(before);
    expect(await unbans()).toBe(beforeUnbans);
    transcript.push(
      "PASS moderation reaches bot and cabinet; repeated start cannot unban; course content remains readable",
    );
  }
  if (source === "left") {
    await page.goto(`${web}/materials/developer-pipeline-bez-poteri-konteksta`);
    await expect(
      page.locator("[data-reading-action-state]:visible"),
    ).toHaveAttribute("data-reading-action-state", "ready");
    await expect(
      page
        .getByText("Закрытое содержимое для участников.", { exact: true })
        .filter({ visible: true }),
    ).toBeHidden();
    await expect(
      page
        .locator("[data-reading-action-state]:visible")
        .getByRole("button", { name: "Изучено", exact: true }),
    ).toBeDisabled();
    transcript.push("PASS nonmember cannot read protected course material");
  }
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(
      {
        source,
        mobile,
        checks: transcript,
        botMessages: (await messages()).map((m) => m.text),
      },
      null,
      2,
    ),
  );
  process.stdout.write(transcript.join("\n") + "\n");
} finally {
  await browser.close();
}
