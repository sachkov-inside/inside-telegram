# Постоянный Telegram provider

Комплект из #22 запускает один процесс HTTP и его фоновые обработчики. Platform остаётся
единственным владельцем решений о доступе. Операционный запуск и общая пользовательская проверка
сходятся в #45 и sachkov-inside/platform#355; этот документ не объявляет её завершённой.

## Подготовка

Нужны Docker Engine/Compose, Caddy с HTTPS, доступный PostgreSQL 18 и проверенная резервная копия.
Telegram получает отдельную базу `inside_telegram` с отдельной login-ролью `telegram_owner` без
superuser, createdb и createrole. Роль владеет только своей базой. Отзовите PUBLIC CONNECT на других
прикладных базах кластера и убедитесь, что Telegram не может к ним подключиться. Пароль роли
передавайте через защищённый административный канал, без shell arguments/history и журналирования.
Database входит в резервную копию кластера pgBackRest. App не читает таблицы Platform или Logto.

Создайте root-owned `/etc/inside/telegram` с mode `0700`. `application.env` — копия корневого
`.env.example`, заполненная реальными значениями, mode `0600`. `compose.env` берётся из
`infra/production/compose.env.example` с теми же правами. Секреты и chat id остаются вне Git;
зашифруйте файлы для host и отдельного recovery identity и проверьте обратную расшифровку.

Для live окружения:

- `DATABASE_URL` указывает только на Telegram database и её роль через внутреннюю Docker network.
- `TELEGRAM_BOT_TOKEN` принадлежит dedicated production bot; `TELEGRAM_CANONICAL_CHAT_ID` — один
  закрытый chat, подтверждённый владельцем. Проверьте `getMe`, `getChat` и `getChatMember` для самого
  бота: статус `administrator`, без дополнительных moderation rights.
- `TELEGRAM_DELIVERY_MODE`, `TELEGRAM_MEMBERSHIP_MODE`, `PLATFORM_EVIDENCE_DELIVERY_MODE` равны `live`.
- `WORKERS_ENABLED=true`; `TELEGRAM_MEMBERSHIP_RECONCILIATION_CADENCE_MS=240000`.
- `PLATFORM_INTEGRATION_SECRET` совпадает с Platform `TELEGRAM_LINKING_SECRET`.
- `PLATFORM_EVIDENCE_DELIVERY_SECRET` совпадает с Platform `TELEGRAM_EVIDENCE_INGRESS_SECRET` и
  отличается от linking secret. Оба — случайные base64url credentials длиной не менее 32 символов.
- `PLATFORM_EVIDENCE_DELIVERY_URL` — HTTPS endpoint Platform
  `/integrations/telegram/v1/membership-evidence`.
- `TELEGRAM_WEBHOOK_SECRET` — третье независимое случайное значение; его алфавит — base64url.
- `TELEGRAM_MARKETING_ENABLED=false`: выпуск Membership/sign-in не включает рассылки и воронки.
- Тексты welcome/link/status заполняются по-русски. Они предназначены для личного диалога с ботом.

### Подготовка входа через бота

До готовности обоих consumers оставьте `TELEGRAM_SIGN_IN_ENABLED=false`. Настройте
`TELEGRAM_SIGN_IN_INTEGRATION_SECRET`: отдельный случайный base64url credential от 32 символов,
отличный от linking/evidence/webhook secrets. Он совпадает с одноимённым secret Platform API и
credential Telegram connector в Logto. Значение не передаётся браузеру и не попадает в журналы.

Logto использует POST `/integrations/identity/v1/sign-in` для регистрации и
`/integrations/identity/v1/sign-in/<requestRef>/status`, `/consume` для завершения проверки.
Platform API использует `/integrations/identity/v1/sign-in/<requestRef>/account-link`.
Base URL обоих клиентов — `https://<telegram-domain>`. Серверный callback Logto в Platform
`/integrations/telegram/v1/sign-in/linked-identity` настраивается на стороне Platform.

После совместной подготовки Logto, Platform и provider включите sign-in и перезапустите
единственный app. Отключение — `TELEGRAM_SIGN_IN_ENABLED=false` с перезапуском; не удаляйте
sign-in subjects или связи. Уже открытые запросы окончательно истекают через пять минут.
Реальное подтверждение входа и Membership проверяются совместно в #45 и Platform #355.

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

Команды выполняются на VPS. Сохраните host-owned `/etc/inside/telegram/compose.override.yaml`,
если он существует: текущий production использует его для Telegram transport через relay.
Не заменяйте его шаблоном и не выводите разрешённую Compose-конфигурацию с секретами.
Перед обновлением сверяйте transport и обе версии конфигурации с deployment record.
Следующие команды требуют override и включают его во все операции, в том числе migration и recovery;
на текущем relay-host отсутствие файла — повод остановиться и восстановить конфигурацию.
Для нового host без relay нужен отдельный проверенный transport-план; команды ниже относятся к текущему production.

```bash
(
set -e
test -f /etc/inside/telegram/compose.override.yaml
telegram_compose=(docker compose --env-file /etc/inside/telegram/compose.env
  -f /opt/inside/telegram/compose.yaml
  -f /etc/inside/telegram/compose.override.yaml)
"${telegram_compose[@]}" config --quiet
"${telegram_compose[@]}" stop app
"${telegram_compose[@]}" --profile operations run --rm --interactive=false migrate
"${telegram_compose[@]}" up --detach --no-build --wait app
)
```

При ошибке migration или readiness остановитесь и сохраните диагностику без секретов. Старые
workers должны быть остановлены до migration: два поколения не работают одновременно. При
обновлении предварительно сделайте backup и сохраните прежнюю конфигурацию/image id. Автоматический
rollback и downgrade migrations не выполняются; повтор той же версии идемпотентно проверяет
применённые migrations. `restart: unless-stopped` возвращает запущенный сервис после reboot;
явно остановленный maintenance-сервис требует явного `up`.

## HTTPS и webhook

Возьмите `infra/production/telegram.caddy.example`, замените hostname на отдельный production
домен с DNS на VPS и при необходимости loopback port. Проверьте Caddy config перед reload.
Наружу принимаются только POST webhook, identity-linking и sign-in routes из точного allowlist;
секреты проверяет приложение. Reference занимает один сегмент пути; вложенные пути не допускаются.
Остальные пути дают `404`, порт приложения доступен только на `127.0.0.1`. Caddy access logging
для этого сайта не включается: URL подтверждения содержит opaque transaction reference.

Platform `TELEGRAM_LINKING_ENDPOINT` указывает на HTTPS
`https://<telegram-domain>/integrations/platform/v1/identity-links`, а `TELEGRAM_BOT_START_URL` —
на подтверждённый username production bot. Не используйте temporary proof callback.

После успешного TLS и readiness вызовите Telegram `setWebhook` через защищённый операторский API
клиент: `url=https://<telegram-domain>/webhooks/telegram`, `secret_token=TELEGRAM_WEBHOOK_SECRET`,
`allowed_updates=["message","chat_member","my_chat_member","callback_query"]`, `drop_pending_updates=false`.
Это начальная настройка прямого webhook. Если production использует
[входной relay](webhook-relay.md), сохраняйте его зарегистрированные URL с портом 88
и `ip_address` из актуального operational record. Обычный деплой приложения не
возвращает webhook на прямой маршрут.
`callback_query` supports the separately gated [bot sign-in provider](../specifications/bot-sign-in-v1.md).
Updating webhook registration remains an explicit owner operation; this change does not perform it.
Токен не помещается в CLI arguments. Повторно прочитайте `getWebhookInfo`: exact URL, allowed updates,
отсутствие ошибок доставки. Webhook не настраивается при сборке image или каждом рестарте.

## Проверка и восстановление

Docker healthcheck запускает `dist/operations/check-readiness.js`: проверяет HTTP authentication
boundary и доступ к мигрированным таблицам собственной базы, без Telegram/Platform запросов.
Это basic readiness, а не доказательство живого reconciliation или пользовательского связывания.
Потеря upstream не превращается в fresh positive Membership Evidence.

Проверьте отказ `401` на каждом разрешённом POST endpoint без credentials, `404` на GET тех же
путей, постороннем и вложенном пути, а также отсутствие
открытого внешнего порта. Затем владелец выполняет обычный `/start` и связывание из authenticated
Platform session. Проверяются сохранённая привязка, подтверждение членства и evidence на Platform.
Проверки реального исключения/возврата участника требуют отдельного согласованного тестового субъекта;
они не выполняются над произвольными участниками production группы.

Перед restore остановите app, чтобы прекратить webhook ack и отправку evidence. При восстановлении
общего кластера сначала остановите все его приложения по host runbook. Восстановите резервную копию
в отдельный volume/cluster, сохраните оригинал. До запуска Telegram проверьте наличие его database,
роли, migrations и сохранённых привязок. Восстановите согласованные credentials обоих направлений.
Не запускайте workers на изолированной recovery-копии с live delivery credentials: это создаст
второй источник сообщений/evidence. Для proof используйте все delivery modes `disabled` и
`WORKERS_ENABLED=false`, затем удалите только явно помеченные временные ресурсы.

После переключения единственного рабочего кластера поднимите app, проверьте readiness/webhook,
дождитесь нового reconciliation и подтвердите Platform flow. Старые positive observations не
продлеваются только из-за restore. В #45 запишите время восстановления и актуальность данных;
RPO/RTO относятся к реальной проверке, а не наличию этого runbook.
