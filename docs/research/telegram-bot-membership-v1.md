# Telegram Bot API research for Membership bridge v1

Дата проверки: 2026-08-30.

Проверенная текущая версия official reference: Telegram Bot API 10.3 от 2026-08-24.
([Bot API: Recent changes](https://core.telegram.org/bots/api#recent-changes))

Статус: facts checked against primary official sources only. Эта заметка уточняет API boundary для
`Membership bridge v1`; она не заменяет application Specification и не подтверждает поведение,
которое возможно проверить только с реальным bot token и временным закрытым chat.

Нормативный статус: **none**. Императивные формулировки ниже — исследовательские следствия для
обсуждения и traceability к источникам, а не второй application contract. Принятые requirements
живут только в [Telegram Specification #1](https://github.com/sachkov-inside/inside-telegram/issues/1)
и её native tickets; при расхождении implementation следует им. Эта заметка остаётся evidence и
не должна использоваться как самостоятельный handoff для кода.

## Краткий вывод

- Private deep link имеет форму `https://t.me/<bot_username>?start=<parameter>`. Параметр допускает
  только `A-Z`, `a-z`, `0-9`, `_`, `-`, не длиннее 64 символов; после нажатия пользователем `START`
  bot получает `/start <parameter>`. Само открытие URL не является callback или доказательством
  identity. ([Telegram Bot Features: Deep Linking](https://core.telegram.org/bots/features#deep-linking),
  [Telegram Deep links: Bot links](https://core.telegram.org/api/links#bot-links))
- Webhook delivery — retryable, не exactly-once: Telegram повторяет любой запрос с ответом не `2xx`,
  а `Update.update_id` предназначен в том числе для удаления повторов и восстановления порядка.
  Поэтому v1 должен сначала аутентифицировать и durable сохранить update с unique `update_id`, и
  только потом вернуть `2xx`. ([`setWebhook`](https://core.telegram.org/bots/api#setwebhook),
  [`Update`](https://core.telegram.org/bots/api#update))
- `secret_token` приходит как неизменённое значение заголовка
  `X-Telegram-Bot-Api-Secret-Token`; это shared header secret, не подпись тела и не защита от replay.
  Replay/dedup остаётся обязанностью приложения. ([`setWebhook`](https://core.telegram.org/bots/api#setwebhook))
- Для v1 нужно явно зарегистрировать `allowed_updates: ["message", "chat_member",
  "my_chat_member"]`: `chat_member` исключён из default delivery, а omitted `allowed_updates`
  сохраняет предыдущее значение. ([`setWebhook`](https://core.telegram.org/bots/api#setwebhook),
  [`Update`](https://core.telegram.org/bots/api#update))
- Для `chat_member` updates и гарантированного `getChatMember` по другим пользователям bot должен
  иметь administrator status в canonical chat. Bot API не называет дополнительного granular
  administrator right для этих двух функций; фактический least-privilege набор надо подтвердить
  credentialed smoke. ([`Update.chat_member`](https://core.telegram.org/bots/api#update),
  [`getChatMember`](https://core.telegram.org/bots/api#getchatmember))
- Membership mapping: `creator`, `administrator`, `member` — member; `restricted` — member только
  при `is_member: true`; `left`, `kicked` — non-member. Неизвестный будущий status должен давать
  unavailable/fail-closed, а не positive evidence. ([`ChatMember`](https://core.telegram.org/bots/api#chatmember))
- Telegram identity — `User.id`; canonical membership location и private delivery destination —
  отдельные `Chat.id`; `Update.update_id` — ingestion dedupe key. Username не является identity key.
  `User.id` и `Chat.id` могут превышать 32 бита, но имеют не более 52 значащих бит.
  ([`User`](https://core.telegram.org/bots/api#user), [`Chat`](https://core.telegram.org/bots/api#chat))
- Official Bot API не обещает стабильный отдельный error code/description для отправки
  заблокировавшему пользователю: вообще при ошибке возвращаются `ok: false`, human-readable
  `description` и `error_code`, содержание которого может измениться. Exact blocked-send response
  должен быть наблюдением credentialed smoke, а не частью стабильного domain contract.
  ([Bot API: Making requests](https://core.telegram.org/bots/api#making-requests),
  [`sendMessage`](https://core.telegram.org/bots/api#sendmessage))

## 1. `/start` и linking deep link

### Проверенные факты

Для private chat Telegram документирует `https://t.me/<bot_username>?start=<parameter>`. Допустимый
алфавит параметра — `A-Z`, `a-z`, `0-9`, `_`, `-`; лимит — 64 символа, для binary content Telegram
рекомендует base64url. После пользовательского действия bot получает текст `/start <parameter>`.
([Telegram Bot Features: Deep Linking](https://core.telegram.org/bots/features#deep-linking))

Низкоуровневое описание link отдельно уточняет: открытие link показывает кнопку `Start` даже если
пользователь уже запускал bot, а `messages.startBot` с параметром вызывается после нажатия кнопки.
Следовательно, создание или открытие link не гарантирует доставку update.
([Telegram Deep links: Bot links](https://core.telegram.org/api/links#bot-links))

Deep-link параметр передаётся как command argument, а не как Telegram-signed identity assertion.
Устойчивый sender identifier находится в `Message.from.id`; `Message.chat` отдельно задаёт chat, в
котором пришла команда. Поле `Message.from` в общей схеме optional, поэтому malformed/unexpected
update без sender нельзя использовать для linking.
([`Message`](https://core.telegram.org/bots/api#message), [`User`](https://core.telegram.org/bots/api#user))

### Следствия для v1

1. Принимать linking `/start` только из `message.chat.type == "private"` и только при наличии
   non-bot `message.from`; Telegram identity брать из `message.from.id`.
2. Platform-issued token должен быть opaque high-entropy bearer value, укладываться в 64-symbol
   base64url alphabet, быть short-lived и single-use. Не помещать в payload account id, email или
   другой читаемый PII; в логах и audit хранить только redacted/hash representation.
3. Receipt token в Telegram доказывает только possession token конкретным `User.id`. Финальное
   подтверждение в authenticated Platform session остаётся обязательным согласно seed brief.
4. Обычный `/start` без payload создаёт/реактивирует `BotContact`; invalid, expired, replayed или
   conflicting payload не должен ломать этот независимый contact state и не должен раскрывать
   существование Platform Account.
5. Нельзя считать link «использованным» при генерации или открытии URL. Atomic consume должен
   происходить при durable processing первого валидного `/start <token>`.

Для grammY официальный command handler `bot.command("start", ...)` предоставляет trimmed argument
в `ctx.match`, включая deep-link payload. Это удобно для parsing, но TTL, single-use, atomic consume
и conflict rules остаются application code.
([grammY: Deep Linking Support](https://grammy.dev/guide/commands#deep-linking-support))

## 2. Доставка updates, acknowledgement и webhook secret

### Проверенные факты

Bot API предлагает два взаимоисключающих механизма получения updates: `getUpdates` и webhook.
Telegram хранит ожидающие updates не дольше 24 часов. При установленном webhook `getUpdates` не
работает. ([Bot API: Getting updates](https://core.telegram.org/bots/api#getting-updates),
[`setWebhook`](https://core.telegram.org/bots/api#setwebhook))

При webhook Telegram отправляет HTTPS `POST` с JSON-serialized `Update`. Ответ вне диапазона `2xx`
считается неуспешным и приводит к повторным попыткам, от которых Telegram в итоге откажется после
неуточнённого «reasonable amount of attempts». Это не бесконечная durable queue и не exactly-once
transport. ([`setWebhook`](https://core.telegram.org/bots/api#setwebhook))

`Update.update_id` — unique identifier: обычно значения растут последовательно, позволяют удалить
повторы и восстановить порядок, если updates пришли не по порядку. После недели без новых updates
следующий identifier выбирается случайно, а не как продолжение sequence.
([`Update`](https://core.telegram.org/bots/api#update))

`setWebhook.secret_token` имеет длину 1–256 символов и тот же ограниченный alphabet
`A-Z`, `a-z`, `0-9`, `_`, `-`. Telegram помещает его в каждый webhook request как
`X-Telegram-Bot-Api-Secret-Token`. Документация не описывает MAC/signature over body или timestamp.
([`setWebhook`](https://core.telegram.org/bots/api#setwebhook))

`allowed_updates` при omitted сохраняет предыдущее значение. Empty list означает все default types,
но исключает `chat_member`, `message_reaction`, `message_reaction_count`; смена списка не влияет на
уже созданные updates, поэтому короткое время могут приходить ранее разрешённые типы.
([`setWebhook`](https://core.telegram.org/bots/api#setwebhook))

`getWebhookInfo` возвращает, среди прочего, `pending_update_count`, last delivery error,
`max_connections` и фактический `allowed_updates`. Это подходящие readiness/smoke assertions, но не
замена приложенческим ingestion metrics. ([`WebhookInfo`](https://core.telegram.org/bots/api#webhookinfo))

### Следствия для v1

1. На ingress до parsing/processing проверить exact secret header; использовать отдельный random
   secret, не bot token. Отсутствующий/неверный header должен получить non-`2xx`/authorization
   failure и не должен попадать в durable update log.
2. Для аутентифицированного тела выполнить minimal schema validation и atomic insert достаточного
   для воспроизведения update envelope с unique key `(bot_identity, update_id)`. Вернуть `2xx`
   только после commit. Duplicate insert должен быть идемпотентным success и также завершаться
   `2xx`. Нужно ли и как долго хранить полный raw payload, остаётся решением Specification о data
   minimization/retention, а не выводом Telegram API.
3. Business handling, Telegram reconciliation и Platform evidence delivery выполнять после durable
   acknowledgement. Иначе медленная внешняя dependency превращает Telegram retry loop в task queue.
4. Явно вызывать `setWebhook` с `allowed_updates: ["message", "chat_member", "my_chat_member"]`;
   tolerate/ignore другие корректные update variants из старой конфигурации. Не использовать
   `drop_pending_updates` в обычном rollout.
5. `update_id` использовать как dedupe key и сигнал ordering, но не как event timestamp. Для
   member change source time брать `ChatMemberUpdated.date`; после недельной паузы нельзя полагаться
   на арифметическую непрерывность identifier.
6. Потеря ingress более чем на 24 часа и исчерпание retries возможны по контракту Telegram; поэтому
   background `getChatMember` reconciliation обязателен, а stale/unavailable evidence fail closed.

## 3. Какие updates нужны v1

| Update | Документированный смысл | Использование v1 |
| --- | --- | --- |
| `message` | Новый входящий message любого типа. [`Update.message`](https://core.telegram.org/bots/api#update) | Private `/start`, создание/реактивация `BotContact`, token receipt. Service membership messages не являются canonical membership source. |
| `chat_member` | Status некоторого chat member изменился; bot должен быть administrator и update type должен быть явно включён. [`Update.chat_member`](https://core.telegram.org/bots/api#update) | Изменения Membership Signal в canonical chat: join, removal, rejoin, restriction. |
| `my_chat_member` | Status самого bot изменился; в private chat этот update приходит только при block/unblock пользователем. [`Update.my_chat_member`](https://core.telegram.org/bots/api#update) | Private deliverability signal и operational signal о remove/demotion bot в canonical chat. |

`ChatMemberUpdated.from` — performer действия, а subject membership находится в
`new_chat_member.user`/`old_chat_member.user`. V1 должен фильтровать `chat.id` по exact configured
canonical chat и строить evidence для `new_chat_member.user.id`, не для `from.id`.
([`ChatMemberUpdated`](https://core.telegram.org/bots/api#chatmemberupdated))

`ChatMemberUpdated.date` — Unix time изменения. `old_chat_member` и `new_chat_member` позволяют
проверять transition, но current normalized membership определяется из `new_chat_member`.
([`ChatMemberUpdated`](https://core.telegram.org/bots/api#chatmemberupdated))

Если `my_chat_member` показывает, что bot больше не administrator canonical chat, документированные
предпосылки и для `chat_member`, и для гарантированного reconciliation нарушены. Provider должен
немедленно перейти в degraded/unavailable, перестать выдавать fresh positive evidence, alert и
fail closed до credentialed восстановления.
([`Update`](https://core.telegram.org/bots/api#update),
[`getChatMember`](https://core.telegram.org/bots/api#getchatmember))

Exact `old_chat_member`/`new_chat_member` status pairs для private block/unblock официальная страница
Bot API не фиксирует. Она гарантирует назначение `my_chat_member` update, но конкретные наблюдаемые
пары остаются credentialed proof.

## 4. Admin requirement и reconciliation

Bot API формулирует две отдельные гарантии:

- `chat_member` updates доставляются, если bot — administrator chat и тип явно включён в
  `allowed_updates`; ([`Update`](https://core.telegram.org/bots/api#update))
- `getChatMember(chat_id, user_id)` гарантированно работает для других users, если bot —
  administrator chat. ([`getChatMember`](https://core.telegram.org/bots/api#getchatmember))

Ни один из этих контрактов не называет `can_delete_messages`, `can_restrict_members`,
`can_invite_users` или иной дополнительный right. Для сравнения, когда конкретное право необходимо,
Bot API называет его прямо — например, `chat_join_request` требует `can_invite_users`.
([`Update.chat_join_request`](https://core.telegram.org/bots/api#update))

Следовательно, документированный минимум v1 — administrator status; нельзя добавлять moderation
rights «на всякий случай». Но Telegram client может предъявлять свои ограничения при promotion, а
canonical chat ещё не выбран. Exact assignable least-privilege configuration нужно доказать в
temporary chat и записать в runbook.

Reconciliation request должен использовать configured numeric `Chat.id` и linked `User.id`.
Successful result нормализуется той же функцией, что event `new_chat_member`; API error/timeout — это
unavailable observation, не non-member. `getChatMember` возвращает current `ChatMember`, но не
source event time, поэтому reconciliation evidence получает local observation time и provider
revision после успешного response.
([`getChatMember`](https://core.telegram.org/bots/api#getchatmember))

## 5. Нормализация Membership

Bot API задаёт шесть variants `ChatMember`. ([`ChatMember`](https://core.telegram.org/bots/api#chatmember))

| Bot API value | Нормализация v1 | Основание |
| --- | --- | --- |
| `creator` | `member` | Owner является chat member и имеет все administrator privileges. [`ChatMemberOwner`](https://core.telegram.org/bots/api#chatmemberowner) |
| `administrator` | `member` | Administrator — member с additional privileges. [`ChatMemberAdministrator`](https://core.telegram.org/bots/api#chatmemberadministrator) |
| `member` | `member` | Обычный member без additional privileges/restrictions. [`ChatMemberMember`](https://core.telegram.org/bots/api#chatmembermember) |
| `restricted`, `is_member: true` | `member` | Поле прямо означает, что restricted user сейчас является member. [`ChatMemberRestricted`](https://core.telegram.org/bots/api#chatmemberrestricted) |
| `restricted`, `is_member: false` | `non_member` | То же поле прямо отрицает current membership. [`ChatMemberRestricted`](https://core.telegram.org/bots/api#chatmemberrestricted) |
| `left` | `non_member` | User сейчас не member, хотя может вступить сам. [`ChatMemberLeft`](https://core.telegram.org/bots/api#chatmemberleft) |
| `kicked` | `non_member` | User banned и не может вернуться/видеть chat до снятия ban. [`ChatMemberBanned`](https://core.telegram.org/bots/api#chatmemberbanned) |
| Unknown variant/value | `unavailable` | Forward-compatible fail-closed application rule; Bot API может развиваться. |

Permissions restricted member (`can_send_messages` и другие) не входят в v1 Membership Signal:
`restricted + is_member: true` остаётся member. `until_date` можно сохранить как redacted diagnostic
fact, но нельзя самостоятельно превращать в future evidence: expiry должен быть подтверждён новым
update или reconciliation.

Event и reconciliation обязаны проходить одну normalization function и один conformance corpus.
Positive evidence получает max validity 5 minutes из product brief; failed reconciliation, unknown
status или потеря admin prerequisite не продлевают last positive evidence.

## 6. Идентификаторы и поля хранения

| Значение | Роль | Правило хранения |
| --- | --- | --- |
| `User.id` | Stable Telegram user/bot identifier. [`User`](https://core.telegram.org/bots/api#user) | Canonical Telegram identity key; signed 64-bit-capable DB type. Не username. |
| `Chat.id` | Unique chat identifier; тип отдельно лежит в `Chat.type`. [`Chat`](https://core.telegram.org/bots/api#chat) | Отдельно хранить canonical membership chat и private delivery chat. Не выводить одно из другого. |
| `Update.update_id` | Unique update/dedup and ordering aid. [`Update`](https://core.telegram.org/bots/api#update) | Unique ingestion key scoped by bot identity; не event time. |
| `Message.message_id` | Unique только внутри данного chat. [`Message`](https://core.telegram.org/bots/api#message) | Diagnostic/correlation key только вместе с `Chat.id`; не global dedupe. |
| `ChatMemberUpdated.from.id` | Performer membership action. [`ChatMemberUpdated`](https://core.telegram.org/bots/api#chatmemberupdated) | Audit actor, не subject identity. |
| `ChatMemberUpdated.new_chat_member.user.id` | User, чей membership изменился. [`ChatMemberUpdated`](https://core.telegram.org/bots/api#chatmemberupdated) | Subject для normalized evidence. |

`User.id` и `Chat.id` могут иметь более 32 значащих бит, но не более 52, поэтому Bot API рекомендует
64-bit-capable representation. TypeScript `number` может точно принять documented range, но DB/API
contracts лучше задавать как integer with 64-bit capacity и проверять сериализацию на границах.
([`User`](https://core.telegram.org/bots/api#user), [`Chat`](https://core.telegram.org/bots/api#chat))

Bot token является authentication credential, а `getMe` возвращает `User` текущего bot. Startup и
credentialed smoke должны сверять returned bot `id` и ожидаемую dedicated bot identity; exact id и
username нельзя заполнить до BotFather write.
([Bot API: Authorizing your bot](https://core.telegram.org/bots/api#authorizing-your-bot),
[`getMe`](https://core.telegram.org/bots/api#getme))

## 7. Outbound send, block и contactability

`sendMessage` на success возвращает sent `Message`. Общий Bot API response на failure имеет
`ok: false`, human-readable `description` и integer `error_code`, содержание которого Telegram
считает изменяемым. ([`sendMessage`](https://core.telegram.org/bots/api#sendmessage),
[Bot API: Making requests](https://core.telegram.org/bots/api#making-requests))

`my_chat_member` в private chat предназначен для block/unblock status change. Это independent
inbound signal technical contactability, но документация не обещает, что он заменяет результат
каждой попытки `sendMessage`, и не задаёт стабильную blocked-send error taxonomy.
([`Update.my_chat_member`](https://core.telegram.org/bots/api#update))

Следствия для v1:

1. Successful private `/start` реактивирует BotContact по product policy. Private `my_chat_member`
   сохраняется как отдельный deliverability observation; block не удаляет contact/link/history.
2. Любой failed `sendMessage` означает, что конкретная доставка не подтверждена. Network/transport
   failure нельзя автоматически классифицировать как block; retry policy должна отличать transport
   failure от Telegram API response.
   Bot API не предоставляет `sendMessage` idempotency key, а grammY `HttpError` означает, что
   клиент не получил надёжный API result. Отсюда следует unknown outcome: автоматический retry
   после transport failure потенциально может дать duplicate transactional message. Specification
   должна зафиксировать bounded retry/duplicate policy вместо обещания exactly-once delivery.
   ([`sendMessage`](https://core.telegram.org/bots/api#sendmessage),
   [grammY: Error Handling](https://grammy.dev/guide/errors))
3. Не включать human-readable error description в domain invariant. До smoke exact code/text для
   blocked user остаётся diagnostic observation. Необъяснимый permanent API failure помечает
   delivery unavailable и требует bounded retry/inspection, но не меняет Membership.
4. Не отправлять transactional `sendMessage` как method embedded в webhook HTTP response: сам
   Telegram предупреждает, что тогда нельзя узнать success или получить result. Делать обычный
   Bot API call из worker и сохранять observable result/failure.
   ([Making requests when getting updates](https://core.telegram.org/bots/api#making-requests-when-getting-updates))

В grammY Bot API `ok: false` становится `GrammyError`, а failure связи с Bot API — `HttpError`; при
webhooks middleware error передаётся web framework. Эта классификация соответствует нужному
разделению API rejection и unknown transport outcome.
([grammY: Error Handling](https://grammy.dev/guide/errors))

## 8. Релевантные integration facts grammY

- `bot.command("start", handler)` выделяет argument/deep-link payload в `ctx.match`.
  ([grammY: Commands](https://grammy.dev/guide/commands))
- `bot.on("my_chat_member")` и `bot.on("chat_member")` различают status самого bot и других members;
  `chat_member` всё равно требуется включить через `allowed_updates`.
  ([grammY: Chat Member Updates](https://grammy.dev/guide/filter-queries#chat-member-updates))
- `webhookCallback` имеет `fastify` adapter и `secretToken` option; при webhook нельзя параллельно
  вызывать `bot.start()`, потому что это long polling. ([grammY: How to Use Webhooks](https://grammy.dev/guide/deployment-types#how-to-use-webhooks),
  [grammY: WebhookOptions](https://grammy.dev/ref/core/webhookoptions))
- `webhookCallback` по умолчанию timeout через 10 секунд с strategy `throw`; strategy `return` может
  завершить HTTP request, пока middleware ещё выполняется, и official grammY guide предупреждает о
  concurrent processing/race/data loss. V1 не должен использовать early-success strategy как замену
  durable queue. ([grammY: Ending Webhook Requests in Time](https://grammy.dev/guide/deployment-types#ending-webhook-requests-in-time))
- grammY transport adapter не создаёт durable inbox, unique constraint или reconciliation worker.
  Эти свойства остаются application responsibilities независимо от выбранной integration shape.

## 9. Обязательные credentialed proofs до application-ready

Ниже явно перечислено то, чего официальная документация не доказывает для конкретной bot/chat
конфигурации.

1. **Dedicated bot identity:** создать bot через owner-controlled BotFather flow; `getMe` должен
   зафиксировать exact `User.id`, username и ожидаемые capability flags. Подтвердить recovery/token
   rotation runbook без записи token в repository или logs.
2. **Canonical/test chat:** зафиксировать numeric `Chat.id` и `Chat.type` временного closed chat;
   проверить, что production candidate chat имеет ту же релевантную semantics.
3. **Least privilege:** повысить bot до administrator с минимально назначаемыми client rights и
   доказать получение `chat_member` плюс успешный `getChatMember` для другого user. Затем убрать или
   demote bot и доказать `my_chat_member`, прекращение гарантий и fail-closed operational state.
4. **Status corpus:** реальными accounts получить `creator`, `administrator`, `member`,
   `restricted/is_member` (где chat type это допускает), `left`, `kicked`; сверить event normalization
   и `getChatMember` normalization одним corpus. Зафиксировать exact block/unblock и
   join/removal/rejoin old/new status pairs как observed facts, не как universal Telegram contract.
5. **Webhook authentication:** выставить public HTTPS webhook с отдельным `secret_token`; проверить
   correct/missing/wrong header, отсутствие durable insert при wrong secret, insert-before-`2xx`,
   duplicate `update_id`, non-`2xx` retry и итоговый `getWebhookInfo.allowed_updates`.
6. **Ordering/recovery:** искусственно задержать parallel webhook handlers, доказать idempotency и
   ordering protection; затем пропустить member event в controlled test и доказать восстановление
   текущего state через reconciliation без продления stale positive evidence.
7. **Deep links:** обычный `/start`, tokenized `/start`, click для уже-started bot, expired token,
   replay, concurrent double consume, malformed payload и conflict должны дать предусмотренные
   transactional responses и не нарушить identity uniqueness.
8. **Block/send behavior:** после успешного start выполнить successful `sendMessage`, block,
   повторить send и записать actual Telegram response/grammY error как diagnostic; затем unblock и
   новый `/start`, подтвердить delivery recovery. Не превращать observed error text в stable rule.
9. **Provider outage:** timeout/API error `getChatMember` должен давать unavailable, а не
   non-member; expired five-minute positive evidence не должно авторизовать новые protected
   operations.

До прохождения этих proofs точные bot username/id, chat id/type, assignable admin rights, public
callback URL, secret custody и exact block/send response остаются намеренно unresolved.
