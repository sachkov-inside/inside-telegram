import type { InvitationRedeemResponse } from "./activation-contract.js";
import type { TelegramButton } from "../outbound/telegram-messages.js";
import { accountPrompt } from "./activation-view.js";

/** One answer to an invitation link; `outcome` names it for reply deduplication. */
export interface InvitationAnswer {
  readonly outcome: string;
  readonly text: string;
  readonly buttons?: readonly TelegramButton[];
}

export const INVITATION_UNAVAILABLE: InvitationAnswer = {
  outcome: "unavailable",
  text: "Приглашение сейчас недоступно. Напишите автору.",
};
export const INVITATION_MALFORMED: InvitationAnswer = {
  outcome: "malformed",
  text: "Ссылка приглашения повреждена. Напишите автору, чтобы получить новую.",
};
export const INVITATION_DELAYED: InvitationAnswer = {
  outcome: "delayed",
  text: "Платформа временно не отвечает. Бот повторит попытку сам и пришлёт ответ.",
};

export function invitationNeedsAccount(accountUrl: string): InvitationAnswer {
  return {
    outcome: "needs_account",
    text: "Чтобы принять приглашение, войдите в Inside или создайте аккаунт и свяжите Telegram в кабинете. После связывания бот продолжит сам.",
    buttons: accountPrompt(accountUrl).buttons,
  };
}

/** The final answer to Platform's response; `needs_account` and `unavailable` errors are not final. */
export function invitationAnswer(
  response: InvitationRedeemResponse,
  now: Date,
): InvitationAnswer {
  if (!response.ok)
    return response.error.code === "identity_conflict"
      ? {
          outcome: "identity_conflict",
          text: "Связь Telegram с аккаунтом требует проверки. Напишите автору; аккаунты не объединяются автоматически.",
        }
      : response.error.code === "invalid_input"
        ? INVITATION_MALFORMED
        : INVITATION_UNAVAILABLE;
  const value = response.value;
  switch (value.state) {
    case "purchase_ready":
    case "already_redeemed":
    case "gift_granted":
      if (
        value.mode === "gift" &&
        value.enrollment.endsAt !== null &&
        Date.parse(value.enrollment.endsAt) <= now.getTime()
      )
        return {
          outcome: "gift_ended",
          text: `Подарок «${value.offerName}» по этому приглашению уже закончился. Напишите автору, если хотите продлить доступ.`,
        };
      return value.mode === "purchase"
        ? {
            outcome: value.state,
            text: `Приглашение на «${value.offerName}» принято. Оформить подписку можно на сайте: кнопка «Оплатить» ведёт на страницу оформления.`,
            buttons: [{ text: "Оплатить", url: value.checkoutUrl }],
          }
        : {
            outcome: value.state,
            text: `Подарок принят: «${value.offerName}» ${value.enrollment.endsAt === null ? "без срока окончания" : `до ${date(value.enrollment.endsAt)}`}. Чтобы вступить в сообщество Inside, нажмите кнопку или отправьте /community.`,
            buttons: [
              {
                text: "Вступить в сообщество",
                callbackData: "access:community",
              },
            ],
          };
    case "claimed_by_other":
      return {
        outcome: value.state,
        text: "Это приглашение уже открыл другой Telegram-аккаунт. Напишите автору, если ссылка предназначалась вам.",
      };
    case "expired":
      return {
        outcome: value.state,
        text: "Срок приглашения истёк. Напишите автору, чтобы получить новую ссылку.",
      };
    case "revoked":
      return {
        outcome: value.state,
        text: "Приглашение отозвано. Напишите автору, если оно нужно вам.",
      };
    case "needs_account":
    case "unavailable":
      return INVITATION_UNAVAILABLE;
  }
}

function date(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    dateStyle: "long",
  }).format(new Date(value));
}
