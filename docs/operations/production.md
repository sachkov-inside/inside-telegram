# Постоянный Telegram provider

Один процесс HTTP с фоновыми обработчиками и operations-команды из того же образа. Platform остаётся
единственным владельцем решений о доступе. Этот runbook описывает подготовку к совместной выкладке
с Platform ([Telegram #45](https://github.com/sachkov-inside/inside-telegram/issues/45),
[Platform #527](https://github.com/sachkov-inside/platform/issues/527)). Сама выкладка,
регистрация webhook на production-боте, изменение прав ботов и живая приёмка выполняются в
[Workspace #184](https://github.com/sachkov-inside/workspace/issues/184) по отдельному
разрешению владельца. Наличие этого документа ничего не включает.

## Состав

- `app` — HTTP, webhook inbox и все workers; порт только на `127.0.0.1`.
- `migrate`, `community-restriction`, `webhook-registration` — одноразовые команды профиля
  `operations` из того же образа. В образе нет pnpm; `pnpm owner:*` — только в checkout разработчика.
- PostgreSQL 18: отдельная база Telegram в общем кластере.
- RabbitMQ: брокер Platform на том же VPS ([Platform #527](https://github.com/sachkov-inside/platform/issues/527)).
  Telegram — один из его principals, см. [notifications.md](notifications.md#production).
- Host Caddy с HTTPS и входной [relay](webhook-relay.md) на TCP 88.

## Подготовка базы и файлов

Нужны Docker Engine/Compose, Caddy с HTTPS, доступный PostgreSQL 18 и проверенная резервная копия.
Telegram получает отдельную базу `inside_telegram` с отдельной login-ролью `telegram_owner` без
superuser, createdb и createrole. Роль владеет только своей базой. Отзовите PUBLIC CONNECT на других
прикладных базах кластера и убедитесь, что Telegram не может к ним подключиться. Пароль роли
передавайте через защищённый административный канал, без shell arguments/history и журналирования.
Database входит в резервную копию кластера pgBackRest. App не читает таблицы Platform или Logto.

Создайте root-owned `/etc/inside/telegram` с mode `0700`. `application.env` — копия корневого
`.env.example`, заполненная реальными значениями, mode `0600`. `compose.env` берётся из
`infra/production/compose.env.example` с теми же правами. Секреты, chat id и user id остаются вне
Git; зашифруйте файлы для host и отдельного recovery identity и проверьте обратную расшифровку.

## Конфигурация

`.env.example` перечисляет каждую переменную, которую читает приложение. Каждый секрет — отдельное
случайное base64url значение не короче 32 символов (`TELEGRAM_WEBHOOK_SECRET` — до 256 символов
того же алфавита). Приложение отказывается стартовать при повторе секрета между направлениями.

| Группа | Telegram | Значение на выпуске | Пара на стороне Platform |
| --- | --- | --- | --- |
| Процесс | `DATABASE_URL`, `WORKERS_ENABLED` | внутренняя сеть БД; `true` | — |
| Бот | `TELEGRAM_BOT_IDENTITY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CANONICAL_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | dedicated production bot; одна общая группа | `TELEGRAM_BOT_START_URL` |
| Ответы в личном чате | `TELEGRAM_DELIVERY_MODE` и тексты `TELEGRAM_*_TEXT` | `live`; тексты по-русски | — |
| Привязка и communications API | `PLATFORM_INTEGRATION_SECRET` | секрет | `TELEGRAM_LINKING_SECRET`, `TELEGRAM_COMMUNICATIONS_SECRET`; `TELEGRAM_LINKING_ENDPOINT=https://<telegram>/integrations/platform/v1/identity-links`, `TELEGRAM_COMMUNICATIONS_ENDPOINT=https://<telegram>/integrations/platform/v1/communications` |
| Membership Evidence | `TELEGRAM_MEMBERSHIP_MODE`, `TELEGRAM_MEMBERSHIP_RECONCILIATION_CADENCE_MS`, `PLATFORM_EVIDENCE_DELIVERY_MODE`, `PLATFORM_EVIDENCE_DELIVERY_URL`, `PLATFORM_EVIDENCE_DELIVERY_SECRET` | `live`, `240000`, `live`, `https://<platform>/integrations/telegram/v1/membership-evidence` | `TELEGRAM_EVIDENCE_INGRESS_SECRET` |
| Вход через бота | `TELEGRAM_SIGN_IN_ENABLED`, `TELEGRAM_SIGN_IN_INTEGRATION_SECRET` | `false` до готовности Logto и Platform | `TELEGRAM_SIGN_IN_INTEGRATION_SECRET` |
| Сообщество v2 | `TELEGRAM_COMMUNITY_CONTRACT_VERSION`, `TELEGRAM_COMMUNITY_MODE`, `TELEGRAM_COMMUNITY_RECONCILIATION_CADENCE_MS`, `TELEGRAM_COMMUNITY_REMOVALS_ENABLED`, `TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID` | `inside.community-entitlement.v2`, `live`, `60000`, `false`, id бота Tribute | `TELEGRAM_COMMUNITY_CONTRACT_VERSION=inside.community-entitlement.v2` |
| Сообщество: входящие команды | `PLATFORM_COMMUNITY_INTEGRATION_SECRET` | секрет | `TELEGRAM_COMMUNITY_ENTITLEMENT_SECRET`, `TELEGRAM_COMMUNITY_ENTITLEMENT_ENDPOINT=https://<telegram>/integrations/platform/v1/community-entitlements` |
| Сообщество: разрешение эффекта | `PLATFORM_COMMUNITY_DISPATCH_URL`, `PLATFORM_COMMUNITY_DISPATCH_SECRET` | `https://<platform>/internal/billing-dispatch/authorize` | `TELEGRAM_COMMUNITY_DISPATCH_SECRET` |
| Активация курса и Tribute | `TELEGRAM_ACTIVATION_ENABLED`, `PLATFORM_ACTIVATION_URL`, `PLATFORM_ACTIVATION_SECRET`, `PLATFORM_ACCOUNT_URL`, `TELEGRAM_ACTIVATION_SOURCES` | `https://<platform>/integrations/telegram/v1/subscription-activation`; Account URL; реестр групп курса | `TELEGRAM_ACTIVATION_INGRESS_SECRET` |
| Уведомления | `TELEGRAM_NOTIFICATIONS_ENABLED`, `NOTIFICATION_AMQP_URL`, `NOTIFICATION_AUTHORIZE_URL`, `NOTIFICATION_AUTHORIZE_SECRET`, `NOTIFICATION_QUARANTINE_KEY`, `NOTIFICATION_PREFETCH`, `NOTIFICATION_BATCH_SIZE` | AMQPS principal Telegram; `https://<platform>/internal/notifications/dispatch/authorize`; ключ 64 hex | `NOTIFICATIONS_TELEGRAM_SECRET`; principal и vhost из topology Platform |
| Авторское меню, воронки, рассылки | `PLATFORM_AUTHOR_AUTHORIZATION_URL`, `PLATFORM_AUTHOR_AUTHORIZATION_SECRET`, `PLATFORM_AUTHOR_CONTENT_VALIDATION_URL`, `TELEGRAM_MARKETING_ENABLED` | `https://<platform>/integrations/telegram/v1/communications/authorize` и `/validate-content`; `false` | `TELEGRAM_AUTHOR_AUTHORIZATION_SECRET`, `TELEGRAM_COMMUNICATIONS_BOT_IDENTITY` |
| Переходы по ссылкам | `PLATFORM_TRACKING_REDIRECT_URL`, `PLATFORM_TRACKING_TARGET_PREFIXES` | не задавать: маршрута-приёмника в Platform пока нет | — |

Явные отказы при старте:

- `TELEGRAM_COMMUNITY_CONTRACT_VERSION` с любым значением, кроме v2;
- настроенное сообщество (live, любой community secret или dispatch URL) без явной версии;
- live-режим без токена бота; неполная пара URL и секрета; HTTP вне loopback;
- `TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID`, совпадающий с id самого бота или не числовой;
- `NOTIFICATION_AUTHORIZE_SECRET`, совпадающий с linking, author или community secret;
- флаг, отличный от `true`/`false`: ошибка называет переменную.

Platform сам не включает community producer без явного v2: при другой версии он не шлёт команды.
Telegram отвечает `422 unsupported_contract` на `entitlement.set` другой версии; статус прежних
v1 операций по-прежнему читается.

### Вход через бота

До готовности обоих consumers оставьте `TELEGRAM_SIGN_IN_ENABLED=false`. Секрет
`TELEGRAM_SIGN_IN_INTEGRATION_SECRET` совпадает с одноимённым secret Platform API и credential
Telegram connector в Logto; он не передаётся браузеру и не попадает в журналы.

Logto использует POST `/integrations/identity/v1/sign-in` для регистрации и
`/integrations/identity/v1/sign-in/<requestRef>/status`, `/consume` для завершения проверки.
Platform API использует `/integrations/identity/v1/sign-in/<requestRef>/account-link`.
Base URL обоих клиентов — `https://<telegram-domain>`. Серверный callback Logto в Platform
`/integrations/telegram/v1/sign-in/linked-identity` настраивается на стороне Platform.

После совместной подготовки Logto, Platform и provider включите sign-in и перезапустите
единственный app. Отключение — `TELEGRAM_SIGN_IN_ENABLED=false` с перезапуском; не удаляйте
sign-in subjects или связи. Уже открытые запросы окончательно истекают через пять минут.

### Воронки

`TELEGRAM_MARKETING_ENABLED=true` включает воронки и marketing entry. Это отдельное решение владельца
в [Workspace #184](https://github.com/sachkov-inside/workspace/issues/184). Уведомления о подписке и
материалах от marketing не зависят.

## Права ботов

**Бот Inside в общей группе** — administrator с двумя правами:

- `can_invite_users` — личные ссылки с заявкой на вступление и одобрение своей заявки;
- `can_restrict_members` — снятие бана при возврате участника. Пока
  `TELEGRAM_COMMUNITY_REMOVALS_ENABLED=false`, бот никого не исключает.

Остальные права администратора, включая анонимность, выключены. Без любого из двух прав provider не
выполняет ни одного действия и показывает diagnostic `bot_invite_right_required` или
`bot_restrict_right_required`. Статус administrator также нужен, чтобы получать `chat_member` для
Membership Evidence.

**Бот Inside в группах-источниках курса** — administrator без дополнительных прав. Он только читает
членство (`getChatMember`) и ничего в этих группах не меняет.

**Бот Tribute** остаётся в общей группе с прежними правами до переноса участников
([#150](https://github.com/sachkov-inside/workspace/issues/150)). Кто кого исключает и что делает бот
Inside после исключения, описано в [схеме двух ботов](course-activation.md#два-бота-в-общей-группе).
Числовой id бота Tribute владелец берёт из списка администраторов группы и записывает в
`TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID`. Без него каждое исключение ботом Tribute считается неизвестным,
и участник с правом Platform остаётся вне группы до решения владельца.

Права проверяются через `getMe`, `getChat` и `getChatMember` для самого бота. Изменение прав в боевой
группе — действие владельца.

## Сборка и запуск

Используйте чистый checkout точного merged commit. Обычный агент не изменяет основной checkout
владельца. Production запуск и каждый merge требуют соответствующего разрешения владельца.

```bash
git diff --exit-code
git diff --cached --exit-code
release_commit=$(git rev-parse HEAD)
docker build --file infra/production/Dockerfile \
  --build-arg SOURCE_COMMIT="$release_commit" \
  --tag "inside/telegram:$release_commit" .
docker image inspect "inside/telegram:$release_commit" \
  --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Docker context использует allowlist: `.env`, credentials, Git, локальные зависимости и proof
payloads не входят в image. Запишите image id, commit и время в защищённый deployment record.
Установите `TELEGRAM_IMAGE` в `compose.env` в точный полученный image id (`sha256:…`), чтобы повтор
не зависел от перемещаемого тега. Доставьте Compose в `/opt/inside/telegram/compose.yaml`.

Команды выполняются на VPS. Сохраните host-owned `/etc/inside/telegram/compose.override.yaml`:
текущий production использует его для Telegram transport через relay, а после выпуска — и для сети
брокера. Не заменяйте его шаблоном и не выводите разрешённую Compose-конфигурацию с секретами.
Перед обновлением сверяйте transport и обе версии конфигурации с deployment record.
Все команды ниже включают override, в том числе migration и operations; на relay-host отсутствие
файла — повод остановиться и восстановить конфигурацию.

```bash
telegram_compose=(docker compose --env-file /etc/inside/telegram/compose.env
  -f /opt/inside/telegram/compose.yaml
  -f /etc/inside/telegram/compose.override.yaml)
(
set -e
test -f /etc/inside/telegram/compose.override.yaml
"${telegram_compose[@]}" config --quiet
"${telegram_compose[@]}" stop app
"${telegram_compose[@]}" --profile operations run --rm --interactive=false migrate
"${telegram_compose[@]}" up --detach --no-build --wait app
)
```

При ошибке migration или readiness остановитесь и сохраните диагностику без секретов. Старые
workers должны быть остановлены до migration: два поколения не работают одновременно. При
обновлении предварительно сделайте backup и сохраните прежнюю конфигурацию и image id.
Автоматический rollback и downgrade migrations не выполняются; повтор той же версии идемпотентно
проверяет применённые migrations. `restart: unless-stopped` возвращает запущенный сервис после
reboot; явно остановленный maintenance-сервис требует явного `up`.

### Сеть до брокера

`app` подключается к RabbitMQ Platform по AMQPS. Host в `NOTIFICATION_AMQP_URL` должен совпадать с
именем в сертификате брокера: amqplib передаёт его как TLS `servername`. Сеть и CA добавляются
host-owned override, потому что имя сети и способ выпуска сертификата задаёт Platform #527:

```yaml
services:
  app:
    networks: [database, egress, broker]
    environment:
      NODE_EXTRA_CA_CERTS: /run/inside/broker-ca.pem
    volumes:
      - /etc/inside/telegram/broker-ca.pem:/run/inside/broker-ca.pem:ro
networks:
  broker:
    external: true
    name: <сеть брокера из Platform #527>
```

`NODE_EXTRA_CA_CERTS` добавляет только доверие к CA; проверка сертификата и hostname остаётся
включённой. Если брокер предъявляет публично доверенный сертификат, CA и volume не нужны.

## HTTPS и маршруты

Возьмите `infra/production/telegram.caddy.example`, замените hostname на отдельный production
домен с DNS на VPS и при необходимости loopback port. Проверьте Caddy config перед reload.
Наружу принимаются только POST из точного allowlist, секреты проверяет приложение:

| Путь | Вызывающий |
| --- | --- |
| `/webhooks/telegram` | Telegram |
| `/integrations/platform/v1/identity-links`, `/identity-links/<ref>/confirm` | Platform API |
| `/integrations/platform/v1/community-entitlements` | Platform billing-worker |
| `/integrations/platform/v1/communications` | Platform API и MCP |
| `/integrations/identity/v1/sign-in`, `/sign-in/<ref>/status`, `/consume`, `/account-link` | Logto и Platform API |

Reference занимает один сегмент пути; вложенные пути не допускаются. Остальные пути дают `404`,
порт приложения доступен только на `127.0.0.1`. Caddy access logging для этого сайта не включается:
URL подтверждения содержит opaque transaction reference.

Platform `TELEGRAM_LINKING_ENDPOINT` указывает на
`https://<telegram-domain>/integrations/platform/v1/identity-links`, а `TELEGRAM_BOT_START_URL` —
на подтверждённый username production bot. Target path протокола community
`/internal/community-entitlements` обслуживается как
`https://<telegram-domain>/integrations/platform/v1/community-entitlements`.

Telegram вызывает Platform по публичному HTTPS: `membership-evidence`, `subscription-activation`,
`/internal/billing-dispatch/authorize`, `/internal/notifications/dispatch/authorize`,
`/integrations/telegram/v1/communications/authorize` и `/validate-content`. Каждый из них должен
быть опубликован Caddy Platform, иначе соответствующая функция Telegram отказывает закрыто.

Точка сверки с Platform #527: на Platform `origin/main` от 15.09.2026 `platform.caddy` отвечает
`404` на любой неизвестный `/integrations/*`. Список #527 добавляет активацию и два dispatch-адреса,
но не `communications/authorize` и `communications/validate-content`. Без них авторское меню,
предпросмотр и публикация воронок не работают. Их нужно добавить в #527 или отложить
авторское меню явным решением.

## Webhook

Приложение принимает `message`, `chat_member`, `my_chat_member`, `chat_join_request` и
`callback_query` (источник списка — `TELEGRAM_WEBHOOK_ALLOWED_UPDATES` в
`src/modules/webhook/telegram-webhook.ts`). Без `chat_join_request` бот не видит заявку по личной ссылке и не впускает
покупателя. Регистрация webhook — операция владельца; обычный деплой и рестарт её не выполняют.

**Production через relay.** Команда `webhook-registration` меняет только список `allowed_updates`.
Точный URL с портом 88, `ip_address` relay и `max_connections` она читает из `getWebhookInfo` и
сохраняет; `drop_pending_updates=false`; секрет берётся из `application.env`. Токен не попадает в
argv и вывод.

```bash
telegram_url=https://<telegram-domain>:88/webhooks/telegram
"${telegram_compose[@]}" --profile operations run --rm -T \
  -e TELEGRAM_WEBHOOK_URL="$telegram_url" webhook-registration --preview
"${telegram_compose[@]}" --profile operations run --rm -T \
  -e TELEGRAM_WEBHOOK_URL="$telegram_url" webhook-registration --apply
```

Вывод — JSON без URL и адресов: `status`, `port`, `ipAddressPreserved`, `maxConnections`,
`addedUpdates`, `removedUpdates`, `pendingUpdateCount`.

- `ready` — preview нашёл недостающие типы; `current` — менять нечего.
- `applied` — повторное чтение подтвердило URL, `ip_address`, `max_connections` и точный список.
- `refused` (`not_registered`, `url_mismatch`, `custom_certificate`) — регистрация не совпадает с
  ожидаемой. Остановитесь и сверьте operational record; команда её не перезаписывает.
- `not_confirmed` — ответ `setWebhook` потерян или чтение не совпало. Не повторяйте вслепую:
  выполните `--preview` и сверьте состояние.

Перед `--apply` ожидается `ipAddressPreserved: true` и `port: "88"`. Сохраните прежний
`getWebhookInfo` в operational record, как требует [webhook-relay.md](webhook-relay.md).

**Новый host без relay.** Начальная регистрация прямого webhook выполняется защищённым операторским
Bot API клиентом: `url=https://<telegram-domain>/webhooks/telegram`,
`secret_token=TELEGRAM_WEBHOOK_SECRET`, тот же список `allowed_updates`,
`drop_pending_updates=false`. Токен не помещается в CLI arguments. Повторно прочитайте
`getWebhookInfo`: точный URL, список и отсутствие ошибок доставки.

## Operations-команды

| Команда | Назначение |
| --- | --- |
| `run --rm --interactive=false migrate` | migrations собственной базы |
| `run --rm -T community-restriction --preview < decision.json` | hold/restore по решению владельца, см. [course-activation.md](course-activation.md#разбор-ограничений-и-неизвестного-исхода) |
| `run --rm -T -e TELEGRAM_WEBHOOK_URL=… webhook-registration --preview` | список обновлений webhook |

Каждая команда вызывается как `"${telegram_compose[@]}" --profile operations …` и не открывает порты.
`community-restriction` видит только сеть базы, `webhook-registration` — только внешнюю сеть.

## Совместная выкладка с Platform

Порядок сверяется с runbook Platform #527. Production пуст, реальных участников Inside ещё нет;
порядок всё равно исключает эффекты до готовности обеих сторон.

1. **Подготовка.** Точные SHA Telegram и Platform, image id, сгенерированные секреты для каждой пары
   из таблицы, id бота Tribute, реестр групп курса. Telegram migrations этого выпуска —
   `016-notifications` … `022-community-tribute-readmission`.
2. **Community mutations на паузе.** В новом `application.env` сначала:
   `TELEGRAM_COMMUNITY_CONTRACT_VERSION=inside.community-entitlement.v2`,
   `TELEGRAM_COMMUNITY_MODE=disabled`, `TELEGRAM_COMMUNITY_REMOVALS_ENABLED=false`,
   `TELEGRAM_ACTIVATION_ENABLED=false`, `TELEGRAM_NOTIFICATIONS_ENABLED=false`,
   `TELEGRAM_MARKETING_ENABLED=false`. На Platform community и activation settings отсутствуют,
   billing-worker и notifications-worker не запущены — по runbook Platform.
3. **Backup обеих баз.** Полная проверенная копия кластера (Telegram и Platform), сохранённые
   конфигурации и прежние image id в deployment record.
4. **Остановка старых поколений.** `stop app` Telegram и процессы Platform по его runbook.
5. **Platform.** Migrations, RabbitMQ с definitions, где есть principal Telegram, маршруты Caddy.
   Readiness всех процессов Platform.
6. **Telegram.** `migrate`, `up --wait app`. Проверка маршрутов: `401` без credentials на каждом POST
   из allowlist, `404` на GET, постороннем и вложенном пути, нет внешнего порта.
7. **Webhook.** `webhook-registration --preview`, затем `--apply`, итог `applied`.
8. **Привязка и Evidence.** Владелец выполняет `/start` и привязку из Platform session.
9. **Сообщество.** Telegram: `TELEGRAM_COMMUNITY_MODE=live`, оба community secret, dispatch URL,
   `TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID`, рестарт `app`. Затем Platform: три community settings и явный
   v2, рестарт api и billing-worker. Проверка: метрики `community_*` без роста `community_effects_unknown`,
   нет diagnostic прав бота; тестовая покупка владельца даёт личную ссылку и вступление.
10. **Активация.** Platform `TELEGRAM_ACTIVATION_INGRESS_SECRET`, затем Telegram
    `TELEGRAM_ACTIVATION_ENABLED=true` с URL, секретом, `PLATFORM_ACCOUNT_URL` и реестром. Проверка:
    `/start a_<code>` владельца.
11. **Уведомления.** Platform notifications-worker подключён к брокеру. Telegram
    `TELEGRAM_NOTIFICATIONS_ENABLED=true`, рестарт. Проверка: у очередей
    `telegram.notifications.subscription.v1` и `.material.v1` есть consumer, тестовое уведомление
    владельцу доставлено, `notification_result_outbox` пуст.
12. **Авторское меню и воронки.** Author authorization и content validation, проверка меню владельца.
    `TELEGRAM_MARKETING_ENABLED=true` — только по отдельному решению владельца.

Остановка идёт в обратном порядке флагами: marketing, notifications, activation, community mode.
Данные, receipts и выданные права сохраняются. Версия v1, downgrade migrations и
`TELEGRAM_COMMUNITY_REMOVALS_ENABLED=true` не используются.

Только на production проверяются: права ботов в боевой группе, id бота Tribute, доставка через relay,
TLS и ACL брокера, настоящие сообщения и вступление.

## Проверка и восстановление

Docker healthcheck запускает `dist/operations/check-readiness.js`: проверяет HTTP authentication
boundary и доступ к мигрированным таблицам собственной базы, без Telegram/Platform запросов.
Это basic readiness, а не доказательство живого reconciliation или пользовательского связывания.
Потеря upstream не превращается в fresh positive Membership Evidence.

Проверки реального исключения и возврата участника требуют отдельного согласованного тестового
субъекта; они не выполняются над произвольными участниками production группы.

Перед restore остановите app, чтобы прекратить webhook ack и отправку evidence. При восстановлении
общего кластера сначала остановите все его приложения по host runbook. Восстановите резервную копию
в отдельный volume/cluster, сохраните оригинал. До запуска Telegram проверьте наличие его database,
роли, migrations и сохранённых привязок. Восстановите согласованные credentials обоих направлений.
Не запускайте workers на изолированной recovery-копии с live delivery credentials: это создаст
второй источник сообщений/evidence. Для proof используйте все delivery modes `disabled` и
`WORKERS_ENABLED=false`, затем удалите только явно помеченные временные ресурсы.

После переключения единственного рабочего кластера поднимите app, проверьте readiness/webhook,
дождитесь нового reconciliation и подтвердите Platform flow. Старые positive observations не
продлеваются только из-за restore. В #184 запишите время восстановления и актуальность данных;
RPO/RTO относятся к реальной проверке, а не наличию этого runbook.
