import type {
  OwnAccess,
  ActivationResult,
  ActivationResponse,
} from "./activation-contract.js";
import type { TelegramButton } from "../outbound/telegram-messages.js";
export function activationMenu(accountUrl: string): readonly TelegramButton[] {
  return [
    { text: "Открыть платформу", url: accountUrl },
    { text: "Мои доступы", callbackData: "access:own" },
    { text: "Вступить в сообщество", callbackData: "access:community" },
    { text: "Повторить проверку", callbackData: "access:retry" },
    { text: "Нужна помощь", callbackData: "access:help" },
  ];
}
export function accountPrompt(accountUrl: string): {
  text: string;
  buttons: readonly TelegramButton[];
} {
  return {
    text: "Для активации войдите в Inside или создайте аккаунт на платформе, затем свяжите Telegram в кабинете. После подтверждения мы продолжим проверку. Истёкший вход можно начать заново: право за курс не теряется.",
    buttons: [
      { text: "Создать аккаунт / войти через Telegram", url: accountUrl },
      { text: "У меня уже есть аккаунт", url: accountUrl },
      { text: "Я связал Telegram — проверить", callbackData: "access:retry" },
    ],
  };
}
export function activationMessage(
  result: ActivationResult<ActivationResponse>,
): string {
  if (!result.ok) {
    const messages = {
      policy_paused:
        "Новые активации по этой ссылке приостановлены. Уже выданные права сохраняются.",
      identity_conflict:
        "Связь Telegram требует проверки владельца. Мы не переносим и не объединяем аккаунты автоматически.",
      source_not_confirmed:
        "Покупка пока не подтверждена. Если вы больше не состоите в группе курса, обратитесь к владельцу для ручного подтверждения.",
      not_found: "Правило активации не найдено. Проверьте ссылку у владельца.",
      revision_conflict:
        "Условия проверки изменились. Повторите проверку по исходной ссылке.",
    };
    return result.error.code in messages
      ? messages[result.error.code as keyof typeof messages]
      : "Проверка пока недоступна. Повторите её позже; независимые покупки и права сохраняются.";
  }
  switch (result.value.state) {
    case "active":
    case "already_active":
      return "Назначение тарифа подтверждено. Откройте «Мои доступы», чтобы увидеть текущий состав, источник и срок.";
    case "pending_review":
    case "rejected":
      return "Автоматическая проверка не подтвердила покупку. Обратитесь к владельцу; это не отменяет уже выданные права.";
    default:
      return "Проверка продолжается. Если аккаунт ещё не связан, завершите вход и связывание на платформе.";
  }
}
export function ownAccessText(access: OwnAccess): string {
  const origin = {
    course: "Предоставлено за курс",
    tribute: "Оплачено через Tribute",
    manual: "Назначено владельцем",
    platform_payment: "Оформлено на Platform",
  };
  const states = {
    active: "Действует",
    scheduled: "Начнётся позже",
    expired: "Срок завершён",
    revoked: "Отозвано",
    pending_verification:
      "Ожидает подтверждения Tribute. Временный доступ по этому основанию не подтверждён. Повторите проверку позже или нажмите «Нужна помощь»",
    suspended_source:
      "Источник Tribute завершён, доступ по нему приостановлен. Обратитесь к владельцу для подтверждения нового периода. Повторная проверка и вступление в группу не восстанавливают это основание",
  };
  const rows = access.enrollments
    .slice(0, 8)
    .map(
      (e) =>
        `${e.tier.name}\n${origin[e.origin]}. ${states[e.state]}.\nСостав: ${e.tier.benefits.map(capability).join(", ")}.\nНачало: ${date(e.startsAt)}. ${term(e.endsAt)} — срок назначения. ${(e.benefitTerms ?? []).map((t) => `${capability(t.capability)}: ${t.revoked ? "отозвано" : term(t.endsAt)}`).join("; ")}.${e.renewal === "not_applicable" ? " Списаний Inside нет." : " Продление — по вашему платёжному соглашению."}`,
    );
  for (const ground of access.grounds.filter((g) => g.active).slice(0, 8))
    rows.push(
      `Действующее основание: ${ground.source === "paid" ? "покупка" : ground.source === "manual" ? "назначение владельца" : "прежний доступ"}. ${term(ground.validUntil)}. Состав: ${ground.capabilities.map(capability).join(", ")}.`,
    );
  if (!rows.length)
    rows.push(
      "Действующие права не найдены. Кабинет и история доступны; это не мешает обратиться за подтверждением прежней покупки.",
    );
  const admission =
    access.admission.admissionRestriction === "moderation" ||
    access.admission.admissionRestriction === "external_unknown" ||
    access.admission.state === "moderation_blocked"
      ? "Вступление ограничено. Обратитесь к владельцу; доступ к материалам не снимается этим запретом."
      : access.admission.state === "ready"
        ? "Право на сообщество действует. Запросите вступление отдельной кнопкой."
        : access.admission.state === "checking"
          ? "Состояние сообщества уточняется."
          : "Сейчас нет действующего права на сообщество.";
  const footer =
    "Срок каждого отдельного права, полный состав и история — в кабинете.";
  const heading = `Мои доступы\n\n${admission}\n\n`;
  const details = rows.join("\n\n");
  const room = 3900 - heading.length - footer.length - 3;
  return `${heading}${details.length > room ? details.slice(0, room - 1) + "…" : details}\n\n${footer}`;
}
function date(value: string): string {
  return (
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(value)) + " МСК"
  );
}
function term(value: string | null): string {
  return value === null ? "Без даты окончания" : `До ${date(value)}`;
}
function capability(value: string): string {
  return (
    (
      {
        materials: "материалы",
        community: "сообщество",
        support: "поддержка",
        reviews: "ревью",
      } as Record<string, string>
    )[value] ??
    (value.startsWith("guide:") ? "купленное руководство" : "состав в кабинете")
  );
}
