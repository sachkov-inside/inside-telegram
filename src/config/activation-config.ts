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
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret))
    throw new Error(
      "PLATFORM_ACTIVATION_SECRET requires a base64url credential of at least 32 characters",
    );
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
  const refs = new Set<string>();
  for (const source of sources) {
    if (
      !source ||
      typeof source !== "object" ||
      typeof source.sourceRef !== "string" ||
      source.sourceRef.length < 1 ||
      source.sourceRef.length > 256 ||
      refs.has(source.sourceRef) ||
      typeof source.chatId !== "string" ||
      !/^-?[1-9][0-9]{0,15}$/.test(source.chatId) ||
      !Number.isSafeInteger(Number(source.chatId)) ||
      source.chatId === canonicalChatId ||
      !["whole_group", "confirmed_list"].includes(source.policy) ||
      Object.keys(source).some(
        (k) =>
          !["sourceRef", "chatId", "policy", "confirmedIdentityRefs"].includes(
            k,
          ),
      )
    )
      throw new Error("Invalid activation source registry entry");
    if (
      source.policy === "confirmed_list" &&
      (!Array.isArray(source.confirmedIdentityRefs) ||
        source.confirmedIdentityRefs.some(
          (v: unknown) =>
            typeof v !== "string" || v.length < 1 || v.length > 256,
        ))
    )
      throw new Error(
        "A confirmed_list source requires opaque confirmed identity references",
      );
    if (
      source.policy === "whole_group" &&
      source.confirmedIdentityRefs !== undefined
    )
      throw new Error("whole_group cannot silently ignore a confirmation list");
    refs.add(source.sourceRef);
  }
  return { enabled: true, endpoint, secret, accountUrl, sources };
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
