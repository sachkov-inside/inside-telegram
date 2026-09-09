# Community entitlements: runtime провайдера

Реализация Telegram-стороны `inside.community-entitlement.v1` по
[protocol.md](../contracts/billing-v1/protocol.md) и
[provider specification](../specifications/community-and-notifications-v1.md).
Нормативный источник — vendored corpus; здесь описано только то, что делает приложение.

## Поверхность

| Направление | Endpoint приложения | Контракт |
|---|---|---|
| Platform → Telegram | `POST /integrations/platform/v1/community-entitlements` | `inside.community-entitlement.v1` |
| Telegram → Platform | `PLATFORM_COMMUNITY_DISPATCH_URL` | `inside.billing-dispatch.v1` |

Target path протокола `/internal/community-entitlements` не является путём приложения: Telegram
владеет своим namespace и держит один endpoint в общем `integrations/platform/v1` префиксе.
Platform настраивает у себя этот URL; production allowlist пропускает его в
[telegram.caddy.example](../../infra/production/telegram.caddy.example).

Endpoint fails closed. Без `PLATFORM_COMMUNITY_INTEGRATION_SECRET` любой запрос получает `401`.
Secret этого направления обязан отличаться от linking, sign-in и dispatch secrets.
Тело больше 16 KiB, чужая версия контракта и schema-invalid payload не создают никакого эффекта.
Коды: malformed 400, unauthorized 401, unsupported_contract 422, not_found 404,
operation_conflict/revision_conflict 409. Без parseable `operationId` ответ не выдумывает
correlation. `entitlement.status` возвращает durable result исходной операции.

## Что хранится

- `community_operations` — durable inbox: команда, её fingerprint и последний result. Fingerprint —
  SHA-256 канонического JSON схема-валидной команды; UUID приводятся к нижнему регистру на границе
  до сохранения и до hash.
- `community_desired_states` — одно желаемое состояние на Account: монотонная `entitlement_revision`,
  binding, access, наблюдаемое членство, срок и известная bot-owned ссылка.
- `community_bindings` — историческая связь Account ↔ TelegramIdentity, включая проверенный
  Telegram user id. Это единственный источник raw идентификаторов вместе с configuration.
- `community_effects` и `community_effect_attempts` — ledger эффектов и внешних попыток.

Меньшая revision не меняет желаемое состояние и записывается как `superseded`. Та же revision с
другим состоянием — `revision_conflict`; идентичная не создаёт вторую запись. Тот же `operationId`
с другим payload — `operation_conflict`. Повтор после потерянного ack возвращает ту же запись.

## Эффекты

Один эффект — одно намерение: `community.ensure_admission`, `community.approve_join` или
`community.ensure_absence`. Каждый шаг внутри него (`unban`, `create_invite`, `approve`, `ban`,
`revoke_link`) — отдельная attempt со свежим dispatch permit.

Перед любой mutation provider читает capability бота (administrator, `can_invite_users`,
`can_restrict_members`) и `getChatMember` для known identity. Недоступный или урезанный bot — это
не отсутствие членства: статус становится `unknown`, работа откладывается и повторяется.

Permit принимается только если он получен на тот же `operationId`/`dispatchId`/`attemptId` и его
`validUntil` не позже `now + 5s`. Attempt записывается durable до I/O под тем же account lock и
берёт аренду, поэтому второй worker не начинает параллельную попытку. Отказ отображается так:
`superseded` → `superseded`, `expired` → `expired` (для finite) плюс работа по устранению членства,
остальные — `failed`. `unavailable` не разрешает ни одного вызова.

Ссылка создаётся как `createChatInviteLink(creates_join_request=true)` без `member_limit`, живёт не
дольше десяти минут и не дольше finite права. Она привязана в собственной БД к intended identity и
конкретной revision, поэтому новое право никогда не переиспользует прежнюю ссылку. Успешная ссылка
хранится до передачи участнику: её выдаёт только команда `/community` в личном чате самого
intended contact и только при действующем праве. Команда отвечает лишь при
`TELEGRAM_COMMUNITY_MODE=live` и ничего не запускает сама: недостающую ссылку готовит сверка.
Передача ссылки не означает `applied` и не заменяет проверку join request. Массовая или
автоматическая рассылка ссылок не входит в поставку. Потерянный ответ `createChatInviteLink`
не порождает слепой повтор: эффект остаётся `unknown` до истечения этой ссылки, после чего нужна
новая свежая проверка. Вступление принимается только по durable `chat_join_request` от
подтверждённой intended identity в canonical chat; чужой или просроченный запрос отклоняется
локально и не выдаёт никакого права. Повтор того же update использует прежний effect, новый
законный rejoin — новый effect при той же `entitlementRevision`.

Удаление устраняет членство `banChatMember` и отзывает известную bot-owned ссылку: пока ссылка
жива, отказ не считается `applied`, потому что вход ещё открыт. Историческую
identity после unlink разрешено удалить только по собственной исторической связи того же Account и
при отсутствии переноса; спорная identity остаётся оператору.

## Сверка и наблюдаемость

Права бота читаются один раз на цикл (кэш 5 секунд), а не на каждый Account, чтобы не тратить общий
bot/chat rate budget. Известные состояния перепроверяются не реже
`TELEGRAM_COMMUNITY_RECONCILIATION_CADENCE_MS` (по умолчанию 60 000 мс, максимум минута).
Сверка обнаруживает истёкшее право, ушедшего участника и недоступность провайдера без единого
события. Истёкшее finite право переводится в `expired`, новое
approve запрещено, остаточное членство устраняется.

`GET /metrics` отдаёт `inside_telegram_community_due`,
`inside_telegram_community_oldest_due_seconds` и `inside_telegram_community_effect_backlog`.
Задержка свыше пяти минут видна оператору по второму gauge.

## Границы этой поставки

- Сбой community не меняет оплату и не затрагивает paid/manual доступ к материалам: provider
  не обращается к контенту и не пишет Membership Evidence.
- `TELEGRAM_COMMUNITY_MODE=disabled` — безопасное значение по умолчанию: inbox и сверка остаются
  durable, но ни одна внешняя mutation не выполняется.
- Реальный chat, реальные права бота, реальная выдача членства и Tribute остаются отдельными
  owner gates. Синтетические тесты не являются credentialed proof.
- Тексты ответов `/community` заданы значениями по умолчанию и переопределяются переменными
  `TELEGRAM_COMMUNITY_*_TEXT`; окончательные формулировки — решение владельца.
