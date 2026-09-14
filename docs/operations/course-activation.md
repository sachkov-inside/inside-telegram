# Эксплуатация активации курса и community v2

Этот runbook не разрешает реальные выдачи, изменение Telegram, запуск или merge.
Локальные проверки используют два приложения, отдельные PostgreSQL и synthetic Telegram authority.
Факты Tribute и полномочия реальных ботов требуют отдельного подтверждения владельца.

## Настройка

| Параметр Telegram | Назначение |
| --- | --- |
| `TELEGRAM_ACTIVATION_ENABLED` | По умолчанию false; включает durable worker и private course ingress |
| `PLATFORM_ACTIVATION_URL` | HTTPS base `/integrations/telegram/v1/subscription-activation`; loopback HTTP разрешён локально |
| `PLATFORM_ACTIVATION_SECRET` | Отдельный activation credential; совпадает с Platform ingress credential |
| `PLATFORM_ACCOUNT_URL` | Обычный browser Account URL, без токенов, query или fragment |
| `TELEGRAM_ACTIVATION_SOURCES` | JSON registry: sourceRef, chatId, policy; для confirmed_list — confirmedIdentityRefs |
| `TELEGRAM_COMMUNITY_CONTRACT_VERSION` | Явный `inside.community-entitlement.v2` на обеих сторонах |
| `TELEGRAM_COMMUNITY_REMOVALS_ENABLED` | По умолчанию false; включение требует согласованного управления группой |

Остальные linking/sign-in/community secrets и URLs остаются по действующим integration runbooks.
Platform dispatch endpoint — `/internal/billing-dispatch/authorize`. Source chat identifiers и
списки identity находятся только в защищённой конфигурации, не в Git или отчёте PR.

Перед включением: принятые версии обоих приложений, миграции, проверенный versioned corpus,
отдельные credentials, source policy владельца и проверенные права бота-администратора. Canonical
чат не меняется. Условия курса, scope тарифа и публичная продажа остаются решениями Platform/владельца.

## Согласование двух ботов

Зафиксировать для сохранённой группы, какой бот вправе исключать участника и при каком основании.
Сопоставить платные остатки Tribute с независимыми Guide/course правами. Подтвердить, что Tribute
не исключает людей, имеющих другое действующее основание. Неизвестное поведение означает, что
массовое смешанное включение и `TELEGRAM_COMMUNITY_REMOVALS_ENABLED=true` ещё не разрешены.
Протокол не считается заполненным наличием этого текста. Реальные roster/feed, полномочия,
отключение продлений и сообщения участникам проверяются отдельно по разрешению владельца.

## Разбор ограничений и неизвестного исхода

Сначала прочитать текущие desired state, revision, attempt outcomes и ограничения через локальные
операторские средства. Не изменять таблицы вручную для повторения Telegram эффекта. При `unknown`
дать reconciliation проверить фактический roster; неизвестную ссылку не создавать заново до expiry.

Для hold/restore подготовить JSON с `operationId` (UUID), `botIdentity`, opaque `accountRef`,
`identityRef`, `expectedRevision`, `action`, `actorRef`, `reason`. Не передавать реальные данные в
командной строке или логах. Передать файл через stdin:

```bash
pnpm owner:community-restriction --preview < decision.json
pnpm owner:community-restriction --apply < decision.json
```

Apply выполняет только отдельно разрешённое решение владельца. Между preview/apply изменение
revision возвращает conflict: прочитать новое состояние и заново согласовать решение. Повтор
того же operationId/payload возвращает duplicate; изменение payload конфликтует.
Restore снимает admission hold, но не создаёт entitlement: допуск всё равно требует актуального
права Platform и свежего dispatch permit. Purchase/start никогда не вызывает эту команду.

## Наблюдение и остановка

Метрики `activation_pending`, `activation_oldest_pending_seconds`, `community_due`,
`community_oldest_due_seconds`, `community_effect_backlog`, `community_effects_unknown`,
`community_admission_restricted` публикуются существующим redacted metrics endpoint.
Рост возраста сверх двух циклов требует проверки связности/credentials/provider; `needs_account`
может ожидать пользователя, а restriction требует оператора. Не выводить source payload, токены,
chat identifiers или identity в логи. Счётчик unknown не доказывает ошибку или успех Telegram.

Остановка: выключить activation flag для новых/фоновых course проверок; выключить removals для
автоматических исключений; при полном останове community отключить live mode. Durable attempts,
Enrollment, receipts и уже выданные права сохраняются. Не откатывать новые v2 команды на v1 и
не удалять БД. После восстановления тех же версий/credentials worker продолжает leases и exact
uncertain retries. Backup/restore выполнять штатными средствами обеих отдельных баз; перед
возобновлением проверить ограничения и неизвестные эффекты. Это не включает recurring payments.

## Локальная проверка

`pnpm check:full` использует настоящую Telegram PostgreSQL, portable corpus и сценарии потери
ответов/lease/identity/moderation. `pnpm proof:course:provider` запускает обычный AppModule с
заменой только внешнего Telegram. Процесс требует literal synthetic token, loopback адреса и
отдельную тестовую базу. `/proof/source` управляет synthetic source/roster; `/proof/state` читает
только synthetic исходящие сообщения и эффекты. Само право выдаётся реальной Platform по HTTP.

Platform запускается своей принятой версией, со своей БД и локальным Logto. Настроить linking,
sign-in, activation, community v2 и dispatch; запустить API, Web и billing worker. Использовать
локальный email sink/Logto и synthetic owner bootstrap. Владелец создаёт тариф и правило через
обычный UI; consumer не импортирует Platform source, не пишет в её БД и не подставляет binding.
Проверить новый и существующий Account в desktop/mobile browser, bot-provided Account URL,
долговечное продолжение после linking, кабинет/чтение, own-access, личный join request и отказ
чужой ссылке. Остановить только созданные для проверки процессы/контейнеры, сохранив артефакты.

Воспроизводимые browser commands для отдельного loopback стенда:

```bash
pnpm exec playwright install chromium
COURSE_PROOF_USER=6400101 COURSE_PROOF_OUTPUT=/tmp/course-proof-desktop pnpm proof:course:browser
COURSE_PROOF_USER=6400102 COURSE_PROOF_OUTPUT=/tmp/course-proof-mobile COURSE_PROOF_MOBILE=true pnpm proof:course:browser
COURSE_PROOF_USER=6400103 COURSE_PROOF_OUTPUT=/tmp/course-proof-nonmember COURSE_PROOF_SOURCE=left pnpm proof:course:browser
COURSE_PROOF_USER=6400104 COURSE_PROOF_OUTPUT=/tmp/course-proof-existing pnpm proof:course:existing
```

Каждый новый прогон использует новый synthetic user. Адреса намеренно фиксированы: Platform Web
3600/API 3601, Telegram 3606, локальный Logto `identity.inside.localhost:3631`, Mailpit 3625/SMTP
3626, локальный банковский двойник 38090. Они не являются адресами production. Browser runner
требует published rule `course64`, source `course64`, owner-created tier «Курс 64 · локальная
практика» со scope seeded guide `platform-inside` и membership материалом
`developer-pipeline-bez-poteri-konteksta`. Тариф назначается за курс без даты окончания.

Для `proof:course:existing` дополнительно включить штатный Platform `TBANK_PROVIDER_MODE=test`,
его loopback API/notification/return URLs и локальный billing-contact SMTP. Seeded разовая покупка
руководства должна быть доступна. Runner создаёт email Account через Logto, подтверждает email
для чека в Mailpit, проводит покупку через локальный hosted bank double, сохраняет отметку чтения,
затем связывает курс через BFF. Сравниваются прежние paid grounds, notices, профиль и progress;
добавленное course основание ожидаемо отличается. Ни фиктивный Account, ни готовый grant в БД
не подставляются. Артефакты остаются за пределами Git; отчёт публикует только отобранные synthetic
скриншоты и результаты без auth cookies и токенов.
