import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "../../src/app.module.js";
import { loadApplicationConfig } from "../../src/config/application-config.js";
import { SourceGroupProof } from "../../src/modules/subscription-activation/source-group-proof.js";
import {
  TELEGRAM_MESSAGES,
  type TelegramTextMessage,
} from "../../src/modules/outbound/telegram-messages.js";
import { TELEGRAM_CALLBACK_ANSWERS } from "../../src/modules/bot-sign-in/telegram-callback-answers.js";
import {
  TELEGRAM_COMMUNITY_CHAT,
  type TelegramCommunityChat,
} from "../../src/modules/community/community-ports.js";
import { TELEGRAM_MEMBERSHIP } from "../../src/modules/membership-evidence/telegram-membership.js";
import type { TelegramMembership } from "../../src/modules/membership-evidence/telegram-membership.js";

// Test-only process. All actual application boundaries and persistence remain intact.
const config = loadApplicationConfig(process.env);
for (const value of [
  config.databaseUrl,
  config.activation?.endpoint,
  config.communityDispatchUrl,
]) {
  if (!value || new URL(value).hostname !== "127.0.0.1")
    throw new Error(
      "Local proof requires explicit loopback authorities and database",
    );
}
if (
  config.botToken !== "1234:synthetic-course64" ||
  config.host !== "127.0.0.1" ||
  !config.activation
)
  throw new Error("Only synthetic course64 configuration is supported");
const sources = new Map<string, "member" | "left" | "unavailable">();
const members = new Map<string, "member" | "not_member" | "banned">();
const messages: (TelegramTextMessage & { id: string })[] = [];
const effects: { method: string; user?: string; invite?: string }[] = [];
const source: TelegramMembership = {
  getBotChatMember() {
    return Promise.resolve({
      kind: "observed",
      value: { status: "administrator" },
    });
  },
  getChatMember(_chat, user) {
    const status = sources.get(user) ?? "left";
    return Promise.resolve(
      status === "unavailable"
        ? { kind: "unavailable", diagnosticCode: "synthetic_unavailable" }
        : { kind: "observed", value: { status } },
    );
  },
};
const chat: TelegramCommunityChat = {
  readCapability() {
    return Promise.resolve({ kind: "ready" });
  },
  observeMember(_chat, user) {
    return Promise.resolve({
      kind: "observed",
      state: members.get(user) ?? "not_member",
    });
  },
  createJoinRequestLink() {
    const invite = `https://t.me/+synthetic-${randomUUID()}`;
    effects.push({ method: "create_invite", invite });
    return Promise.resolve({ kind: "created", inviteLink: invite });
  },
  approveJoinRequest(_chat, user) {
    effects.push({ method: "approve", user });
    members.set(user, "member");
    return Promise.resolve({ kind: "succeeded" });
  },
  declineJoinRequest(_chat, user) {
    effects.push({ method: "decline", user });
    return Promise.resolve({ kind: "succeeded" });
  },
  banMember(_chat, user) {
    effects.push({ method: "ban", user });
    members.set(user, "banned");
    return Promise.resolve({ kind: "succeeded" });
  },
  unbanMember(_chat, user) {
    effects.push({ method: "unban", user });
    members.set(user, "not_member");
    return Promise.resolve({ kind: "succeeded" });
  },
  revokeInviteLink(_chat, invite) {
    effects.push({ method: "revoke", invite });
    return Promise.resolve({ kind: "succeeded" });
  },
};
const module = await Test.createTestingModule({
  imports: [AppModule.register(config)],
})
  .overrideProvider(SourceGroupProof)
  .useValue(new SourceGroupProof(config.activation.sources, source))
  .overrideProvider(TELEGRAM_MEMBERSHIP)
  .useValue(source)
  .overrideProvider(TELEGRAM_COMMUNITY_CHAT)
  .useValue(chat)
  .overrideProvider(TELEGRAM_CALLBACK_ANSWERS)
  .useValue({
    answer: () => Promise.resolve(),
  })
  .overrideProvider(TELEGRAM_MESSAGES)
  .useValue({
    sendText(message: TelegramTextMessage) {
      const id = String(messages.length + 1);
      messages.push({ ...message, id });
      return Promise.resolve({ kind: "delivered", providerMessageId: id });
    },
    editText(message: { chatId: string; messageId: string; text: string }) {
      const existing = messages.find(
        (row) => row.chatId === message.chatId && row.id === message.messageId,
      );
      if (existing) Object.assign(existing, { text: message.text });
      return Promise.resolve({
        kind: "delivered",
        providerMessageId: message.messageId,
      });
    },
  })
  .compile();
const app = module.createNestApplication<NestFastifyApplication>(
  new FastifyAdapter(),
  { logger: false },
);
const fastify = app.getHttpAdapter().getInstance();
fastify.get("/proof/state", () =>
  Promise.resolve({
    messages,
    effects,
    members: Object.fromEntries(members),
  }),
);
fastify.post<{
  Body: {
    user: string;
    source?: "member" | "left" | "unavailable";
    community?: "member" | "not_member" | "banned";
  };
}>("/proof/source", (request, reply) => {
  const input = request.body;
  if (
    !/^64[0-9]{5}$/.test(input.user) ||
    (input.source !== undefined &&
      !["member", "left", "unavailable"].includes(input.source)) ||
    (input.community !== undefined &&
      !["member", "not_member", "banned"].includes(input.community))
  )
    return Promise.resolve(reply.code(400).send());
  if (input.source) sources.set(input.user, input.source);
  if (input.community) members.set(input.user, input.community);
  return Promise.resolve({ ok: true });
});
await app.listen(config.port, "127.0.0.1");
process.stdout.write(
  "Synthetic Telegram authority and actual course application listening on loopback\n",
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close();
  });
