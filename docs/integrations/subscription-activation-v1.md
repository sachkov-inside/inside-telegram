# Активация тарифа за курс

Telegram реализует сценарий [#64](https://github.com/sachkov-inside/inside-telegram/issues/64)
из [Workspace #180](https://github.com/sachkov-inside/workspace/issues/180).
Platform определяет Account, тариф, Enrollment, состав и срок каждого права. Telegram
проверяет известного участника разрешённой группы курса и продолжает его обращение после входа.

## Версии и границы

Переносимые файлы в `docs/contracts/subscription-activation-v1` получены без изменений из
Platform PR #629, commit `35702d9da2a2d6c0724a57e319b2bcb5d6318dd3`.
Этот commit проверен координатором, но на момент подготовки consumer ожидает merge.
`docs/contracts/community-v2` получен из принятого Platform PR #626, commit
`7ac1a7200489c822569435afeac88a6f16b76ef5`. Corpus содержит схемы и отрицательные примеры;
тесты читают его локально. Checkout и база Platform не входят в приложение или тестовые imports.
Финальная приёмка требует принятой версии Platform с binding lookup (#627).

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
непринятой proof выполняется новая проверка с новым evidenceRef. Изменение payload никогда не
использует прежний evidenceRef. Определённый временный результат получает новую Platform attempt,
поскольку `begin` прежней attempt возвращает сохранённый результат. Неопределённая запись не
удаляется по 30-дневной очистке. Очищаются только незавершённые unlinked обращения; повтор
отклонённой заявки доступен и после этого срока. Одинаковые фоновые сообщения дедуплицируются.

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
