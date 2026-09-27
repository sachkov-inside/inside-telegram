import "../config/load-environment.js";
import { Api } from "grammy";
import { GrammyMessagesAdapter } from "../adapters/telegram/grammy-messages.adapter.js";
import { loadApplicationConfig } from "../config/application-config.js";
import { announceActivation } from "../modules/subscription-activation/activation-announcement.js";

const [mode, sourceRef, code, ...rest] = process.argv.slice(2);
if (
  !["--preview", "--send"].includes(mode ?? "") ||
  sourceRef === undefined ||
  code === undefined ||
  rest.length > 0
) {
  process.stderr.write(
    "Use --preview or --send <sourceRef> <code> with the application configuration.\n",
  );
  process.exitCode = 1;
} else {
  try {
    const config = loadApplicationConfig(process.env);
    const token = config.botToken;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
    const api = new Api(token, { timeoutSeconds: 10 });
    const messages = new GrammyMessagesAdapter(token, api);
    const result = await announceActivation(
      {
        activation: config.activation,
        sourceRef,
        code,
        send: mode === "--send",
      },
      {
        botUsername: async () => (await api.getMe()).username,
        sendText: (message) => messages.sendText(message),
      },
    );
    // The chat id stays in the protected configuration; the output names only the source.
    process.stdout.write(JSON.stringify({ ...result, sourceRef }) + "\n");
    if (result.status !== "ready" && result.status !== "sent")
      process.exitCode = 2;
  } catch {
    process.stderr.write(
      "Activation announcement stopped; no token or chat id printed.\n",
    );
    process.exitCode = 1;
  }
}
