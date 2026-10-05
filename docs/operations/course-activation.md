# Эксплуатация активации курса и community v2

Этот runbook не разрешает реальные выдачи, изменение Telegram, запуск или merge.
Локальные проверки используют два приложения, отдельные PostgreSQL и synthetic Telegram authority.
Факты Tribute и полномочия реальных ботов требуют отдельного подтверждения владельца.

## Настройка

| Параметр Telegram | Назначение |
| --- | --- |
| `TELEGRAM_ACTIVATION_ENABLED` | По умолчанию false; включает durable worker и private course ingress |
| `PLATFORM_ACTIVATION_URL` | HTTPS base `/integrations/telegram/v1/subscription-activation`; loopback HTTP разрешён локально. Приглашения `i_` идут на соседний `/integrations/telegram/v1/invitations/redeem`, поэтому путь должен заканчиваться на `/subscription-activation` |
| `PLATFORM_ACTIVATION_SECRET` | Отдельный activation credential; совпадает с Platform ingress credential |
| `PLATFORM_ACCOUNT_URL` | Обычный browser Account URL, без токенов, query или fragment |
| `TELEGRAM_ACTIVATION_SOURCES` | JSON registry: sourceRef, chatId, policy; для confirmed_list — confirmedIdentityRefs |
| `TELEGRAM_COMMUNITY_CONTRACT_VERSION` | Явный `inside.community-entitlement.v2` на обеих сторонах; другое значение или его отсутствие при настроенном сообществе — отказ при старте |
| `TELEGRAM_COMMUNITY_REMOVALS_ENABLED` | `true` в production по решению владельца 04.10.2026 (platform#907): бот Inside исключает человека, когда Platform присылает `denied`. При `false` бот никого не исключает |
| `TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID` | Числовой id бота Tribute; его исключения — окончание подписки Tribute, а не модерация |
| `TELEGRAM_COMMUNITY_READMISSION_TEXT` | Необязательный текст личного сообщения со ссылкой для возвращения |
| `TELEGRAM_COMMUNITY_WELCOME_TEXT` | Необязательный текст приветствия со ссылкой после первого права на сообщество ([интеграция](../integrations/community-entitlements-v1.md#приветствие-после-первого-права)) |

Остальные настройки и пары секретов с Platform — в [production.md](production.md#конфигурация).
Source chat identifiers, id ботов и списки identity находятся только в защищённой конфигурации,
не в Git или отчёте PR.

Перед включением: принятые версии обоих приложений, миграции, проверенный versioned corpus,
отдельные credentials, source policy владельца и проверенные права бота-администратора. Canonical
чат не меняется. Условия курса, scope тарифа и публичная продажа остаются решениями Platform/владельца.

## Подтверждение статуса прежних участников

Прежний покупатель курса или подписчик Tribute получает права через бота только по ссылке
владельца `/start a_<code>` ([#115](https://github.com/sachkov-inside/inside-telegram/issues/115),
уточнение [#113](https://github.com/sachkov-inside/inside-telegram/issues/113), спецификация
[Workspace #238](https://github.com/sachkov-inside/workspace/issues/238)). Бот только доказывает
основание и передаёт его Platform по [протоколу активации](../integrations/subscription-activation-v1.md);
какие права выдать, решает правило активации на Platform.

**Обычный `/start`.** Ничего не проверяет, не выдаёт и не ставит в очередь разбора: человек получает
приветствие и идёт по обычным воронкам бота. Решение владельца от 27.09.2026 (#115): автопроверка при
каждом `/start` засорила бы очередь новыми читателями бесплатной главы.

**Ссылка владельца `/start a_<code>`.** Проверяется выбранное правило: членство в группе прежнего
курса (`course_membership`) или реестр Tribute (`tribute_registry`). Без привязки бот ведёт ко входу
на платформу и продолжает после связывания. Итог:

- основание подтверждено — сообщение о выданных правах с приглашением в общий чат: кнопка «Вступить в
  сообщество» выдаёт личную ссылку по Community Entitlement. Повторное нажатие не выдаёт права второй
  раз и не создаёт вторую попытку;
- основание проверено и не подтверждено (`rejected`, `pending_review`, `source_not_confirmed`,
  `identity_conflict`) — ответ по правилу ссылки с дальнейшим шагом и запись в очереди разбора
  владельца. Если Platform вернула основание Tribute в неактивном состоянии (`pending_verification`,
  `suspended_source`), ответ показывает это состояние;
- любой другой отказ Platform (`not_found`, `policy_paused`, `revision_conflict` и прочие) — вопрос
  настройки правил владельца: человек получает текст отказа, записи в очереди нет.

Ссылка перезапускает только своё правило, остальные проверки человека не трогает. Человек с уже
подтверждённым основанием не попадает в очередь из-за другого, неподтверждённого кода. Время
подтверждения хранится у попытки отдельно (`confirmed_at`): повторная проверка или сбой Platform его не
стирают, подтверждённая попытка не удаляется по сроку хранения, а её незавершённый повтор после срока
возвращается в подтверждённое состояние. Выход из группы после выдачи ничего не отзывает — бот не
наблюдает группу курса после проверки. Ссылку можно публиковать в общем чате: `/start` работает только
в личном чате, а общий чат остаётся запрещённым источником основания — реестр источников его не
принимает, и бот никогда не проверяет членство в нём.

Известное ограничение: проверка по ссылке, которая 30 дней подряд остаётся в `retry` (Platform или
Telegram недоступны) или в `needs_account` (Account не связан), удаляется по сроку хранения без ответа и
без записи в очереди; неопределённая запись evidence не удаляется, пока не будет повторена. Рост виден по
метрикам `activation_pending` и `activation_oldest_pending_seconds` из раздела «Наблюдение и остановка»;
новое нажатие кнопки запускает проверку заново.

### Кнопка владельца в группе курса

Владелец добавляет бота в группу прежнего курса, а затем отправляет в неё от имени бота сообщение
«Все участники курса получают доступ…» с кнопкой «Получить доступ». Кнопка открывает
`https://t.me/<bot>?start=a_<code>`, то есть ту же ссылку владельца. Отправляет сообщение только
владелец; агент его не отправляет.

Команда принимает `sourceRef` из `TELEGRAM_ACTIVATION_SOURCES` и код опубликованного правила Platform
для этой группы. Какую группу или реестр проверяет правило, знает только Platform: бот не сверяет код с
группой, поэтому соответствие кода и группы проверяет владелец перед `--send`. Команда отказывает
(`refused`), если активация выключена, код неверной формы, источника нет в реестре или его политика не
`whole_group`: текст обещает доступ каждому участнику.
Username бота берётся из `getMe`, chat id — из защищённой конфигурации и не печатается. Сначала
`--preview` показывает текст и ссылку кнопки, затем `--send` отправляет одно сообщение. На production
из runtime-образа:

```bash
"${telegram_compose[@]}" --profile operations run --rm -T activation-announcement --preview <sourceRef> <code>
"${telegram_compose[@]}" --profile operations run --rm -T activation-announcement --send <sourceRef> <code>
```

В checkout разработчика — `pnpm owner:activation-announcement --preview <sourceRef> <code>`. Итог
`sent` — сообщение в группе; `not_sent` с `providerErrorCode` — Telegram отказал (например, бот не
состоит в группе или не может писать); `unknown` — ответ потерян: проверьте группу, прежде чем
отправлять снова, иначе сообщение повторится. Все итоги, кроме `ready` и `sent`, завершаются с кодом 2.

**Очередь разбора.** Одна запись на человека: Telegram user id, opaque identityRef, accountRef,
итог по коду и время. Новый неподтверждённый итог по ссылке обновляет запись, подтверждённое основание
закрывает её автоматически. Решение владельца — Direct Right через owner-операции Platform; после него
запись закрывается командой. Новый неподтверждённый итог по ссылке открывает закрытую запись заново.
На production из runtime-образа:

```bash
"${telegram_compose[@]}" --profile operations run --rm -T activation-review --list
"${telegram_compose[@]}" --profile operations run --rm -T activation-review --resolve <reviewId>
```

В checkout разработчика — `pnpm owner:activation-review --list` и `--resolve <reviewId>` с
`DATABASE_URL`. `--list` печатает открытые записи по одной JSON-строке только оператору; не копируйте
их в issue, PR или журналы. `--resolve` отвечает `{"status":"resolved"}` или `not_found` с кодом 2.

Включение: коды должны быть опубликованными правилами Platform; включение активации в production —
шаг 10 [совместной выкладки](production.md#совместная-выкладка-с-platform) и решение владельца, как и
отправка сообщения с кнопкой. Проверка: `test/integration/owner-link-activation.integration.test.ts` —
обычный `/start` без проверок, кнопка ведёт к правам и приглашению, участник вне группы получает ответ
и одну запись в очереди, повтор без дубликатов, общий чат, реестр Tribute, приостановленные и
неизвестные правила; `test/unit/activation-announcement.test.ts` — текст, кнопка, ссылка и отказы.

## Два бота в общей группе

Схема действует до переноса участников Tribute и курса
([#150](https://github.com/sachkov-inside/workspace/issues/150)), после которого владелец убирает
бота Tribute. Решение владельца от 15.09.2026: бот Inside приглашает покупателей, бот Tribute
работает как раньше. Решение владельца от 04.10.2026
([platform#907](https://github.com/sachkov-inside/platform/issues/907)) включает удаления и с нашей
стороны: доступ кончился — бот Inside исключает человека из группы.

| Бот | Права в группе | Кого впускает | Кого исключает | Основание |
| --- | --- | --- | --- | --- |
| Inside | administrator: `can_invite_users`, `can_restrict_members` | держателя права Platform по его личной ссылке с заявкой | человека без действующего права Platform в момент окончания доступа (`TELEGRAM_COMMUNITY_REMOVALS_ENABLED=true`) | право Platform, community v2 |
| Tribute | прежние | новых не принимает | участника, у которого закончилась подписка Tribute | подписка Tribute |

Бот Inside различает, кто исключил человека, по событию `chat_member` и его автору:

| Кто исключил | Действующее право Platform | Что делает бот Inside |
| --- | --- | --- |
| Бот Tribute (`TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID`): ban, ban+unban или одиночный unban | есть | при необходимости снимает бан, создаёт личную ссылку и отправляет её в личный чат |
| Бот Tribute | нет | ничего; когда право появится, возвращает так же |
| Человек-модератор | любое | запрет `moderation`: автоматического unban нет |
| Неизвестный бот | любое | запрет `external_unknown`: автоматического unban нет |
| Бан замечен сверкой раньше события | любое | `external_unknown`, пока не придёт событие; событие бота Tribute снимает этот запрет |

Почему неизвестный бот не возвращает человека. В группах работают anti-spam и модераторские боты,
которые исключают по решению администраторов. Автоматический unban отменил бы их решение. Протокол
v2 запрещает автоматическое снятие бана при неизвестном происхождении. Доверие получает только бот,
явно названный в конфигурации.

Что происходит после исключения ботом Tribute:

1. Если Tribute оставил бан (`kicked`), бот Inside сначала снимает его — с обычным разрешением
   Platform на эффект. После unban человек в статусе `left` и сам в группу не возвращается.
2. Если Tribute исключил через ban и unban или одним unban, человек уже `left`: снимать нечего.
3. В обоих случаях бот создаёт личную ссылку с заявкой на 10 минут. При доступном BotContact ссылка
   уходит в личный чат один раз, с подсказкой отправить `/community` за новой ссылкой.
4. Без BotContact или при заблокированном боте сообщение не отправляется: ссылку выдают `/community`
   и путь активации в боте.
5. Заявка по этой ссылке одобряется как обычно, запрет `admissionRestriction` остаётся `none`.

Запрет модератора снимает только решение владельца через `community-restriction restore`. Событие
бота Tribute после модераторского бана запрет не меняет.

Известные ограничения схемы:

- Без `TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID` каждое исключение ботом Tribute становится
  `external_unknown`. Настройку нужно задать до `TELEGRAM_COMMUNITY_MODE=live`.
- Событие бота Tribute снимает только запрет, поставленный сверкой без известного автора бана. Запрет
  после исключения неизвестным ботом или модератором остаётся, даже если кто-то потом вручную снял бан
  и человека позже исключил бот Tribute. Снять его может только решение владельца.
- Бот Inside отклоняет заявки не по своей текущей ссылке. Это безопасно, пока бот Tribute новых
  участников не принимает. Если Tribute снова начнёт принимать заявки по своим ссылкам, бот Inside
  будет их отклонять — это нужно пересмотреть до такого изменения.
- Контракт community v2 с Platform не меняется: значения `admissionRestriction` те же.

Проверка механизма — synthetic Telegram на настоящей PostgreSQL:
`test/integration/community-v2.integration.test.ts`, блок «removal by the configured Tribute bot».
Покрыты возврат при праве, ban+unban, одиночный unban, модератор, неизвестный бот, отсутствие права и
его появление, гонка сверки и события, модераторский бан перед событием Tribute, бан неизвестного
бота с ручным unban перед событием Tribute, недоступный контакт. Ручная
проверка на тестовой группе снята решением владельца от 15.09.2026.

## Разбор ограничений и неизвестного исхода

Сначала прочитать текущие desired state, revision, attempt outcomes и ограничения через локальные
операторские средства. Не изменять таблицы вручную для повторения Telegram эффекта. При `unknown`
дать reconciliation проверить фактический roster; неизвестную ссылку не создавать заново до expiry.

Для hold/restore подготовить JSON с `operationId` (UUID v4), `botIdentity`, opaque `accountRef`,
`identityRef`, `expectedRevision`, `action`, `actorRef`, `reason`. Не передавать реальные данные в
командной строке или логах. Передать файл через stdin.

На production — из runtime-образа, в котором нет pnpm (`telegram_compose` — из
[production.md](production.md#команды-оператора-на-текущей-версии)):

```bash
"${telegram_compose[@]}" --profile operations run --rm -T community-restriction --preview < decision.json
"${telegram_compose[@]}" --profile operations run --rm -T community-restriction --apply < decision.json
```

В checkout разработчика с `DATABASE_URL` в `.env`:

```bash
pnpm owner:community-restriction --preview < decision.json
pnpm owner:community-restriction --apply < decision.json
```

Вывод — только `{"status": ...}`: `ready`, `applied`, `duplicate`, `conflict` (код 2). Неверное
решение или отсутствие состояния — код 1 без references.

Apply выполняет только отдельно разрешённое решение владельца. Между preview/apply изменение
revision возвращает conflict: прочитать новое состояние и заново согласовать решение. Повтор
того же operationId/payload возвращает duplicate; изменение payload конфликтует.
Restore снимает admission hold, но не создаёт entitlement: допуск всё равно требует актуального
права Platform и свежего dispatch permit. Purchase/start никогда не вызывает эту команду.

Журнал `community_restriction_decisions` сохраняет actor, причину, operationId и время вместе
с versioned `audit`: opaque target/binding, action, expected/applied restriction revision,
restriction/removal/confirmed-ban/status до и после, исходную community operation, её contract version,
entitlement revision и correlationRef. Эти сведения читаются под блокировкой Account и записываются
в одной транзакции с решением; последующий hold, новая проекция или duplicate/conflict их не меняют.
Community contract не передаёт course/payment sourceRef: журнал связывает решение с доступной
community operation/correlation, не угадывая источник выдачи Platform. CLI по-прежнему выводит
только статус, без references и содержимого журнала.

Миграция `021` сохраняет старые replay receipts с `audit = null`: их недостающий target/before-after
нельзя восстановить из fingerprint или текущей проекции. Новые решения фиксируют `audit.version = 1`.


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
чужой ссылке. Browser runner также проверяет focus/Enter входа, WCAG critical/serious в кабинете,
отсутствие горизонтального переполнения и moderation в боте/кабинете после повторного start. Остановить только созданные для проверки процессы/контейнеры, сохранив артефакты.

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


## Tribute activation consumer (#66)

Один опубликованный `a_<code>` может выбрать Platform `tribute_registry`; absent verificationMode
сохраняет `course_membership`. Tribute registry не нужно добавлять как Telegram course chat:
consumer не вызывает source membership и не вычисляет paid period. Период и основание возвращает
Platform по exact binding. Unknown mode не откатывается на course. При pending_review бот показывает
nonactive Enrollment, если он есть, и предлагает помощь; явный retry перечитывает registry через
новое evidence. Source-ended latch не снимается retry/member.

Контракт закреплён в [integration provenance](../integrations/subscription-activation-v1-provenance.json)
на final portable SHA, без утверждения готовности runtime #625. Regression
`test/integration/tribute-activation.integration.test.ts` запускает реальный Telegram AppModule,
HTTP codec и PostgreSQL с контролируемым loopback provider. Проверяются no membership lookup,
pending-to-confirmed, private recipient после forwarding, exact raw-body replay после 31 дня,
новый binding после известного результата, nonactive сообщения и legacy course. Это не проверка
платёжных фактов или registry/grant политики настоящей Platform; такие проверки принадлежат #625.
