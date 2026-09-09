# Telegram: community и Notifications v1

Provider contract [#54](https://github.com/sachkov-inside/inside-telegram/issues/54).
Platform #403 принята; Workspace #152/Platform #434 расширяют notification часть по решению
владельца 2026-09-08: RabbitMQ и первые сценарии подписки и новых материалов. Здесь нет application
runtime, миграций БД, credentials или настоящих sends. Exact sources и candidate/merged статус
записаны в provenance каждого [bundle](../contracts/notifications-v1/README.md).

## Два независимых контракта

- [Community corpus](../contracts/billing-v1/README.md): immutable копия Platform
  `1fdcf11017e16690a95aa12a830492d1aaf0b6cd`. Entitlement, binding/revisions и community dispatch
  остаются v1. Old notification fixtures сохранены как история, а не второй sender.
- [Notifications corpus](../contracts/notifications-v1/README.md): новая общая notification
  delivery/result/authorization schema из Platform #434. Telegram получает адресное готовое
  задание, не сам определяет аудиторию, коммерческие правила или пользовательский opt-in.

`inside.billing-notification.v1` notification.send/status и notice.send в старом dispatch не
используются для новой реализации. Новый путь включается без dual-send того же бизнес-ключа.
Остальные marketing/identity/evidence interfaces не расширяются неизвестными полями.

## Community admission и observation

Telegram provider сохраняет service-authenticated command в durable inbox до HTTP acknowledgement.
Fingerprint, operation/revision conflicts, finite/lifetime/denied, binding/linkRevision и ошибки
нормативны в [community protocol](../contracts/billing-v1/protocol.md). Link нельзя создать из grant.
Telegram проверяет known verified identity; Platform остаётся authority совокупности прав Account.
Raw Telegram user/chat ID разрешается только из собственного verified mapping и configuration.

В собственной БД: operation receipts, latest desired state, исторические bindings, observed
membership, effect/attempt ledger и join update receipt. Binding ownership не меняется через
entitlement command. Меньшая revision не откатывает desired state. Одинаковая revision/different
desired state — конфликт. Unlink cleanup использует historical binding того же Account и свежую
Platform проверку отсутствия transfer; спорная identity остаётся оператору.

| Действие | Bot API и условия |
|---|---|
| Проверить состояние | `getChatMember` для known identity; authoritative classification member/administrator/creator и restricted.is_member, left/kicked; unknown/error не считается отсутствием |
| Открыть admission после нового allow | При подтверждённом ban: fresh `community.ensure_admission`, durable started, `unbanChatMember(only_if_banned=true)`; unban не означает joined |
| Создать контролируемую ссылку | `createChatInviteLink(creates_join_request=true, expire_date=...)`, без member_limit; link привязан в собственной БД к intended identity и desired revision |
| Принять вступление | Проверить durable `chat_join_request`, intended verified identity, canonical chat и актуальное право; fresh `community.approve_join`, started, `approveChatJoinRequest`, затем observation |
| Отклонить чужой/просроченный запрос | `declineChatJoinRequest`; это не выдаёт право и не выбирает получателя по username или тому, кто принёс ссылку |
| Прекратить право | Fresh `community.ensure_absence`, started, `banChatMember`; `revokeChatInviteLink` для известных bot-owned links; повторная observation и закрытое admission |

Все внешние mutations сериализуются по identity/desired state и конкретному effectRef. Unban,
create invite, approve, ban и revoke link — отдельные effects, каждый со свежей проверкой перед
началом. Decline чужого join request разрешён локальной проверкой intended identity/canonical chat,
не требует выдать чужому Account grant permit. Ни один такой вызов не выдаёт ContentAccess.

Ссылка действует не больше десяти минут и не позже finite validUntil; lifetime не становится
фиктивной далёкой датой, ссылка всё равно короткая. Успешная ссылка хранится до передачи участнику.
Invite path выдаётся только intended contact в его подтверждённом интерактивном запросе вступления;
массовая/автоматическая notification рассылка ссылок не является частью #55. Передача ссылки
не означает applied и не заменяет проверку join request. Другие admin-created invite paths и
права администраторов требуют acceptance конфигурации чата: bot не может обещать запрет обходного
ручного одобрения владельцем. Canonical chat не меняется в этой задаче.

Потеря ответа createChatInviteLink не позволяет узнать URL через getChatMember. Such effect
остаётся unknown без слепого повторного create; ссылка имеет bounded expiry, дальнейшее recovery
после её expiry требует новой fresh проверки. Неизвестный invite никогда не становится proof of
membership. Для ban/unban/approve сначала getChatMember и known join evidence; retry допустим
только если наблюдение не подтверждает эффект, он ещё нужен и preflight разрешает следующую attempt.
Потеря ответа revoke известной ссылки требует повторной проверки desired state перед безопасным
повтором revoke той же exact URL; новый link не создаётся как compensation.

Для каждого нового verified join update — отдельный effectRef. Replay того же update использует
прежний effect. Участник может выйти и запросить вход снова при той же entitlementRevision:
это новый join effect, не новое право и не duplicate старого approve. `applied` allow означает
наблюдаемое member; после выхода может стать waiting_for_join. `applied` denied означает
подтверждённое отсутствие и закрытое admission, не только HTTP 200/ban accepted.

Finite expiry отслеживается локальным worker даже при недоступном producer. Новое approve после
expiry запрещено. Для cleanup требуется fresh Platform aggregate-right check: старый истёкший
grant не разрешает удалить identity с новым или lifetime основанием. Пока Platform недоступна,
provider не выдаёт новое право и не угадывает отсутствие более нового; показывает overdue/unknown,
повторяет сверку. Истёкший desired allow не считается бесконечным разрешением и сам не продлевается.
Known desired states проверяются минимум раз в минуту; задержка свыше пяти минут видна оператору.
Provider outage не скрывается статусом applied и не отбирает paid/manual доступ к материалам.

Bot capability preflight для runtime #55: bot administrator в canonical chat, `can_invite_users`
и `can_restrict_members`; subscribed updates включают `chat_member`, `my_chat_member`,
`chat_join_request`. `getChatMember` другого пользователя гарантируется API для admin bot.
Фактические права/чат не проверены этой документацией; их изменение требует concrete owner GO.

Источники: [invite](https://core.telegram.org/bots/api#createchatinvitelink),
[approve](https://core.telegram.org/bots/api#approvechatjoinrequest),
[unban](https://core.telegram.org/bots/api#unbanchatmember),
[ban](https://core.telegram.org/bots/api#banchatmember),
[observation](https://core.telegram.org/bots/api#getchatmember).

## Общая доставка уведомлений

Telegram #56 реализует AMQP consumer двух notification queues по
[protocol.md](../contracts/notifications-v1/protocol.md). Principal читает только Telegram lanes
и пишет Telegram results. Emails/raw account data/billing events не становятся допустимым Telegram
payload. Channel/category/routing mismatch и unknown version помещаются в durable quarantine.

Provider inbox и recoverable job атомарны до ack. Затем worker проверяет exact linked identity,
contactability, command deadline и Platform Notifications permit. Material purpose не превращается
в subscription для обхода opt-out. `/start`/marketing preference не разрешает новую категорию
самостоятельно. Отсутствующая связь — suppressed/failed по контракту, не поиск другого recipient.

Notification Delivery ledger отделён от marketing definitions и community desired state.
Но все три исходящих пути одного бота используют существующие shared transport slots и общий
bot/chat rate budget. Служебные и material lanes имеют выделенное обслуживание без starvation;
`429 retry_after` действует на общий bot scope. No duplicate quota на новый worker/категорию.

`sendMessage` выполняется без parse_mode по schema-valid plain text. До вызова сохраняются
attempt/started/permit под Delivery lock; status становится unknown. Успех сохраняет receipt,
sent и result outbox атомарно; потерянный ответ остаётся unknown. Replay AMQP command/новый permit
не снимает started, даже если result ещё не дошёл до Platform. Поздний ответ той же attempt
уточняет статус, не начинает новую отправку. Exact retry и revision rules принадлежат protocol.

Сбой Notifications не изменяет оплату, доступ или community desired state. Сбой result relay
не повторяет send; результат доходит из outbox после восстановления. Marketing `delivery.resolve`
не является recovery authority новой Notification. Операторское разрешение повторного unknown
имеет отдельный audit/source ID; автоматического v1 wire bypass нет.

## Проверка и поставка

`test/unit/subscription-contract-artifacts.test.ts` исполняет valid/invalid schema examples,
manifest integrity и scenario references двух bundles. Это форма и целостность, не исполняемый
симулятор lifecycle. #55/#56 требуют real PostgreSQL persistence/concurrency и #56 real RabbitMQ
ACL/confirm/ack/crash/fairness proof. #438 проверяет два источника и канала через обе стороны.

Community runtime поставлен: `test/integration/community-entitlements.integration.test.ts` исполняет
vendored sequence corpus этой задачи на реальном PostgreSQL, включая same-revision rejoin, old
expired grant при новом lifetime, конкурентные workers и потерянные ответы. Реализация описана в
[community entitlements runtime](../integrations/community-entitlements-v1.md).
Community runtime обязан исполнить весь vendored sequence corpus, включая expired permit before
started, same-revision rejoin и old expired grant при новом lifetime. Дополнительно проверить
unknown create invite с bounded expiry, shared chat bypass конфигурацию и потерю admin rights.
Никакие synthetics не объявляются credentialed proof; реальные сообщения/выдача прав/deploy отдельно.
