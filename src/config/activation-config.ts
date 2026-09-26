import { assertServiceSecret } from "./service-secret.js";
export interface ActivationSource {
  readonly sourceRef: string;
  readonly chatId: string;
  readonly policy: "whole_group" | "confirmed_list";
  readonly confirmedIdentityRefs?: readonly string[];
}
export interface ActivationConfig {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly secret: string;
  readonly accountUrl: string;
  readonly sources: readonly ActivationSource[];
}
export function loadActivationConfig(
  env: NodeJS.ProcessEnv,
  canonicalChatId: string,
): ActivationConfig | undefined {
  if (
    env.TELEGRAM_ACTIVATION_ENABLED === undefined ||
    env.TELEGRAM_ACTIVATION_ENABLED === "false"
  )
    return;
  if (env.TELEGRAM_ACTIVATION_ENABLED !== "true")
    throw new Error("TELEGRAM_ACTIVATION_ENABLED must be true or false");
  const secret = env.PLATFORM_ACTIVATION_SECRET ?? "";
  assertServiceSecret(secret, "PLATFORM_ACTIVATION_SECRET");
  const endpoint = safeUrl(env.PLATFORM_ACTIVATION_URL);
  const accountUrl = safeUrl(env.PLATFORM_ACCOUNT_URL);
  let sources: unknown;
  try {
    sources = JSON.parse(env.TELEGRAM_ACTIVATION_SOURCES ?? "[]");
  } catch {
    throw new Error("Invalid TELEGRAM_ACTIVATION_SOURCES");
  }
  if (!Array.isArray(sources) || sources.length > 100)
    throw new Error("Invalid activation source registry");
  const registry: readonly unknown[] = sources;
  const refs = new Set<string>();
  const entries: ActivationSource[] = [];
  for (const source of registry) {
    const fields =
      source && typeof source === "object"
        ? new Map<string, unknown>(Object.entries(source))
        : undefined;
    const sourceRef = fields?.get("sourceRef");
    const chatId = fields?.get("chatId");
    const policy = fields?.get("policy");
    const confirmed = fields?.get("confirmedIdentityRefs");
    if (
      !fields ||
      typeof sourceRef !== "string" ||
      sourceRef.length < 1 ||
      sourceRef.length > 256 ||
      refs.has(sourceRef) ||
      typeof chatId !== "string" ||
      !/^-?[1-9][0-9]{0,15}$/.test(chatId) ||
      !Number.isSafeInteger(Number(chatId)) ||
      chatId === canonicalChatId ||
      (policy !== "whole_group" && policy !== "confirmed_list") ||
      [...fields.keys()].some(
        (k) =>
          !["sourceRef", "chatId", "policy", "confirmedIdentityRefs"].includes(
            k,
          ),
      )
    )
      throw new Error("Invalid activation source registry entry");
    if (policy === "whole_group") {
      if (confirmed !== undefined)
        throw new Error(
          "whole_group cannot silently ignore a confirmation list",
        );
      entries.push({ sourceRef, chatId, policy });
    } else {
      const confirmedIdentityRefs: readonly unknown[] | undefined =
        Array.isArray(confirmed) ? confirmed : undefined;
      if (
        !confirmedIdentityRefs?.every(
          (v): v is string =>
            typeof v === "string" && v.length >= 1 && v.length <= 256,
        )
      )
        throw new Error(
          "A confirmed_list source requires opaque confirmed identity references",
        );
      entries.push({ sourceRef, chatId, policy, confirmedIdentityRefs });
    }
    refs.add(sourceRef);
  }
  return { enabled: true, endpoint, secret, accountUrl, sources: entries };
}
function safeUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error("Activation integration requires valid Platform URLs");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Activation URLs require HTTPS or loopback HTTP without credentials, query or fragment",
    );
  return url.toString().replace(/\/$/, "");
}
