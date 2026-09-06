# Подтверждение входа через бота

Статус: implementation draft, не разрешение на production enablement.
Задача: [Telegram #24](https://github.com/sachkov-inside/inside-telegram/issues/24).
Общий результат: [Workspace #116](https://github.com/sachkov-inside/workspace/issues/116).
Подключение сайта: [Platform #299](https://github.com/sachkov-inside/platform/issues/299).

## Граница этого изменения

Бот подтверждает Telegram identity. Он не создаёт Account, не выдаёт сессию сайта,
не разрешает доступ к контенту. Отдельное серверное завершение связывает consumed proof
с выбранным Platform principal через существующий владелец PlatformLink. Правила Account
и восстановления принадлежат Platform.
Это обеспечивающий этап, а не готовый вход на сайт.

Пользователь выбрал два равноправных способа входа: email и Telegram-бот.
Регистрация Account без email подтверждена владельцем в Platform #299 2026-09-06;
добавление первой почты, замена identity и восстановление в эту поставку не входят.
Logto остаётся единственным источником пользовательских сессий. До подключения
Platform и проверки сохранения существующего Account провайдер нельзя включать.

## Протокол `inside.bot-sign-in.v1`

Все методы доступны только доверенному серверу удостоверяющего сервиса.
Браузер не получает integration credential. Требуется отдельный
`Authorization: Bearer <TELEGRAM_SIGN_IN_INTEGRATION_SECRET>`; обычный ключ
Membership/linking не подходит. HTTP body не должен попадать в access/error logs
или трассировку прокси. Ответы нельзя кэшировать.

1. Доверенный клиент генерирует независимые случайные `startToken` (26 байт,
   208 бит) и `browserSecret` (32 байта): base64url без padding. Browser secret остаётся
   в защищённом состоянии исходной browser/Logto transaction; его нельзя помещать
   в deep link, callback button или публичный URL.
2. `POST /integrations/identity/v1/sign-in` получает ровно `contractVersion`,
   `requestRef` (UUIDv4), `startTokenDigest`, `browserSecretDigest` (SHA-256,
   base64url), `expiresAt` (не более пяти минут). Ответ `registered` содержит
   `confirmationCode` из шести цифр и `expiresAt`. Код отображается в исходной
   вкладке и в боте; это подсказка против ошибочного подтверждения, не секрет.
   Повтор с теми же параметрами идемпотентен. Изменить привязку браузера нельзя.
3. Клиент открывает `https://t.me/<bot_username>?start=signin_<startToken>`.
   Ingress заменяет аргумент `/start` на digest до сохранения inbox. Префикс
   вместе с длиной payload 42 символа отделяет вход от существующего связывания
   authenticated Account: старый контракт допускает 43–64 символа, и его токены
   сохраняют смысл, даже если случайно начинаются с `signin_`.
4. Первый private human `/start` закрепляет кандидата и атомарно планирует
   единственное сообщение с кнопками «Подтвердить вход» и «Это не я».
   Повторная доставка update или пересылка ссылки другому пользователю не
   меняет кандидата. `/start` сам по себе не подтверждает вход.
5. Решение принимается только из private callback того же пользователя/чата.
   Callback содержит request reference, но не browser secret. Approval/denial
   терминальны. Просроченное решение не принимается даже при задержке inbox.
6. `POST /integrations/identity/v1/sign-in/:requestRef/status` с ровно
   `contractVersion` и `browserSecret` возвращает состояние без identity данных.
   После `approved` тот же доверенный клиент вызывает `/consume` с тем же body.
   Только один конкурентный consume возвращает `verified`: стабильный непрозрачный
   `subjectRef`, `approvedAt` и `existingLink` (`accountRef`, `telegramIdentityRef`)
   либо `null`. Повторы возвращают `consumed`; потерянный ответ требует нового
   запроса входа, а не повторной выдачи доказательства.

Другие состояния: `pending`, `denied`, `expired`, `unavailable`, `disabled`.
Неверный секрет браузера и неизвестный request дают одинаковый `unavailable`.
Неверный integration credential — HTTP 401, невалидный envelope — HTTP 400.
При выключении настроенный ключ сохраняется для аутентифицированного ответа
`disabled`; без настроенного ключа все HTTP-методы возвращают 401.
Результат `verified` не является JWT или самостоятельным разрешением на вход.

`existingLink` — снимок существующей связи на момент consume, не новая authority
для Account. Platform integration обязана учитывать audited owner recovery и
не превращать такой снимок в бессрочный альтернативный путь доступа.
Нельзя автоматически объединять Account по username, email или ссылке клиента.

## Переключатель и доставка

`TELEGRAM_SIGN_IN_ENABLED=false` по умолчанию. `true` требует отдельного
base64url credential длиной от 32 символов. Это конфигурация процесса: для
выключения требуется перезапуск всех replicas, а не только скрытие кнопки.
Регистрация, приём `/start`, approval и consume проверяют переключатель;
выключенный consumer не выдаёт уже одобренное доказательство. Непросроченные
старые запросы могут продолжиться после повторного включения; для их полного
истечения выдержать пять минут. Аккаунты, сессии и история связей не удаляются.

Отправка сообщений по-прежнему отдельно требует `TELEGRAM_DELIVERY_MODE=live`.
Очередь не выбирает prompts для выключенного входа, завершённых или просроченных
запросов. Уже отправленное сообщение может остаться в Telegram, но его кнопка
не обходит проверки. При неизвестном результате доставки возможны дубли одного
prompt в пределах существующего retry budget; они не создают второй запрос.
`answerCallbackQuery` только убирает индикатор ожидания и не сообщает об успешной
сессии. Отказ этого краткоживущего ответа не отменяет durable decision.
Его ожидание ограничено отменяемым таймаутом в две секунды, чтобы косметический
ответ не задерживал общий обработчик inbox на стандартный долгий timeout Telegram.

Миграция 008 добавляет отдельные requests/subjects и ссылку на request в очереди.
Выключение не требует отката миграции. Нельзя удалять `sign_in_subjects` после
использования identities: повторное создание изменит их стабильные ссылки.

## До включения для пользователей

- Подключить Logto и Platform с browser/state binding, защитой от login CSRF,
  ограничением частоты запросов, проверкой callback и безопасным return URL.
- Проверить один Account при обоих подтверждённо связанных способах входа. Не вводить
  вторую систему сессий или неразрешённое восстановление.
- Добавить server-side switch на стороне Platform, включая callback и уже
  начатые запросы, и проверить его вместе с переключателем провайдера.
- Выполнить отдельную проверку применимости законодательства. Собственный бот
  и feature flag не подтверждают правомерность иностранной аутентификации.
- После явного owner GO настроить реальные credentials, webhook с
  `callback_query` и провести mobile/desktop credentialed journey.

Mini App, биллинг и маркетинг в эту поставку не входят.

## Проверка

`pnpm check:full` включает HTTP/webhook journey на настоящем PostgreSQL:
отдельные credentials, закрытый envelope, digest redaction, явное подтверждение,
чужой пользователь/бот/группа, отказ, одноразовый consume с независимыми DB
connections, стабильный subject, existing link без изменения, срок и выключение.
Тесты используют только синтетические updates и отключённую внешнюю доставку.
Это не credentialed Telegram proof и не проверка входа в Platform.

Официальные технические основания: [Telegram deep links](https://core.telegram.org/bots/features#deep-linking),
[callback query](https://core.telegram.org/bots/api#callbackquery) и
[inline keyboard](https://core.telegram.org/bots/api#inlinekeyboardbutton).

## Завершение связи с Account — интеграция Platform #299

`POST /integrations/identity/v1/sign-in/:requestRef/account-link` использует тот же отдельный
sign-in credential. Envelope содержит ровно `contractVersion: "inside.bot-sign-in.v1"`,
`subjectRef` и `accountRef` (UUIDv4). `accountRef` здесь — непрозрачный linking principal,
закреплённый Platform за Account до запроса. Клиент браузера не выбирает его.

Метод принимает только consumed request с совпадающей Telegram identity и stable subject.
Он сохраняет обычную link transaction и вызывает существующую confirmation операцию.
Ответ: `contractVersion`, `status: "linked"`, `telegramIdentityRef` (UUIDv4), либо status
`conflict`, `unavailable` или `disabled`. Повтор с тем же principal идемпотентен; другой principal
не подменяет связь. До первой записи действует срок proof; уже созданная transaction сохраняет
свою проверяемую историю. При потере ответа свежий вход завершает тот же stable principal.

Миграция 009 добавляет durable reservation независимой Telegram-регистрации. Consume и обычная
email-привязка сериализуются по `(botIdentity, telegramUserId)`. Если email-привязка победила,
consume возвращает её existingLink. Если consume первым подтвердил независимую регистрацию,
обычная привязка отклоняется; reservation не истекает вместе с запросом, и новый Telegram-вход
может завершить регистрацию после потери ответа. Разрешение завершения определяется сохранённым
consumed request, не клиентским boolean. Это не перенос Account или выдача Membership.
Два interleaving PostgreSQL tests удерживают общий lock и проверяют оба порядка событий.
