# Подтверждение входа через бота

Статус: implementation draft, не разрешение на production enablement.
Задача: [Telegram #24](https://github.com/sachkov-inside/inside-telegram/issues/24).
Общий результат: [Workspace #116](https://github.com/sachkov-inside/workspace/issues/116).
Подключение сайта: [Platform #299](https://github.com/sachkov-inside/platform/issues/299).

## Граница этого изменения

Бот подтверждает Telegram identity. Он не создаёт Account, не выдаёт сессию сайта,
не меняет PlatformLink и не разрешает доступ к контенту. Подтверждённая почта,
правила регистрации и восстановления Account остаются без изменений в Platform.
Это обеспечивающий этап, а не готовый вход на сайт.

Пользователь выбрал два равноправных способа входа: email и Telegram-бот.
Создание нового Account без email ещё требует отдельного подтверждения владельца.
Logto остаётся единственным источником пользовательских сессий. До подключения
Platform и проверки сохранения существующего Account провайдер нельзя включать.

## Протокол `inside.bot-sign-in.v1`

Все методы доступны только доверенному серверу удостоверяющего сервиса.
Браузер не получает integration credential. Требуется отдельный
`Authorization: Bearer <TELEGRAM_SIGN_IN_INTEGRATION_SECRET>`; обычный ключ
Membership/linking не подходит. HTTP body не должен попадать в access/error logs
или трассировку прокси. Ответы нельзя кэшировать.

1. Доверенный клиент генерирует независимые случайные `startToken` и
   `browserSecret`: по 32 байта, base64url без padding. Browser secret остаётся
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
   отделяет вход от существующего связывания authenticated Account.
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

Миграция 008 добавляет отдельные requests/subjects и ссылку на request в очереди.
Выключение не требует отката миграции. Нельзя удалять `sign_in_subjects` после
использования identities: повторное создание изменит их стабильные ссылки.

## До включения для пользователей

- Подтвердить: регистрация без email или вход только в ранее созданный Account.
- Подключить Logto и Platform с browser/state binding, защитой от login CSRF,
  ограничением частоты запросов, проверкой callback и безопасным return URL.
- Проверить один Account при обоих способах входа и отдельный сценарий добавления
  email/восстановления доступа. Не вводить вторую систему сессий.
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
