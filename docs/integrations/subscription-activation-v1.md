# Активация тарифа за курс и Tribute

Telegram реализует сценарий [#64](https://github.com/sachkov-inside/inside-telegram/issues/64)
из [Workspace #180](https://github.com/sachkov-inside/workspace/issues/180).
Platform определяет Account, тариф, Enrollment, состав и срок каждого права. Telegram
проверяет участника разрешённой группы курса либо запрашивает реестр Tribute на Platform
по verified identity и продолжает обращение после входа.

## Версии и границы

Переносимые файлы в `docs/contracts/subscription-activation-v1` обновлены для
[Telegram #66](https://github.com/sachkov-inside/inside-telegram/issues/66) из неизменяемого
контракта Platform #625, опубликованного на commit
`de605c09f2afe5143dd96fb1c37ce5b6bd01e846`. Пять файлов проверены через GitHub по exact SHA
и побайтно совпадают с final bundle и draft2.
[Provenance и SHA-256 пяти файлов](subscription-activation-v1-provenance.json) фиксируют
`contractFinal:true` и `platformAccepted:false`: commit содержит контракт, а не готовый runtime #625.
Полная приёмка registry/grants и 39 сценариев остаётся у #625; consumer не зависит от его merge.

Shared Enrollment.state добавляет `pending_verification` и `suspended_source` и в
`ownAccessResponse.value.enrollments[]`, и в non-null `activationResponse.value.enrollment`.
Activation outcome.state и binding не меняются; additive rule mode и evidence decision описаны ниже. `pending_verification` означает,
что временное основание пока не подтверждено и само доступа не даёт; бот предлагает повторить
проверку позже или обратиться за помощью. `suspended_source` означает зафиксированное окончание
источника: повтор/member не восстанавливают его. Бот направляет к владельцу для подтверждения
нового периода и продолжает показывать независимые действующие Guide/course основания.
Решения о выдаче и восстановлении принадлежат Platform. Telegram не хранит own-access проекцию
в отдельной таблице; миграция для расширения transport enum не нужна.

`docs/contracts/community-v2` остаётся из принятого Platform PR #626, commit
`7ac1a7200489c822569435afeac88a6f16b76ef5`. Corpus читается локально; checkout и база Platform
не входят в imports. [Прежнее evidence #64](../evidence/course-activation/README.md) относится
к baseline до расширения #625 и не подтверждает runtime Tribute.

Все операции идут через authenticated HTTP. `binding` принимает только `contractVersion`
и opaque `identityRef`; возвращает linked с точным binding либо unlinked. Используется существующий
activation credential, отличный от linking/sign-in/community credentials. `unavailable` не означает
отсутствие Account. `identity_conflict` прекращает автоматическую проверку. Никакого внутреннего
Account UUID, угадывания `linkRef` или увеличения `linkRevision` на стороне Telegram нет.

## Выбор проверки Tribute

Optional `response.rule.verificationMode` имеет значения `course_membership` и `tribute_registry`;
отсутствующее значение сохраняет legacy course path. Unknown mode отвергается строгим codec.
Для `tribute_registry` consumer не вызывает course `getChatMember`: он получает актуальный binding
и сохраняет fresh exact-bound evidence с `decision: registry_lookup`, текущими rule revision,
checkedAt/validUntil и новым evidenceRef. Begin/binding/own-access query и credentials прежние.
Эти timestamps ограничивают запрос, а не задают платёжный период. Правило выбирает Platform,
пересланная ссылка всегда использует private identity получателя и не передаёт paid facts.

Только Platform сопоставляет policy/identity с подтверждённым реестром, проверяет период и
принимает grant/restore решения. Consumer сохраняет возвращённый Enrollment и срок без изменения.
Известный `pending_review` ожидает явного retry, не выполняет автоматический registry lookup и
очищается после 30 дней. Nonactive Enrollment в таком ответе показывается с фактическим состоянием,
без сообщения об успешной активации. Явный retry известного pending/unavailable начинает свежую
попытку с новым binding/evidenceRef; запрос с неопределённым исходом сначала повторяется точно.
JSON keys evidence сериализуются стабильно, поэтому PostgreSQL jsonb не меняет bytes нового
initial send и его replay. Для исторических receipts сохраняются исходные значения и evidenceRef.

`activation_attempts.state` теперь также использует текстовое `pending_review`; существующая
колонка text не имеет enum/check constraint, поэтому schema migration не нужна. Retry не меняет
Platform grant. Срок очистки неизвестного evidence по-прежнему не отменяет его обязательный replay.
HTTP+PG consumer tests используют настоящие AppModule/codec/storage и loopback authority с
контролируемыми wire responses. Они проверяют consumer, а не подтверждают registry policy:
positive/nonpaid/forwarded fixtures — примеры wire, не доказательство выдачи/отказа Platform.

## Обращение и доказательство

Private `/start a_<code>` занимает длину 3–42. Длинные legacy linking, `signin_` и `m_`
сохраняют прежнюю маршрутизацию. Проверенный Telegram update задаёт отправителя, чат и metadata;
переданные извне служебные поля удаляются. Активация не означает согласия на маркетинг.

До входа сохраняются opaque identity и отдельная попытка для пары пользователь/код.
Кнопки ведут на обычный Account URL Platform. Login token выпускает только browser-owned
Logto/sign-in. Существующий Account связывается в кабинете; конфликт требует восстановления
владельцем. Identity остаётся прежней после связывания и очистки старого незавершённого обращения.

Worker арендует попытку в PostgreSQL, получает актуальное правило и binding, проверяет отдельный
source registry. Canonical chat запрещён в source registry. `whole_group` означает утверждённый
источник целиком; `confirmed_list` дополнительно требует opaque identity в подтверждённом списке.
Гости вне политики и неучастники не получают право. Потеря полномочий бота, 429 и timeout дают
`unavailable`, с задержкой повторения. Course proof не записывается в canonical MembershipEvidence.

Evidence сохраняется перед отправкой, живёт не более пяти минут и содержит точные версии binding
и rule. При потерянном ответе сначала повторяется **тот же** payload и evidenceRef, даже после TTL:
это позволяет получить прежний receipt принятой выдачи. После определённого отказа просроченной
непринятой proof выполняется новая проверка с новым evidenceRef в пределах срока обращения. Изменение payload никогда не
использует прежний evidenceRef. Определённый временный результат получает новую Platform attempt,
поскольку `begin` прежней attempt возвращает сохранённый результат. Неопределённая запись не
удаляется по 30-дневной очистке. По истечении срока очищаются незавершённые обращения без
отправленного evidence либо с определённым отказом/`unavailable`, включая уже связанные Account.
Worker не начинает новую проверку по истёкшему обращению; новый явный `/start` создаёт свежее.
Если неопределённый исход прояснился только после срока и выдачи не было, запись очищается без
новой proof. Подтверждённые receipts и права Platform сохраняются. Повтор отклонённой заявки
доступен и после этого срока. Одинаковые фоновые сообщения дедуплицируются.

`Мои доступы` и вступление читают текущее own-access Platform. Отдельные основания объединяются
на Platform. Выход из группы после принятия курса не сокращает назначенный срок. Бот показывает
источник, срок назначения, отдельные benefit terms и отсутствие списаний для nonpaid назначения.
Команды и callback не несут доверенных прав: состояние перечитывается на каждом обращении.

## Community v2

`TELEGRAM_COMMUNITY_CONTRACT_VERSION=inside.community-entitlement.v2` явно включает v2.
Новые команды несовместимой версии отвергаются; старые v1 status receipts читаются.
Dispatch сохраняет `inside.billing-dispatch.v1`, но target и SHA-256 digest соответствуют точному
v2 wire payload, включая исходное написание UUID. Нет fallback на v1 при отказе.

Admission использует личную короткую join-request ссылку с сохранёнными identity/revision,
digest и expiry. Чужая или истёкшая ссылка не открывает approve effect. Перед каждым внешним
эффектом проверяется свежий permit. Неопределённый invite ожидает сохранённого срока; ban/approve
сверяются наблюдением. Участнику повторная ссылка не нужна.

`admissionRestriction` отделён от права на контент. Собственный подтверждённый expiry ban допускает
последующее восстановление. Модераторский ban и неизвестное происхождение запрещают автоматический
unban даже после покупки или `/start`. Исключение ботом из `TELEGRAM_COMMUNITY_TRIBUTE_BOT_ID` —
известное окончание подписки Tribute: запрета не создаёт, а при действующем праве бот снимает бан и
отправляет ссылку для возвращения ([схема двух ботов](../operations/course-activation.md#два-бота-в-общей-группе)). События одной секунды упорядочиваются по updateId.
Собственное событие сопоставляется сохранённой попытке; поздний ответ старой операции не перезаписывает
новое операторское решение. Прямая operator-команда доступна только через локальный CLI,
с preview, точной revision, actor/reason и идемпотентным operationId.

Эксплуатация и локальная проверка: [runbook](../operations/course-activation.md).
