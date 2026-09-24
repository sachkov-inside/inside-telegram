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
случайное base64url значение длиной от 32 до 256 символов. Приложение отказывается стартовать с
более коротким секретом и при повторе секрета между любыми двумя направлениями.

| Группа | Telegram | Значение на выпуске | Пара на стороне Platform |
| --- | --- | --- | --- |
| Процесс | `DATABASE_URL`, `WORKERS_ENABLED` | внутренняя сеть БД; `true` | — |
| Бот | `TELEGRAM_BOT_IDENTITY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CANONICAL_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | dedicated production bot; одна общая группа | `TELEGRAM_BOT_START_URL` |
| Ответы в личном чате | `TELEGRAM_DELIVERY_MODE` и тексты `TELEGRAM_*_TEXT` | `live`; тексты по-русски | — |
| Привязка | `PLATFORM_INTEGRATION_SECRET` | секрет | `TELEGRAM_LINKING_SECRET`; `TELEGRAM_LINKING_ENDPOINT=https://<telegram>/integrations/platform/v1/identity-links` |
| Communications API | `PLATFORM_COMMUNICATIONS_SECRET` | отдельный секрет; без него API отвечает 401 | `TELEGRAM_COMMUNICATIONS_SECRET`; `TELEGRAM_COMMUNICATIONS_ENDPOINT=https://<telegram>/integrations/platform/v1/communications` |
| Membership Evidence | `TELEGRAM_MEMBERSHIP_MODE`, `TELEGRAM_MEMBERSHIP_RECONCILIATION_CADENCE_MS`, `PLATFORM_EVIDENCE_DELIVERY_MODE`, `PLATFORM_EVIDENCE_DELIVERY_URL`, `PLATFORM_EVIDENCE_DELIVERY_SECRET` | `live`, `240000`, `live`, `https://<platform>/integrations/telegram/v1/membership-evidence` | `TELEGRAM_EVIDENCE_INGRESS_SECRET` |
| Вход через бота | `TELEGRAM_SIGN_IN_ENABLED`, `TELEGRAM_SIGN_IN_INTEGRATION_SECRET` | `false` до готовности Logto и Platform | `TELEGRAM_SIGN_IN_INTEGRATION_SECRET` |
| Сообщество v2 | `TELEGRAM_COMMUNITY_CONTRACT_VERSION`, `TELEGRAM_COMMUNITY_MODE`, `TELEGRAM_COMMUNITY_RECONCILIATION_CADENCE_MS`, `TELEGRAM_COMMUNITY_REMOVALS_ENABLED`, `TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID` | `inside.community-entitlement.v2`, `live`, `60000`, `false`, id бота Tribute | `TELEGRAM_COMMUNITY_CONTRACT_VERSION=inside.community-entitlement.v2` |
| Сообщество: входящие команды | `PLATFORM_COMMUNITY_INTEGRATION_SECRET` | секрет | `TELEGRAM_COMMUNITY_ENTITLEMENT_SECRET`, `TELEGRAM_COMMUNITY_ENTITLEMENT_ENDPOINT=https://<telegram>/integrations/platform/v1/community-entitlements` |
| Сообщество: разрешение эффекта | `PLATFORM_COMMUNITY_DISPATCH_URL`, `PLATFORM_COMMUNITY_DISPATCH_SECRET` | `https://<platform>/internal/billing-dispatch/authorize` | `TELEGRAM_COMMUNITY_DISPATCH_SECRET` |
| Активация курса и Tribute | `TELEGRAM_ACTIVATION_ENABLED`, `PLATFORM_ACTIVATION_URL`, `PLATFORM_ACTIVATION_SECRET`, `PLATFORM_ACCOUNT_URL`, `TELEGRAM_ACTIVATION_SOURCES` | `https://<platform>/integrations/telegram/v1/subscription-activation`; Account URL; реестр групп курса | `TELEGRAM_ACTIVATION_INGRESS_SECRET` |
| Уведомления | `TELEGRAM_NOTIFICATIONS_ENABLED`, `NOTIFICATION_AMQP_URL`, `NOTIFICATION_AUTHORIZE_URL`, `NOTIFICATION_AUTHORIZE_SECRET`, `NOTIFICATION_QUARANTINE_KEY`, `NOTIFICATION_PREFETCH`, `NOTIFICATION_BATCH_SIZE` | AMQPS principal Telegram; `https://<platform>/internal/notifications/dispatch/authorize`; ключ 64 hex | `NOTIFICATIONS_TELEGRAM_SECRET`; principal и vhost из topology Platform |
| Авторское меню, воронки, рассылки | `PLATFORM_AUTHOR_AUTHORIZATION_URL`, `PLATFORM_AUTHOR_AUTHORIZATION_SECRET`, `PLATFORM_AUTHOR_CONTENT_VALIDATION_URL`, `TELEGRAM_MARKETING_ENABLED` | `https://<platform>/integrations/telegram/v1/communications/authorize` и `/validate-content`; `false` | `TELEGRAM_AUTHOR_AUTHORIZATION_SECRET`, `TELEGRAM_COMMUNICATIONS_BOT_IDENTITY` |
| Переходы по ссылкам | `PLATFORM_TRACKING_REDIRECT_URL`, `PLATFORM_TRACKING_TARGET_PREFIXES` | `PLATFORM_TRACKING_REDIRECT_URL=https://<platform>/communications/visit`; `["https://<platform>/materials/","https://<platform>/series/"]` | `TELEGRAM_TRACKING_ORIGIN=https://<platform>` |

Явные отказы при старте:

- `TELEGRAM_COMMUNITY_CONTRACT_VERSION` с любым значением, кроме v2;
- настроенное сообщество (live, любой community secret или dispatch URL) без явной версии;
- секрет короче 32 символов, включая `TELEGRAM_WEBHOOK_SECRET`;
- live-режим без токена бота; неполная пара URL и секрета; HTTP вне loopback, учётные данные,
  query или fragment в URL сервиса, включая `PLATFORM_EVIDENCE_DELIVERY_URL`;
- `TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID`, совпадающий с id самого бота или не числовой;
- один и тот же секрет в двух направлениях: ошибка называет обе переменные;
- флаг, отличный от `true`/`false`: ошибка называет переменную.

Переход на отдельный секрет communications API ([#80](https://github.com/sachkov-inside/inside-telegram/issues/80)):
до этого выпуска `PLATFORM_INTEGRATION_SECRET` проверял и привязку, и communications. При выкладке
задайте новое случайное значение в `PLATFORM_COMMUNICATIONS_SECRET` и то же значение в Platform
`TELEGRAM_COMMUNICATIONS_SECRET`. Пока пара не совпадает, communications API отвечает 401, а привязка
продолжает работать. Перед выкладкой убедитесь, что все секреты не короче 32 символов.

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

## Выпуск и выкладка

Обычный выпуск идёт без ручных команд на сервере: `main` → версия `vN` → production → проверки →
при необходимости откат. Каждый запуск `release.yml` и `deploy.yml` — действие владельца или
координатора с его разрешением. Путь повторяет Platform; у Telegram один процесс `app` и одноразовый
`migrate`.

### 1. Выпуск версии

Actions → **Publish ordinal release** → `version` = следующий `vN` (первый — `v1`). Workflow:

- проверяет, что `vN` — следующий номер без пропусков, прежние версии неизменяемы, а запуск идёт
  с текущего `main`;
- прогоняет Application CI на этом SHA;
- собирает `infra/production/Dockerfile` с `SOURCE_COMMIT`, публикует
  `ghcr.io/sachkov-inside/inside-telegram:vN` и проверяет анонимный pull по digest;
- создаёт неизменяемый GitHub Release `vN` с target = SHA и тремя ассетами: `compose.yaml` (копия
  `infra/production/compose.yaml`), `telegram.caddy` (копия `infra/production/telegram.caddy`) и
  `release-manifest.json`.

Manifest (`inside.telegram.release-manifest.v1`) связывает версию, SHA, образ
`ghcr.io/sachkov-inside/inside-telegram@sha256:…`, sha256 файлов `compose.yaml` и `telegram.caddy`,
run публикации и
идентичность миграций: sha256 от упорядоченного списка файлов `src/database/migrations` и их
содержимого (`node scripts/release-contract.mjs migrations-identity`). Одинаковая идентичность у двух
версий значит одинаковую схему базы.

### 2. Выкладка

Actions → **Deploy production release** → `operation` = `deploy`, `version` = `vN`. Job работает в
environment `Production`, ещё раз сверяет Release, manifest, `compose.yaml`, `telegram.caddy` и run
публикации и передаёт три файла по SSH пользователю `inside-telegram-deploy`. На сервере forced command запускает
только gateway `/usr/local/libexec/inside/inside-telegram-deploy`. Выкладки встают в очередь; активная
не отменяется.

Gateway принимает только `deploy vN <run-id>` и `rollback vN <run-id>` и вход до 1 MiB. Он повторно
читает Release с GitHub по HTTPS и принимает manifest, только если тот побайтно совпадает с ассетом
неизменяемого Release, а run публикации — успешный `release.yml` с `main`. Вход читается целиком до
блокировки; одновременно идёт одна операция (`flock`). Порядок `deploy`:

1. preflight: `/etc/inside/telegram/compose.env`, `application.env`, `compose.override.yaml`,
   `/etc/caddy/Caddyfile` и `/srv/inside/runtime/caddy/` на месте, `docker compose config --quiet`
   проходит;
2. `docker pull` образа по digest;
3. файлы версии сохраняются в `/srv/inside/telegram/releases/vN/`; одну версию нельзя сохранить с
   другим содержимым;
4. `stop app` → `migrate` (профиль `operations`) → `up --detach --no-build --wait app`;
5. `GET http://127.0.0.1:<порт>/ready` отвечает `200`; порт — фактическая публикация `app`
   (`docker compose port app 3002`), то есть `TELEGRAM_LOOPBACK_PORT`;
6. маршруты: `telegram.caddy` версии должен проксировать на этот порт; он атомарно заменяет
   `/srv/inside/runtime/caddy/telegram.caddy` (его импортирует host `Caddyfile`), затем
   `caddy validate` и `caddy reload`. Отказ `validate` возвращает прежний файл, работающий Caddy
   не трогается. Отказ `reload` возвращает прежний файл и перезагружает Caddy с ним. В обоих
   случаях операция завершается ошибкой в фазе `routes`, вывод Caddy остаётся на сервере в
   `/var/lib/inside/telegram-deployments/caddy-last.log`. Неизменённый фрагмент не
   перезагружается. Порт в фрагменте сверяется с Compose ещё на preflight;
7. `/var/lib/inside/telegram-deployments/state.json` получает `current` и `previous`: версия, SHA,
   образ, идентичность миграций, sha256 manifest, run id и время.

Каждая compose-команда gateway использует три файла: `--env-file /etc/inside/telegram/compose.env
-f /srv/inside/telegram/releases/vN/compose.yaml -f /etc/inside/telegram/compose.override.yaml`.
Образ передаётся переменной процесса `TELEGRAM_IMAGE=<image@digest>`: она сильнее значения в
`compose.env`. Host-owned `compose.env`, `application.env` и override gateway не переписывает.
Override обязателен: в нём transport до `api.telegram.org` через relay и сеть брокера.

Каждая фаза и итог операции пишутся в `/var/lib/inside/telegram-deployments/operation.json`.
Перед `migrate` gateway создаёт `migration-guard.json`; его удаляет только успешная операция. Пока он
есть, разрешены лишь операции с тем же набором миграций или deploy более новой версии, даже если
прежний запуск был прерван. Сбой после
`stop app` оставляет app остановленным, диагностику — в `operation.json` и журнале job; данные и
тома gateway не трогает, job завершается ошибкой. Сбой миграций чинится повтором той же версии или
более новой версией. Повтор той же версии идемпотентен: если она уже `current`, gateway только
поднимает app, проверяет readiness и маршруты, без остановки и миграций. Deploy версии не новее текущей
отклоняется: для возврата есть только rollback.

### 3. Проверки после выкладки

- Job **Deploy production release** зелёный, в конце `deploy vN succeeded: <image@digest>`.
- На сервере `jq . /var/lib/inside/telegram-deployments/state.json` показывает `current.version`
  = `vN`, `operation.json` — `status: succeeded`.
- Маршруты: `401` без credentials на каждом POST из allowlist, `404` на GET, постороннем и вложенном
  пути ([HTTPS и маршруты](#https-и-маршруты)).
- `GET http://127.0.0.1:<port>/metrics` на сервере — без роста ошибок доставки.

### 4. Откат

Actions → **Deploy production release** → `operation` = `rollback`, `version` = `previous.version`
из `state.json`. Gateway возвращает только записанную предыдущую версию и только если идентичность
её миграций совпадает с текущей: миграции вниз не выполняются, `migrate` при откате не запускается.
Иначе откат отклоняется с ошибкой `migration sets differ`; путь — repair forward: исправление в
`main`, новая версия `vN+1`, её deploy. Тот же отказ действует после сбоя операции, которая могла
успеть применить миграции другой версии.

После отката `previous` пуст: следующий шаг — обычный deploy новой или той же отменённой версии.
Повтор того же rollback идемпотентен. Первый deploy через gateway не имеет `previous`: откатить его
нельзя.

### Команды оператора на текущей версии

Operations-команды ниже ([webhook](#webhook), [operations-команды](#operations-команды),
[community-restriction](course-activation.md#разбор-ограничений-и-неизвестного-исхода)) используют
Compose и образ текущей версии:

```bash
telegram_state=/var/lib/inside/telegram-deployments/state.json
telegram_version=$(jq --raw-output .current.version "$telegram_state")
export TELEGRAM_IMAGE=$(jq --raw-output .current.image "$telegram_state")
telegram_compose=(docker compose --env-file /etc/inside/telegram/compose.env
  -f "/srv/inside/telegram/releases/$telegram_version/compose.yaml"
  -f /etc/inside/telegram/compose.override.yaml)
```

Не выполняйте `up` для `app` вручную без этого `TELEGRAM_IMAGE`: иначе Compose возьмёт устаревшее
значение из `compose.env`.

### Разовая установка

Выполняется один раз до первого выпуска; повторный запуск установщика безопасен.

**GitHub (координатор с правами администратора репозитория):**

1. Settings → General → Releases → включить **immutable releases**.
   Workflow не читает эту настройку заранее: `GITHUB_TOKEN` не может запросить нужное право
   Administration: read, а отдельный токен владельца сделал бы выпуск зависимым от него. Вместо
   этого `release.yml` проверяет результат: после `gh release create` он читает `isImmutable`
   созданного Release. Если Release получился изменяемым, workflow удаляет его вместе с тегом и
   падает с просьбой включить immutable releases; после включения тот же `vN` запускается снова.
   Изменяемый Release в любом случае не выкладывается: его отклоняют и `deploy.yml`, и gateway.
2. Environment `Production` с required reviewer владельца, deployment branches — только `main`, и
   secrets:
   - `PRODUCTION_SSH_HOST` — адрес VPS;
   - `PRODUCTION_SSH_PRIVATE_KEY` — приватная часть отдельного ключа Ed25519 только для Telegram;
   - `PRODUCTION_SSH_HOST_KEYS` — строки `known_hosts` VPS, сверенные с отпечатком из консоли
     провайдера, а не с первым подключением.
3. После первого push образа: Package `inside-telegram` → Package settings → Change visibility →
   **Public**, затем Re-run failed jobs. До этого шаг «Prove anonymous pull by digest» падает.

**Ключ** создаётся на машине координатора и не попадает в Git, журналы или чат:

```bash
ssh-keygen -t ed25519 -N '' -C inside-telegram-deploy -f inside-telegram-deploy
```

`inside-telegram-deploy` → `PRODUCTION_SSH_PRIVATE_KEY`, затем удалите локальную копию приватного
ключа; `inside-telegram-deploy.pub` → на сервер.

**Сервер (root, из чистого checkout смёрженного commit).** Нужны `docker` с Compose v2, `jq`,
`curl`, `flock`, `sudo`, `openssh-server`, host Caddy с `import /srv/inside/runtime/caddy/*.caddy` в
`/etc/caddy/Caddyfile` и `/etc/inside/telegram` с `compose.env`, `application.env` и
`compose.override.yaml` из разделов выше. `TELEGRAM_LOOPBACK_PORT` в `compose.env` совпадает с портом
в `infra/production/telegram.caddy` (`3303`), иначе deploy остановится в фазе `routes`.

```bash
git clone https://github.com/sachkov-inside/inside-telegram.git /tmp/inside-telegram-install
git -C /tmp/inside-telegram-install checkout --detach <merged-sha>
bash /tmp/inside-telegram-install/infra/production/deploy/install-deploy-access.sh \
  /root/inside-telegram-deploy.pub
rm -rf /tmp/inside-telegram-install /root/inside-telegram-deploy.pub
```

Установщик создаёт пользователя `inside-telegram-deploy` с заблокированным паролем, кладёт gateway в
`/usr/local/libexec/inside/inside-telegram-deploy` (root, `0755`), sudoers-правило
`/etc/sudoers.d/inside-telegram-deploy` ровно на этот файл с сохранением `SSH_ORIGINAL_COMMAND` и
`authorized_keys` с `restrict,command="sudo -n /usr/local/libexec/inside/inside-telegram-deploy"`.
Обновление gateway — тот же запуск из checkout новой версии.

Проверка доступа без выкладки: `ssh -i inside-telegram-deploy inside-telegram-deploy@<host> status`
отвечает `Rejected restricted command` и ничего не меняет.

Прежний `/opt/inside/telegram/compose.yaml` больше не используется. Project name
`inside-production-telegram` общий, поэтому первый deploy через gateway останавливает контейнер,
запущенный вручную, и заменяет его. Тот же deploy заменяет вручную созданный
`/srv/inside/runtime/caddy/telegram.caddy` фрагментом версии; прежний файл сохраняется только на
время проверки Caddy.

### Аварийный ручной путь

> **Только при недоступности GitHub Actions или GHCR** и с отдельного разрешения владельца. После
> него `state.json` не совпадает с сервером: следующая обычная выкладка — новой версией через
> `deploy.yml`, откат gateway к ручному образу невозможен.

Используйте чистый checkout точного merged commit. Обычный агент не изменяет основной checkout
владельца.

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
Все команды включают host-owned override; его отсутствие — повод остановиться.

```bash
export TELEGRAM_IMAGE=<sha256:image-id>
telegram_compose=(docker compose --env-file /etc/inside/telegram/compose.env
  -f infra/production/compose.yaml
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
workers должны быть остановлены до migration: два поколения не работают одновременно.
`restart: unless-stopped` возвращает запущенный сервис после reboot; явно остановленный
maintenance-сервис требует явного `up`.

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

### Relay для operations-команд

На production исходящий трафик к `api.telegram.org` идёт через relay `telegram-transport`
([webhook-relay.md](webhook-relay.md)): override добавляет `app` запись в `/etc/hosts` и сеть
relay. Одноразовые команды профиля `operations`, которые обращаются к Bot API, получают тот же
маршрут, иначе они не доходят до Telegram и останавливаются без подробностей:

```yaml
services:
  webhook-registration:
    extra_hosts:
      - "api.telegram.org:<адрес relay, как у app>"
    networks:
      egress: {}
      telegram-transport: {}
```

Проверено в Workspace #184: без этого блока `webhook-registration --preview` на production
отвечал «Webhook registration stopped», с ним — `status` из списка ниже.

## HTTPS и маршруты

Маршруты задаёт `infra/production/telegram.caddy` (`telegram.sachkov.dev`, loopback port `3303`).
Их ставит на сервер выкладка версии ([шаг 6](#2-выкладка)); ручная правка
`/srv/inside/runtime/caddy/telegram.caddy` будет заменена следующей выкладкой.
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

Выпуск Platform #527 публикует в `platform.caddy` точные маршруты для каждого из этих адресов, включая
`communications/authorize` и `communications/validate-content`; остальные `/integrations/*` отвечают
`404`. Переходы по ссылкам воронок идут не от Telegram, а от читателя: публичный GET
`https://<platform>/communications/visit?token=<opaque>` обслуживает web Platform. Неизвестный токен
даёт `404`, найденный — `302` на материал или серию, недоступный provider или отсутствующий
`TELEGRAM_TRACKING_ORIGIN` — `503`.

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

1. **Подготовка.** Версии Telegram и Platform (`vN`, SHA и образ по digest из их release manifest),
   сгенерированные секреты для каждой пары из таблицы, id бота Tribute, реестр групп курса.
   [Разовая установка](#разовая-установка) Telegram выполнена. Telegram migrations этого выпуска —
   `016-notifications` … `022-community-tribute-readmission`.
2. **Community mutations на паузе.** В новом `application.env` сначала:
   `TELEGRAM_COMMUNITY_CONTRACT_VERSION=inside.community-entitlement.v2`,
   `TELEGRAM_COMMUNITY_MODE=disabled`, `TELEGRAM_COMMUNITY_REMOVALS_ENABLED=false`,
   `TELEGRAM_ACTIVATION_ENABLED=false`, `TELEGRAM_NOTIFICATIONS_ENABLED=false`,
   `TELEGRAM_MARKETING_ENABLED=false`. На Platform нет `TELEGRAM_COMMUNITY_*` и
   `TELEGRAM_ACTIVATION_INGRESS_SECRET`; остальные группы, включая оплату, notifications и
   communications, заполнены, продажа в каталоге выключена — по runbook Platform.
3. **Backup обеих баз.** Полная проверенная копия кластера (Telegram и Platform), сохранённые
   конфигурации и прежние образы в deployment record.
4. **Остановка старых поколений.** `stop app` Telegram, если он уже запущен
   ([команды оператора](#команды-оператора-на-текущей-версии)); deploy Platform включает maintenance и
   дренирует воркеры прежнего выпуска до migrations.
5. **Platform.** Migrations, RabbitMQ с definitions, где есть principal Telegram, затем api, mcp,
   воркеры, включая billing-worker и notifications-worker, и web; маршруты Caddy. Readiness всех
   процессов Platform. С этого шага notifications-worker публикует в очереди Telegram; до шага 11
   их никто не читает: при 1000 сообщений очередь отклоняет публикацию, и команды ждут в outbox
   Platform без потерь.
6. **Telegram.** `deploy.yml` `deploy vN`: gateway выполняет `migrate`, `up --wait app` и `/ready`
   ([выкладка](#2-выкладка)). Проверка маршрутов: `401` без credentials на каждом POST
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
11. **Уведомления.** Platform notifications-worker подключён к брокеру с шага 5. Telegram
    `TELEGRAM_NOTIFICATIONS_ENABLED=true`, рестарт. Проверка: у очередей
    `telegram.notifications.subscription.v1` и `.material.v1` есть consumer, тестовое уведомление
    владельцу доставлено, `notification_result_outbox` пуст.
12. **Авторское меню и воронки.** Маршруты Platform опубликованы с шага 5. Author authorization,
    content validation и переходы по [таблице](#конфигурация), рестарт; проверка меню владельца.
    Переходы: GET `https://<platform>/communications/visit?token=` с несуществующим токеном
    правильного формата (43 символа `A`) отвечает `404`: запрос дошёл до provider. `503` означает
    недоступный provider или отсутствующий `TELEGRAM_TRACKING_ORIGIN`; `503` на настоящей ссылке —
    ещё и хост в `PLATFORM_TRACKING_*`, отличный от `TELEGRAM_TRACKING_ORIGIN`.
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
