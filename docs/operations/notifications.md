# Доставка Notifications через Telegram

Реализация [Telegram #56](https://github.com/sachkov-inside/inside-telegram/issues/56)
исполняет [принятый протокол](../contracts/notifications-v1/protocol.md).
Platform выбирает получателя, текст и категорию, проверяет источник, настройки и свою
linkRef/linkRevision. Telegram независимо разрешает Account/TelegramIdentity через собственную
verified `platform_links` и проверяет текущий BotContact. Команда не создаёт связь.

## Включение

По умолчанию consumer выключен. Для включения нужны `TELEGRAM_NOTIFICATIONS_ENABLED=true`,
`WORKERS_ENABLED=true` и следующие переменные окружения:

| Переменная | Назначение |
|---|---|
| `NOTIFICATION_AMQP_URL` | Scoped principal Telegram в отдельном vhost окружения; AMQPS, AMQP допускается только на loopback |
| `NOTIFICATION_AUTHORIZE_URL` | HTTPS endpoint Platform `/internal/notifications/dispatch/authorize`; HTTP только loopback |
| `NOTIFICATION_AUTHORIZE_SECRET` | Отдельный service bearer, не marketing/community secret |
| `NOTIFICATION_QUARANTINE_KEY` | Отдельный AES-256-GCM key, 64 lowercase hex символа |
| `NOTIFICATION_PREFETCH` | 1–100 команд на каждую из двух очередей, default 10 |
| `NOTIFICATION_BATCH_SIZE` | 1–100 due команд на цикл каждой категории, default 5 |

При `TELEGRAM_DELIVERY_MODE=disabled` команды и результаты сохраняются, отправки не начинаются.
Для отправки дополнительно нужны `TELEGRAM_DELIVERY_MODE=live` и существующий bot token.
Изменение production configuration, выдача credentials и настоящие сообщения требуют разрешения
владельца. Этот PR сам их не включает.

## RabbitMQ topology и права

[notification-topology.json](notification-topology.json) — импортируемый deployment artifact:
заменить `/inside-notifications` на отдельный vhost окружения. Импорт выполняет deployment
principal. Runtime не объявляет и не меняет exchanges, queues или bindings.

| Principal | configure | write | read |
|---|---|---|---|
| Telegram | `^$` | `^inside\.results\.telegram\.v1$` | `^telegram\.notifications\.(subscription\|material)\.v1$` |
| Platform Notifications | `^$` | `^inside\.notifications\.telegram\.v1$` | `^platform\.notification-results\.telegram\.v1$` |

Знак `\|` в Markdown-таблице означает обычную regex альтернативу `|`, без обратной косой черты.
Platform может использовать отдельные principals для publish/consume. Не добавлять default
exchange, чужие exchanges, alternate exchanges, exchange-to-exchange bindings или configure
в runtime permissions. Отдельные email/events lanes принадлежат Platform.

Quorum queues: persistent messages, максимум 10000 сообщений/16 MiB, `reject-publish`,
`x-delivery-limit=-1`, без TTL. Фактический quorum limit может кратко превышаться на уже летящие
сообщения. Эти настройки и scoped ACL проверяются на настоящем RabbitMQ.
Consumer ack следует только за durable inbox/quarantine commit. Results используют отдельный
confirm channel с `mandatory`; return, nack и timeout оставляют outbox для повтора с прежним ID.
Connection failure журналируется без URL/credentials; повтор соединения не чаще пяти секунд.

## Внешний эффект и ёмкость

Под одним Delivery lock сохраняются immutable command, последняя revision и результат. Перед I/O
сохраняются attemptRef/permitRef/started и `unknown` вместе с result outbox. Рестарт, повтор команды
и новая revision не открывают повтор после started/unknown/sent. Позднее доказательство принимается
только для исходной operation/digest/attempt. Публичного endpoint сброса unknown нет.

До начала отправки: backoff 1, 5, 30 секунд, максимум три повтора и не позже deadline.
Подтверждённый `429` сохраняет `not_sent` с точной attempt и откладывает общий bot budget.
Неоднозначные 5xx и transport timeout остаются unknown. После успешного Bot API внутренний ledger
хранит provider message ID, а wire result — только opaque receiptRef. Sent не означает прочтение.

В существующем общем лимите 40 ms на bot и 1 s на chat сохранённая в БД очередь ходов распределяет ёмкость так:
два — subscription, один — material, один — существующие служебные/marketing сообщения.
Пустые категории пропускаются; следующий ожидающий ход не зависит от фазы часов или задержки
preflight. При текущем due backlog ход категории сохраняется до отправки либо записи
retry/suppressed/failed. Ожидание существующих отправителей ограничено одной секундой после
их последнего запроса. Категории не создают новых
bot/chat бюджетов. Marketing consent не включает Notifications и не выключает подписку автоматически.

## Наблюдение и восстановление

Операторские запросы выполняются с ограниченным доступом к БД. Не экспортировать command text,
raw chat IDs или provider message ID в обычные логи/issue.

```sql
select category, state, count(*), min(available_at)
from notification_commands group by category, state;
select count(*), min(created_at) from notification_result_outbox where published_at is null;
select reason, count(*), min(created_at) from notification_quarantine group by reason;
select outcome, count(*), min(started_at) from notification_attempts group by outcome;
```

Растущий due backlog, oldest pending result, unknown/started attempts и ошибки worker требуют
разбора. Broker outage: восстановить соединение и дождаться outbox, не создавать новую operation.
Platform outage: восстановить authorize; просроченные команды подавляются. Unknown: оставить
барьер отправки и собрать evidence исходной attempt; не менять state вручную на retrying.
Отдельная recovery/send операция выходит за wire v1 и требует owner authority с явным риском дубля.

Quarantine хранит digest/reason и AES-GCM encrypted prefix до 16 KiB на семь дней; максимум
10000 payload записей. Переполнение/ошибка хранения останавливает consumer с alert и оставляет
broker work без ack. Retention worker раз в минуту удаляет только ciphertext; tombstones/inbox
бизнес-ключи автоматически не удаляются. Ключ хранить отдельно от БД, при ротации сохранить старый
для семидневного forensic окна. Экспорт/decrypt доступен только оператору с incident approval.
После исправления причины redrive повторяет исходный immutable payload и operationId через
правильный producer; quarantine receipt не является разрешением слепого send.

## Проверки и границы доказательств

`pnpm infra:up` поднимает локальные PostgreSQL/RabbitMQ; `DATABASE_URL=... pnpm check:full`
запускает unit и integration проверки. RabbitMQ tests создают собственный vhost и временных
synthetic principals через loopback Management API и удаляют их после проверки.
`NOTIFICATION_TEST_AMQP_URL`/`NOTIFICATION_TEST_MANAGEMENT_URL` переопределяют локальные адреса
(default 5673/15673). Эти тесты запрещают non-loopback endpoints.

Проверены реальные PostgreSQL транзакции/конкуренция, process death после durable started,
ошибка commit после simulated successful send, AMQP replay/ack/confirm/return/ACL/overflow,
оба category payload, fairness общего лимита, HTTP response correlation и quarantine retention.
Telegram transport и Platform policy responses в тестах synthetic. Полная проверка источников
Billing/Materials и email/Telegram через обе системы принадлежит Platform #438.
Настоящие Bot API sends, production TLS/credentials/ACL, multi-node RabbitMQ failover, rollout
и production приёмка этой реализацией не доказаны.

Основания transport semantics: [RabbitMQ confirms](https://www.rabbitmq.com/docs/confirms),
[quorum queues](https://www.rabbitmq.com/docs/quorum-queues),
[access control](https://www.rabbitmq.com/docs/access-control),
[Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage).
