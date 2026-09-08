# Notifications v1: переносимый протокол

Это нормативный target contract, не действующие endpoints/workers. Schema draft-07 и fixtures
задают closed wire shapes; сценарии задают обязательные runtime результаты. Shared source snapshot
в sources/ фиксирует owner-approved архитектуру и предлагаемые продуктовые defaults.

## AMQP transport и service authority

AMQP 0-9-1 поверх TLS; vhost отдельный на окружение. JSON UTF-8, content_type application/json,
максимум 16 KiB bytes после сериализации. Persistent delivery_mode=2, durable topic exchanges,
durable quorum queues. Producer ждёт publisher confirm и обрабатывает mandatory return:
confirm unroutable message не означает принятую работу. Outbox помечается опубликованным только
после positive confirm без return. Broker consumer ack — только после commit inbox/receipt и
восстанавливаемого durable задания. Часы synchronized UTC; сравнения используют injectable clock.

| Exchange | Publisher principal | Routing key → queue |
|---|---|---|
| `inside.events.billing.v1` | Platform billing relay | `billing.notice-ready` → `platform.notifications.billing.v1` |
| `inside.events.materials.v1` | Platform materials relay | `material.published` → `platform.notifications.materials.v1` |
| `inside.notifications.telegram.v1` | Platform Notifications relay | `subscription` → `telegram.notifications.subscription.v1`; `material` → `telegram.notifications.material.v1` |
| `inside.notifications.email.v1` | Platform Notifications relay | `subscription` → `email.notifications.subscription.v1`; `material` → `email.notifications.material.v1` |
| `inside.results.telegram.v1` | Telegram result relay | `delivery.result` → `platform.notification-results.telegram.v1` |
| `inside.results.email.v1` | Platform email result relay | `delivery.result` → `platform.notification-results.email.v1` |

Раздельные exchanges делают producer scope проверяемым обычными RabbitMQ resource permissions;
body не содержит доверенного actor. Runtime principals имеют write только на свои exchanges и
read только на свои queues, без configure; topology создаёт отдельный deployment principal.
Внутренние exchange-to-exchange bindings, alternate exchanges и общие write-regex, позволяющие
обойти эти scopes, запрещены. Consumer сверяет exchange, routing key, type и channel/category body.
Неправильный principal проверяется negative ACL fixture на реальном RabbitMQ, не только парсером.

AMQP message_id равен messageId для events/results и operationId для delivery. Повтор публикации
сохраняет его. transport headers не выбирают получателя и не меняют смысл тела. Queue TTL не
определяет бизнес-дедупликацию или срок права. Overload policy — reject-publish, не drop-head.
Нет queue/message TTL с молчаливым удалением; deadline проверяет consumer с записью suppressed.
Quorum delivery-limit явно -1: crash/redelivery не должен по default delivery limit удалить работу.
Poison bounded quarantine и остановка ошибочного consumer принадлежат приложению.
Ограниченный prefetch, отдельная ёмкость lanes, ненулевая доля material и отдельная result lane.
Runtime configuration задаёт capacity; проверка насыщением доказывает fairness и общий bot limit.

Quarantine принадлежит consumer: сохраняет безопасные correlation/digest/reason и ограниченный
защищённый payload до ack неисправимого сообщения. Если сохранить не удалось, consumer останавливает
приём и поднимает alert; нет ack с потерей доказательств или бесконечного горячего requeue.
Retention payload — семь дней, затем остаётся только receipt/digest/reason; общий incident runbook
описывает экспорт с ограниченным доступом и redrive. Raw provider payload/credentials не сохраняются.
Event/delivery дедупликационные tombstones сохраняются дольше broker replay horizon и не удаляются
автоматически вместе с payload. Для v1 нет автоматического удаления этих бизнес-ключей.

## События и материализация

`inside.notification-event.v1`: billing.notice-ready либо material.published. `messageId` — ID
конкретной immutable event revision; `occurrenceRef` — ID бизнес-повода. `sourceRef` — noticeRef
Billing или Material ID; `sourceRevision` — монотонная версия источника. Replay той же revision
сохраняет messageId, новая revision получает новый messageId при прежнем occurrenceRef.
Material occurrence создаётся один раз на первую публикацию и не меняется при republish/Series.
Для существовавших до включения системы публикаций migration не создаёт события задним числом.

Billing создаёт готовый notification event атомарно со своим lifecycle/due notice. Notifications
получает данные шаблона через публичный Billing facet и сверяет source revision; broker не несёт
bank token, raw webhook или придуманную сумму. Reminder due создаётся календарным Billing worker
за три дня; Notifications owns последующую delivery schedule, не календарь автосписания.
Material event атомарен с первым Save в Published; тело материала в broker не передаётся.

`occurredAt < notAfter`; material notAfter = occurredAt + 24 часа, billing deadline определяет
источник и он не может быть позднее актуальности повода. Source checks обязаны подтвердить
occurrenceRef/sourceRef/revision и время по собственным фактам; schema-valid event сам не доказательство.
Первая установка consumer не публикует все исторические материалы или платежи.

Notification key = source kind + occurrenceRef + Account. Delivery key = Notification + channel.
Новая source/template/recipient revision не создаёт вторую Notification или обходной Delivery.
Одна пара может иметь последовательные commands, но нельзя иметь два потенциально начатых send.
Состояния отсутствующей аудитории/канала записываются как no eligible recipient/channel, не sent.

Audience expansion хранит исходный event и checkpoint; bounded keyset batches по стабильному Account
ID. Account.createdAt и история opt-in должны соответствовать occurredAt, текущие публикация/доступ
проверяются при expansion и dispatch. После рестарта eligible строки могут исчезнуть, но не
появиться из нового opt-in/Account. Уникальный ключ предотвращает повтор на границе checkpoint.
После смены email/Telegram binding новая identity не наследует queued send автоматически.

## Delivery command и дедупликация

`inside.notification-delivery.v1`: общий Notification/Delivery, closed content category/kind,
templateRef/revision, immutable plain text, deadline и verified binding. Telegram binding задаёт
opaque accountRef/telegramIdentityRef/linkRef/linkRevision; email — accountRef/contactRef/revision.
Raw chat ID/email отсутствуют. Recipient разрешается только из verified записи канала: событие,
username, arbitrary URL или пользовательское поле не создают связь.

Subscription принимает только шесть перечисленных billing kinds; material — material_published.
Нельзя переименовать material в subscription для обхода opt-out: authorize проверяет сохранённый
Notification и source occurrence/category. Text до 3000 символов, email subject до 200 без CR/LF;
plain text без HTML/parse_mode/media. Кнопки/ссылки первой версии — подготовленный текст со ссылкой
только на configured HTTPS Platform origin. Проверку origin выполняет producer при рендеринге;
provider проверяет тип/размер и не использует URL как destination. Secrets/private body запрещены.

`issuedAt < notAfter <= issuedAt + 10 минут`, deadline не позже source deadline. Идентификаторы UUID
канонизируются в lowercase до hash/persistence; временные строки сохраняют исходную wire форму.
Fingerprint = SHA-256 UTF-8 JSON schema-valid command с рекурсивно сортированными object keys,
исходным порядком arrays, без whitespace, без Unicode normalization; integers только safe.
Schema валидирует shape; ordering/deadline/ownership/revision/correlation — runtime invariants.

Idempotency key = authenticated publisher scope + contractVersion + operationId. Другой payload
по тому же key — durable conflict, не перезапись. DeliveryRef связывает последовательные revisions;
одинаковая commandRevision с другим operationId возвращает operation_conflict без нового эффекта.
Producer обязан повторить исходный operationId и не переименовывать корреляцию результата.
Ни новый permit, ни lease expiry не снимают блокировку started/unknown/sent.

Новая commandRevision допустима только после доказанного not_started/suppressed/retryable-not-sent
старой команды. Provider проверяет это под тем же Delivery lock, что started, сохраняет latest revision
и supersedes старую. Сама новая команда не является доказательством not_started. Если после потери
связи Notifications не знает состояния, сначала повторяет исходную immutable команду для получения
сохранённого result. Новый command никогда автоматически не заменяет unknown или sent.

## Fresh dispatch authorization

Telegram → Platform: POST `/internal/notifications/dispatch/authorize`, HTTPS, JSON <=16 KiB,
timeout 5 секунд, redirects запрещены. Bearer service secret отдельный от marketing и community;
constant-time validation. Email worker вызывает тот же Notifications facet в своём runtime с
ограниченной email authority, не читает чужие таблицы напрямую. Secrets — только configuration.

`inside.notification-dispatch.v1` связывает authorization operationId, deliveryOperationId,
deliveryRef, commandRevision, command payloadDigest и attemptRef. Provider scope выводится из
service credentials; Telegram secret не разрешает email attempt. Notifications сверяет исходную
команду, текущий источник/получателя, category/preferences и ContentAccess для material. Billing
facet подтверждает актуальные сумму/дату/отмену; материалы — текущую публикацию/читательский доступ.

Ответ коррелирует все поля запроса. Allowed даёт permitRef/validUntil <= now + 5 секунд и не позже
command/source deadline. Denied содержит закрытую причину. Повтор authorization operationId с тем же
payload возвращает прежний deadline; новый preflight использует новый operationId/attemptRef.
Другой payload по старому authorization ID — operation_conflict. Permit не глобальная send reservation.

HTTP 200 — allowed/denied. error malformed=400, unauthorized=401, unsupported_contract=422,
operation_conflict=409, unavailable=503. HTTP/body mismatch или неизвестная версия — invalid response,
никакого I/O. До parseable request сервер использует generic 400/401 без выдуманной корреляции.
Недоступность источника — unavailable, не allow. Новый authorize после expiry безопасен только
если provider ledger ещё разрешает первую отправку.

## Журнал эффекта и результаты

Provider сериализует Delivery, проверяет latest command и свежий permit, атомарно сохраняет
attemptRef + started + permitRef до I/O. В этой транзакции delivery становится unknown до получения
доказательств. Если deadline истёк до started — I/O запрещён. После started restart не доказывает,
что вызов не произошёл. Telegram sendMessage не имеет client idempotency key; blind resend запрещён.

Успех Bot API → sent с внутренним receiptRef, связавшим message ID/attempt в закрытом ledger.
Явный запрет → failed; freshness/expiry → suppressed; потерянный ответ → unknown.
Доказанный provider rejection без отправки (например, 429) сохраняет not_sent attempt и разрешает
retrying с nextAttemptAt, тем же Delivery, новым attempt и fresh permit. До started retries имеют
backoff 1, 5, 30 секунд, максимум три автоматических повтора, не позже notAfter. retry_after может
увеличить задержку; если он выходит за deadline — suppressed. Неоднозначный 5xx не retryable.
Общее ограничение bot/chat делится со всеми существующими funnels/broadcasts и не сбрасывается
сменой category/worker. Timeout внешнего send, lease expiry и новый permit не открывают retry.

Result `inside.notification-result.v1` публикуется из отдельного outbox в той же транзакции, что
status/receipt. `operationId` — исходная команда, `payloadDigest` — её hash; messageId — конкретное
событие результата. `resultRevision` монотонна для Delivery через все command revisions.
Received result сверяется с known delivery/channel/command/digest; чужой channel/attempt/unknown
operation уходит в quarantine. Запоздалый result старой command revision не может заменить latest
command; но late success своей started attempt требуется операторской сверке, не теряется молча.

Переходы: accepted → retrying/suppressed/failed/unknown; retrying → retrying/suppressed/failed/unknown;
unknown → sent/failed/retrying только по доказательству той же attempt; retrying требует
явного доказательства not_sent временного отказа. `sent` терминален для внешнего
эффекта. После operator skip unknown сохраняется исторически unknown, не становится failed или sent.
Отдельная recovery operation требует owner authority, audit и видимого риска дубля; wire v1 не
предоставляет автоматический recovery/send обход. Новый source revision не разрешает такой обход.

Проекция может пропускать промежуточные revisions при переупорядочивании и принимать correlated
более новое состояние; она не требует предварительно увидеть accepted/unknown перед sent.
У проекции lower resultRevision игнорируется после проверки correlation; equal revision+digest
дедуплицируется, equal revision+different payload — конфликт. Утерянный result outbox повторяется;
повтор original command вызывает публикацию текущего durable result, а не новый send. Inbox принимает
command/replay даже при недоступном Platform preflight, но effect остаётся заблокированным.
`accepted` не доказывает внешнюю отправку; `sent` не доказывает прочтение или email inbox placement.

## Совместимость и проверка

Новые notification versions заменяют only notification.send/status и notice.send часть старого
billing bundle. Community entitlement и community dispatch сохраняют byte-identical v1 corpus
из Platform #403. No dual-send: runtime rollout включает одну notification path на бизнес-ключ.
Existing marketing API сохраняет отдельные audience/consent/state. Нет runtime source imports
другого repository; одинаковые schema/fixtures/scenarios/protocol/manifest/sources копируются
byte-for-byte, consumer provenance фиксирует source SHA и candidate/merged status.

Schema/fixture/hash проверки не симулируют worker. Все scenarios.json исполняются следующими
real-facet/PostgreSQL/RabbitMQ implementation tests; broker ACL, crash boundaries и actual Bot API
права нельзя доказать JSON Schema. Credentialed effects и production activation — отдельный gate.

Источники поведения: https://www.rabbitmq.com/docs/reliability,
https://www.rabbitmq.com/docs/confirms, https://www.rabbitmq.com/docs/quorum-queues,
https://www.rabbitmq.com/docs/access-control, https://core.telegram.org/bots/api#sendmessage.
