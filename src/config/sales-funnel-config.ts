import {
  assertServiceEndpoint,
  assertServiceSecret,
} from "./service-secret.js";

/** The bot's explicit consent step; its wording is set with the funnel (ai-engineering#189). */
export interface MarketingConsentTexts {
  /** Sent after a marketing entry to a contact who has not consented yet. */
  readonly prompt: string;
  /** The button that records the consent. */
  readonly button: string;
  /** The reply once the consent is recorded. */
  readonly confirmation: string;
}

export interface SalesFunnelConfig {
  /** Platform's `inside.sales-funnel-events.v1` ingress; absent keeps events queued. */
  readonly delivery?: { readonly url: string; readonly secret: string };
  /** Absent means no consent prompt; `/resume` and `/stop` still report consent. */
  readonly consent?: MarketingConsentTexts;
}

export function loadSalesFunnelConfig(
  env: NodeJS.ProcessEnv,
): SalesFunnelConfig {
  const mode = env.PLATFORM_SALES_FUNNEL_DELIVERY_MODE ?? "disabled";
  if (mode !== "disabled" && mode !== "live")
    throw new Error(
      "PLATFORM_SALES_FUNNEL_DELIVERY_MODE must be disabled or live",
    );
  let delivery: SalesFunnelConfig["delivery"];
  if (mode === "live") {
    const url = required(env, "PLATFORM_SALES_FUNNEL_EVENTS_URL");
    assertServiceEndpoint(url, "PLATFORM_SALES_FUNNEL_EVENTS_URL");
    const secret = required(env, "PLATFORM_SALES_FUNNEL_EVENTS_SECRET");
    assertServiceSecret(secret, "PLATFORM_SALES_FUNNEL_EVENTS_SECRET");
    delivery = { url, secret };
  }
  const texts = [
    env.TELEGRAM_MARKETING_CONSENT_TEXT?.trim(),
    env.TELEGRAM_MARKETING_CONSENT_BUTTON?.trim(),
    env.TELEGRAM_MARKETING_CONSENT_CONFIRMATION?.trim(),
  ];
  const [prompt, button, confirmation] = texts;
  if (texts.some(Boolean) && !(prompt && button && confirmation))
    throw new Error(
      "TELEGRAM_MARKETING_CONSENT_TEXT, TELEGRAM_MARKETING_CONSENT_BUTTON and TELEGRAM_MARKETING_CONSENT_CONFIRMATION are set together",
    );
  // A Telegram text message holds at most 4096 characters.
  if ((prompt?.length ?? 0) > 4096 || (confirmation?.length ?? 0) > 4096)
    throw new Error("Marketing consent texts are longer than 4096 characters");
  return {
    ...(delivery ? { delivery } : {}),
    ...(prompt && button && confirmation
      ? { consent: { prompt, button, confirmation } }
      : {}),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
