import type { AccessAction } from "../subscription-activation/subscription-activation.js";
import type {
  VerifiedPrivateContactability,
  VerifiedPrivateStart,
} from "../../shared/telegram-contact.js";
import type { VerifiedSignInDecision } from "../bot-sign-in/bot-sign-in.js";
import type {
  AuthorInput,
  TemplateIntake,
} from "../communications/author-input.js";
import type { CommunityJoinRequest } from "../community/community-provider.js";
import type { DurableMembershipEnvelope } from "../membership-evidence/membership-evidence-provider.js";

/** Everything the application does with one Telegram update; the processor handles each kind. */
export type TelegramUpdateCommand =
  | {
      readonly kind: "access-action";
      readonly value: VerifiedPrivateStart;
      readonly action: AccessAction;
      readonly callbackQueryId?: string;
    }
  | {
      readonly kind: "sign-in-decision";
      readonly value: VerifiedSignInDecision;
      readonly callbackQueryId: string;
    }
  | {
      readonly kind: "marketing_preference";
      readonly value: {
        readonly contact: VerifiedPrivateStart;
        readonly enabled: boolean;
      };
    }
  | {
      readonly kind: "contactability";
      readonly value: VerifiedPrivateContactability;
    }
  | { readonly kind: "ignored" }
  | { readonly kind: "membership"; readonly value: DurableMembershipEnvelope }
  | { readonly kind: "join-request"; readonly value: CommunityJoinRequest }
  | {
      readonly kind: "community-request";
      readonly value: VerifiedPrivateStart;
    }
  | {
      readonly kind: "start";
      readonly value: {
        readonly contact: VerifiedPrivateStart;
        readonly signInToken?:
          | { readonly digest: string; readonly kind: "digest" }
          | { readonly kind: "malformed" };
        readonly marketingSource?: string;
        readonly activationCode?: string | null;
        readonly linkToken?:
          | { readonly digest: string; readonly kind: "digest" }
          | { readonly kind: "malformed" };
      };
    }
  | {
      /** A private message or `author:` callback; the intake receives it if admin declines. */
      readonly kind: "author-input";
      readonly value: AuthorInput;
      readonly intake?: TemplateIntake;
    }
  | { readonly kind: "template-intake"; readonly value: TemplateIntake };

/** Reads raw Telegram updates; the transport adapter implements it. */
export interface TelegramUpdateTranslator {
  /** Removes secrets from an update before it is stored in the inbox. */
  prepareForInbox(payload: unknown): unknown;
  translate(
    botIdentity: string,
    updateId: string,
    payload: unknown,
    observedAt: Date,
  ): TelegramUpdateCommand;
}

export const TELEGRAM_UPDATE_TRANSLATOR = Symbol("TELEGRAM_UPDATE_TRANSLATOR");
