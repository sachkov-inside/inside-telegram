# Активация тарифа за курс

Telegram реализует сценарий [#64](https://github.com/sachkov-inside/inside-telegram/issues/64)
из [Workspace #180](https://github.com/sachkov-inside/workspace/issues/180).
Platform определяет Account, тариф, Enrollment, состав и срок каждого права. Telegram
проверяет известного участника разрешённой группы курса и продолжает его обращение после входа.

## Версии и границы

Переносимые файлы в `docs/contracts/subscription-activation-v1` обновлены для
[Telegram #66](https://github.com/sachkov-inside/inside-telegram/issues/66) из неизменяемого
provider snapshot `platform625-contract-draft-1` поставки Platform #625. Это uncommitted draft
поверх accepted `a663f661e89dfb90270b93e871da81d37d476363`, **не окончательный provider SHA**.
[Provenance и SHA-256 пяти файлов](subscription-activation-v1-provenance.json) фиксируют exact bytes;
итоговая приёмка требует сверки с опубликованным final head Platform #625.

Shared Enrollment.state добавляет `pending_verification` и `suspended_source` и в
`ownAccessResponse.value.enrollments[]`, и в non-null `activationResponse.value.enrollment`.
Activation outcome.state, binding и остальные поля не меняются. `pending_verification` означает,
что временное основание пока не подтверждено и само доступа не даёт; бот предлагает повторить
проверку позже или обратиться за помощью. `suspended_source` означает зафиксированное окончание
источника: повтор/member не восстанавливают его. Бот направляет к владельцу для подтверждения
нового периода и продолжает показывать независимые действующие Guide/course основания.
Решения о выдаче и восстановлении принадлежат Platform. Telegram не хранит own-access проекцию
в отдельной таблице; миграция для расширения transport enum не нужна.

`docs/contracts/community-v2` остаётся из принятого Platform PR #626, commit
`7ac1a7200489c822569435afeac88a6f16b76ef5`. Corpus читается локально; checkout и база Platform
не входят в imports. [Прежнее evidence #64](../evidence/course-activation/README.md) относится
к baseline до расширения #625, а не подтверждает этот draft.

Все операции идут через authenticated HTTP. `binding` принимает только `contractVersion`
и opaque `identityRef`; возвращает linked с точным binding либо unlinked. Используется существующий
activation credential, отличный от linking/sign-in/community credentials. `unavailable` не означает
отсутствие Account. `identity_conflict` прекращает автоматическую проверку. Никакого внутреннего
Account UUID, угадывания `linkRef` или увеличения `linkRevision` на стороне Telegram нет.

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
unban даже после покупки или `/start`. События одной секунды упорядочиваются по updateId.
Собственное событие сопоставляется сохранённой попытке; поздний ответ старой операции не перезаписывает
новое операторское решение. Прямая operator-команда доступна только через локальный CLI,
с preview, точной revision, actor/reason и идемпотентным operationId.

Эксплуатация и локальная проверка: [runbook](../operations/course-activation.md).
