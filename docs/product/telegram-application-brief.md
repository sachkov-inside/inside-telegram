# Sachkov Inside Telegram application brief

Статус: подтверждённый seed brief от 2026-08-30.

## Расширение communications от 2026-09-06

Исторические ограничения Membership bridge ниже относятся к первому релизу. Коммуникации теперь
определены [принятым общим контрактом](https://github.com/sachkov-inside/workspace/blob/1553211220c44882dbacce7519dd50e35493090e/docs/specifications/telegram-communications-v1.md):
он задаёт авторские заготовки и отдельное разрешение `communications:manage`, а для
маркетинга — общий stop/resume. Техническая поставка заготовок и versioned API описана в
[локальном контракте интеграции](../integrations/communications-v1.md). Теперь реализация включает механизм сохранения и публикации воронок, общий intro и durable
расписание multipart-доставки (#28). Текущая авторская цель — одна общая воронка; её тексты и
конкретные тематические сценарии создаёт лично владелец. В поставке нет авторского контента или
автоматически опубликованных сценариев, несколько сценариев используются только в тестах.
[#29](https://github.com/sachkov-inside/inside-telegram/issues/29) добавляет досылку новых шагов прежним
участникам, обновление ожидающих сообщений, rollback и явное разрешение неопределённой доставки.
`/stop` выключает весь маркетинг, `/resume` включает будущие сообщения без накопленной очереди.
`/start`, вход и разблокировка бота сохраняют явный отказ. Редактор и сквозная приёмка остаются
отдельной поставкой. [#30](https://github.com/sachkov-inside/inside-telegram/issues/30) добавляет разовые рассылки через
общий отправитель, снимок аудитории при запуске, аналитику контактов/источников/доставки и токены
переходов для Platform. UI и redirect consumer поставляются отдельно; это ещё не сквозная готовность.
Marketing по умолчанию выключен.

## Результат продукта

Sachkov Inside получает отдельное Telegram application с dedicated bot `Sachkov Inside`. Оно
начинается как надёжный Membership bridge, а позднее тем же bot identity доставляет участникам и
заинтересованным пользователям коммуникации и маркетинговые сообщения.

Первый релиз позволяет человеку:

1. открыть bot обычным `/start` или через short-lived deep link из Platform;
2. стать `BotContact` независимо от наличия Account и Membership;
3. безопасно связать Telegram identity с уже authenticated Account;
4. получить точный transactional ответ о linking и Membership state;
5. получить доступ к закрытым Platform Materials только после принятия Platform свежего
   Membership Evidence.

Telegram application не принимает финальное решение о доступе к контенту. Оно доказывает Telegram
identity, наблюдает Membership Signal и передаёт normalized bounded evidence. Platform строит
собственный entitlement и остаётся единственной authorization authority.

## Три независимых состояния

### BotContact

Любой обычный `/start` создаёт или реактивирует BotContact. Контакт существует независимо от
Account, link и Membership и в будущем входит в общую messaging/marketing audience.

Telegram block прекращает техническую доставку сообщений, но не удаляет контакт или историю.
В исходном bridge отдельной команды `/stop` не было. Расширение communications выше добавляет
общий отказ от маркетинга отдельно от Contactability. Разблокировка возвращает техническую
доступность, сохраняя явный отказ; просроченный маркетинг не догоняется. Category consent и
автоматический retention/deletion не входят в v1.

### Telegram identity link

Platform создаёт high-entropy short-lived single-use token и deep link на bot. `/start` связывает
token с Telegram identity, но не завершает перенос доступа самостоятельно. Пользователь завершает
подтверждение в authenticated Account flow Platform.

Одна Telegram identity исторически принадлежит одному Account. Повторное связывание той
же пары идемпотентно; conflict не делает silent merge или transfer. Exceptional transfer выполняет
только владелец через отдельную audited CLI/runbook процедуру.

### Membership observation

Канонический закрытый Telegram chat является единственным Membership Signal. Tribute или другой
payment/roster operator может менять состав chat, но не входит в identity или access contract.

Bot принимает member-status updates, durable сохраняет их до обработки и выполняет фоновую
`getChatMember` reconciliation для известных linked identities. События и reconciliation создают
один versioned normalized Membership Evidence contract. Platform принимает evidence асинхронно;
обычный Library или Material request никогда не обращается к Telegram.

Positive evidence живёт не более пяти минут. Более новое removal evidence прекращает новые
protected operations после принятия Platform; stale или unavailable state fail closed. Rejoin
может восстановить доступ без нового Account или повторного link.

## Первый релиз: Membership bridge v1

### Входит

- dedicated Telegram bot и private application repository;
- обычный `/start`, создание/реактивация BotContact и transactional welcome;
- Platform-issued deep-link transaction и финальное подтверждение в Platform;
- identity uniqueness, conflict state и owner-operated exceptional recovery boundary;
- один configured canonical closed chat;
- durable member-status update ingestion с deduplication и ordering protection;
- background reconciliation известных linked identities через `getChatMember`;
- versioned normalized Membership Evidence и provider-side conformance corpus;
- authenticated integration seam с Platform;
- PostgreSQL migrations, redacted audit facts, retry/failure states и focused metrics;
- local/CI verification и credentialed smoke с настоящим dedicated bot и test/temporary chat;
- только transactional сообщения о `/start`, linking, status и safe errors.

### Не входит

- broadcasts, campaigns, scheduling, marketing analytics или segmentation UI;
- отдельные notification preferences, category consent и `/stop`;
- billing, Tribute API/webhooks или payment state;
- content posting, community moderation или admin dashboard;
- production domains, permanent credentials, release, monitoring, backup/recovery и production GO;
- Account/Profile UI и финальная Platform authorization implementation.

## Долгосрочная роль

После Membership bridge тот же bot может получить onboarding, announcements, content
communications и marketing. Эти возможности поставляются отдельными Specifications и не расширяют
v1 скрытым образом.

Принятая product policy считает любой `/start` достаточным основанием для будущей технической
contactability: messaging может обращаться ко всем BotContacts, пока Telegram позволяет доставку.
Перед фактическим marketing release требуется отдельный platform-policy/legal review; текущий brief
не утверждает соответствие конкретной юрисдикции и не заменяет privacy policy.

## Готовность v1

V1 считается application-ready, когда independently tested provider проходит общий evidence
corpus, sequence corpus для duplicate/out-of-order/missed events и credentialed temporary smoke:
обычный start, tokenized link, member, non-member, removal, rejoin, conflict, replay, block/unblock и
provider outage.

Это не production release. Production topology, secrets operations, observability, capacity,
backup/recovery и enablement получают отдельную owner-approved specification.

## Создание воронок через Telegram

Автор собирает воронку из тех же сохранённых постов, что использует для рассылок: общий вводный
блок, первый ответ и последовательность шагов. В меню бота можно задать порядок, задержки и
источники, выбрать воронку для обычного входа, проверить изменения перед публикацией и управлять
паузой или архивом. Оформление постов готовится средствами Telegram. Выбранное содержимое
сохраняется отдельно; изменение исходного поста требует явной замены в воронке. Platform остаётся
источником прав автора и проверки доступности материалов. Точный транспорт и ограничения
описаны в [интеграции коммуникаций](../integrations/communications-v1.md#funnel-author-menu-38).
