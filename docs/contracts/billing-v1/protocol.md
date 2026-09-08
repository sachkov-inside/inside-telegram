# Billing integration v1: нормативный протокол

Версии, shapes и examples находятся рядом в schema.json и fixtures.json.

## Transport и service authorization

| Направление | POST path (без deployment prefix) | Contract |
|---|---|---|
| Platform → Telegram | `/internal/community-entitlements` | `inside.community-entitlement.v1` |
| Platform → Telegram | `/internal/billing-notifications` | `inside.billing-notification.v1` |
| Telegram → Platform | `/internal/billing-dispatch/authorize` | `inside.billing-dispatch.v1` |

Это target paths, ещё не endpoints приложения. HTTPS; JSON body максимум 16 KiB; request timeout
5 секунд; redirects запрещены. Отдельные service secrets на каждое направление через project
configuration; `Authorization: Bearer` проверяется constant-time существующим механизмом.
Секреты не передаются в user-facing Web/MCP, в URL или payload. Существующий marketing caller не
получает billing authority. Bank notification использует собственную подпись, не этот протокол.
Никакие credentials в #403 не создаются и не настраиваются.

Authenticated HTTP 200 означает schema-valid result/error ниже, а не непременно external success.
Для `error`: malformed=400, unauthorized=401, unsupported_contract=422, not_found=404,
operation_conflict/revision_conflict/binding_conflict=409, unavailable=503. Существующий adapter
сверяет и HTTP, и body; несоответствие — invalid provider response/unknown, не повтор эффекта.
Без parseable operationId сервер возвращает generic 400/401 через свой HTTP error boundary;
не выдумывает correlation или успешное durable acceptance. Никакой effect до аутентификации,
валидации и durable receipt. Ошибки не раскрывают raw provider/identity details.

У каждой request есть operationId UUID. Для status lookup это ID исходной операции. Response
коррелируется с запросом: operationId и version всегда совпадают; result для entitlement также
сохраняет binding/revision/access исходной команды, не произвольного latest Account snapshot.
Для notification — noticeRef. Unknown/status not_found не разрешает caller слепо создать новый
operationId; sender сверяет свою durable запись и повторяет тот же command, если acceptance не
подтверждено. Новый ID допустим только для новой бизнес-операции или явно разрешённого recovery.

Idempotency scope — authenticated service + contractVersion + operationId. Fingerprint — SHA-256
UTF-8 JSON исходной schema-valid command с отсортированными ключами objects, исходным порядком
arrays, без лишних пробелов; Unicode сохраняется, integers только safe, даты остаются исходными
wire strings. На обеих сторонах один и тот же payload, без произвольной нормализации перед hash.
`payloadDigest` dispatch authorization относится к этому fingerprint исходной set/send команды,
а не authorize request. UUID spelling нормализуется на boundary до сохранения/вычисления hash.

## Community protocol

`entitlement.set` содержит binding (opaque accountRef и telegramIdentityRef, linkRef UUID,
linkRevision), монотонную entitlementRevision для Account, access, issuedAt и correlationRef.
`access.kind` — `denied`, `finite` с validUntil, либо `lifetime` без искусственной далёкой даты.
Протокол не передаёт цену, payment token, raw Account ID, Telegram chatId или username.

Platform #404 расширяет текущий link facet стабильным linkRef/revision и историческим tombstone;
это не новое доказательство Telegram identity. #415 привязывает каждую delivery к конкретной
verified связи. Provider не создаёт link из entitlement request и сверяет свою verified identity.

Правила admission и применения:

1. Одна operationId + тот же payload возвращает durable result; другая нагрузка — operation_conflict.
2. Меньшая entitlementRevision не меняет desired state. Новый operationId с той же revision и
   другим desired state — revision_conflict; идентичное состояние с той же revision не создаёт
   вторую desired-state запись. Это не запрещает отдельные действия reconciliation/rejoin ниже. Link change также увеличивает entitlementRevision, а не только linkRevision.
3. Provider сохраняет accepted до acknowledgement. Очередь, запрос на вступление и фактическое
   членство различаются. `waiting_for_join` не считается `applied`.
4. Для выдачи создаётся контролируемый join-request путь; approve только intended verified
   identity и действующее право. Чужая ссылка/username не выбирает получателя.
5. Перед внешней mutation или approve Telegram запрашивает свежий dispatch permit. Даже при
   accepted старом grant он не выдаёт вступление после expiry/revoke/unlink.
6. После запрета Telegram устраняет членство и возможность повторного вступления, пока нет нового
   действующего allow. Exact Bot API sequence и права бота фиксирует #54; `banChatMember` запрещает
   rejoin, `approveChatJoinRequest` требует admin permission. [Bot API](https://core.telegram.org/bots/api#banchatmember)
   — источник поведения, не доказательство прав нашего бота.
7. Для revoke после unlink Platform разрешает удаление старой identity лишь по историческому
   binding того же Account и отсутствию разрешённого transfer. Такая команда не даёт права на
   старый grant; конфликт владения уходит оператору. Reconciliation не удаляет чужую identity.

Result `status`: accepted, waiting_for_join, applied, superseded, failed, unknown, expired.
`observedMembership`: member/not_member/unknown. `applied` allow означает подтверждённое member;
`applied` denied — подтверждённое отсутствие и закрытие admission. Schema проверяет непротиворечивость applied/access/observedMembership; фактическое observation
и порядок событий обязаны проверить provider/consumer runtime tests. Community applied — наблюдаемое состояние, не навсегда терминальное: при выходе участника
оно может стать waiting_for_join без новой entitlementRevision. Для нового verified join request
создаётся новый effectRef; preflight community.approve_join проверяет то же ещё действующее право.
Повтор одного join request использует прежний effectRef. Истёкший allow переводится
в expired и не даёт вход; worker устраняет оставшееся участие, не считает его уже удалённым.

Изменения outbox обрабатываются promptly; контрольная сверка known desired states не реже раза
в минуту, overdue apply/reconcile старше 5 минут виден оператору и в alert. Это интервал нашей
проверки, не гарантия доступности Telegram. Если Bot API недоступен, статус unknown/failed,
материалы по paid/manual праву продолжают работать. GetChatMember сверяет known identity,
не перечисляет весь roster. Timeout внешней mutation требует observation перед её повтором.

## Уведомления и dispatch permit

`notification.send` — plain text до 3000 символов, kind из закрытого списка, noticeRef/revision,
verified binding, issuedAt/notAfter. Только служебные типы; разметка, media и arbitrary URL fields
не входят. Ссылка управления может содержаться в подготовленном Platform text только на свой
настроенный HTTPS origin; producer проверяет её, Telegram не использует пользовательский URL
как произвольный destination. Текст не содержит bank tokens или данные чужого Account.

Расписание принадлежит Platform. Telegram принимает только готовую к ближайшей отправке notice,
notAfter не позднее issuedAt + 10 минут. При истечении она suppressed, не отправляется постфактум.
Platform пересоздаёт актуальное намерение по новой noticeRevision, если событие ещё требует
уведомления. Для email те же recipient/revision/current-state проверки выполняет локальный sender.
Ошибка любого канала не меняет подтверждённую оплату и права.

Порядок после durable acceptance:

1. Provider worker сериализует конкретный внешний эффект. Для notice `effectRef` равен исходному
   operationId и существует один эффект send; для community effectRef обозначает конкретный
   observed join request или требуемое действие сверки. Повтор observed события использует тот же
   effectRef; новый rejoin — новый effectRef при том же действующем desired state.
2. `dispatch.authorize` — проверка актуальности, **не глобальная резервация отправки**. Запрос
   содержит dispatchId, dispatchContractVersion, attemptId, effectRef, effect и fingerprint
   исходной команды. Effect — notice.send, community.ensure_admission, community.approve_join или
   community.ensure_absence. Service adapter направляет проверку публичному facet владельца:
   billing для notice, telegram-membership для community. Чужой kind/effect отклоняется.
3. Владелец сверяет исходную запись/fingerprint, текущие право/notice revision и verified binding.
   Reminder сверяет дату/сумму/отмену. Community allow допускает ensure_admission/approve_join;
   ensure_absence допускается при отсутствии текущего права, включая expiry, либо разрешённом
   cleanup старой identity после unlink. Проверяется актуальная совокупность прав: старый expired
   grant не разрешает удалить участника, если уже есть новое или lifetime основание. Обычный
   устаревший source возвращает superseded; cleanup исторической связи использует отдельную
   проверку того же Account без transfer. При конфликте — оператор, не удаление чужой identity.
4. Allowed возвращает permitRef/validUntil не позже now + 5 секунд, связанные с полным запросом.
   Это краткоживущий результат проверки. Повтор того же authorization operationId возвращает
   тот же ответ, включая исходный deadline. Новая проверка после истечения получает новый
   operationId/attemptId; это не новый send и не требует status callback из Platform в Telegram.
   Denied: superseded/binding_conflict/expired/not_found/payload_conflict/effect_conflict.
   Unavailable не разрешает I/O. Ledger эффекта всегда принадлежит provider, а не permit issuer.
5. Provider проверяет deadline и своё latest desired state. Под той же эксклюзивной блокировкой
   он атомарно сохраняет `started` с effectRef/attemptId/permitRef **до I/O**. Для notice общий status
   в этой транзакции становится unknown и остаётся таким до доказанного sent/failed. Никакой
   второй worker или новый permit не обходит этот ledger. После crash с started повторное
   sendMessage автоматически запрещено, даже если Platform снова подтверждает актуальность.
6. После expiry permit до started provider может заново выполнить preflight под той же блокировкой:
   в собственной durable записи видно, что effect ещё not_started. Успешный новый permit позволяет
   первую отправку. Platform не угадывает этот факт по общему status и не владеет send ledger.
7. Notice: success → sent; однозначный запрет/недостижимый recipient → failed;
   superseded/expiry → suppressed; потерянный ответ sendMessage → unknown и manual recovery.
   Bot API не предоставляет idempotency key для такого send; exactly-once не обещается.
   Community: после started с unknown сначала наблюдение getChatMember/join state. Если эффект
   не подтверждён и всё ещё нужен, сверка создаёт контролируемую следующую attempt того же effectRef
   после fresh preflight. Она не создаёт новое право. Новое legitimate rejoin — отдельный effectRef,
   даже если прежний approve завершился успешно и entitlementRevision не менялась.

Успешный preflight — граница проверки актуальности. Если отмена принята до него, stale reminder
не разрешается. Между preflight и внешним send есть неатомарное окно до 5 секунд: отмена в этом
окне или после started не обещает отозвать уже разрешённое сообщение. Она запрещает последующие
checks/attempts. Этот протокол не переносится на банковский cancel/Charge, где сериализацию
проверки и начала отправки отдельно обеспечивает billing worker.

No-acceptance network failures повтора internal HTTP request используют тот же operationId.
До внешнего started можно повторить authorization/доказанный временный failure по backoff
1, 5, 30 секунд с общим сроком не дольше notAfter; community reconciliation продолжает отдельный
путь. Это не разрешает retry bank Charge или unknown sendMessage. Вся история delivery доступна
оператору; queue ack никогда не становится sent/member автоматически.

## Conformance ownership

#403 исполняет только schema-valid/invalid examples, integrity и ссылки sequence corpus.
Platform #404/#407/#409/#410/#415 и Telegram #55/#56 исполняют normative expected outcomes через
real facets и PostgreSQL. Каждый consumer также проверяет response correlation, semantic поля,
replay и exact HTTP/body mapping. Нет тестовой реализации billing, которую можно принять за
production код. #413 объединяет обе стороны и отдельно доказывает разрешённые реальные эффекты.
