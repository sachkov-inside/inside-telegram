# Локальная проверка Telegram #64

Проверка 14 сентября 2026 года использует Platform PR #629 commit
`35702d9da2a2d6c0724a57e319b2bcb5d6318dd3`. Он проверен координатором и CI, но пока не принят в main.
Это worker evidence на проверяемом provider; завершённая приёмка #64 требует сообщения о merge
и повторения применимых проверок. Точный Telegram head и итоговые review/CI указываются в PR.

[Воспроизведение](../../operations/course-activation.md) — `proof:course:provider`,
`proof:course:browser` и `proof:course:existing`. Browser runners используют настоящие API/BFF,
локальный Logto и отдельные PostgreSQL приложений. Подменяется только внешний Telegram;
для сохранения прежней покупки дополнительно используется штатный локальный банковский двойник.
Ни Account, ни готовый grant, ни binding не записывается в БД тестовым драйвером.

## Подтверждённое поведение

| Область #180 | Проверка |
| --- | --- |
| 1, 32 | Новая course ссылка → browser-owned Telegram sign-in → linking → один Platform Enrollment → кабинет/закрытый материал → intended join по реальному v2 dispatch permit; desktop/mobile |
| 2 | Новый email Account сначала совершает разовую покупку через hosted bank double и сохраняет progress; после course/linking paid grounds, notices, profile и progress сохранены |
| 3, 7 | Browser nonmember получает ноль Enrollment; unit source policy проверяет гостя, permissions, 429, неизвестный статус и отдельный canonical/source chat |
| 4, 5, 38 | Повторы и source exit сохраняют id/revision/term; PG два кода/worker сохраняют одну source identity; owner UI manual-first/activation-first и две ссылки сохраняют один Enrollment и срок |
| 6, 8 | Portable strict corpus + exact rule/binding revisions; PG expired unaccepted proof сначала replay, затем fresh evidence; потерянный принятый receipt повторяется спустя 31 день; identity conflict останавливает retry |
| 27, 29, 30 | PG intended/foreign/expired invite, concurrency и persisted invite horizon; реальные приложения восстанавливают community delivery после restart consumer при сохранённом Platform grant |
| 28, 39 | PG moderation/external unknown/own expiry, v1 receipt/v2 target/digest; отдельные гонки equal-second events, own kicked before HTTP ack, stale superseded settle after audited restore и stale observation во время operator restore; actual bot/cabinet moderation сохраняет чтение и не вызывает unban после start |

Исполняемые источники: `test/integration/subscription-activation.integration.test.ts`,
`test/integration/community-v2.integration.test.ts`, unit ingress/HTTP/corpus и local browser runners.
Общие прежние sign-in/Membership/marketing/integration suites входят в `pnpm check:full`.
Runtime image отдельно собирается из `infra/production/Dockerfile`; обе новые схемы загружаются
из production `dist` без `docs` и dev dependencies. Схемы в `src` проверяются на byte-identical drift.

Операторский CLI на отдельном synthetic пользователе вернул `ready → applied → duplicate`
для preview, apply и точного повтора одной команды. PG отдельно проверяет конфликт revision
и restore, совпавший с незавершённым наблюдением или внешним эффектом. Исходные operator references
и JSON остаются вне Git.

## Интерфейсные артефакты

- [Новый покупатель читает закрытый материал, mobile](new-reader-mobile.png).
- [Существующий Account: сохранённое чтение, mobile](existing-reader-mobile.png).
- [Существующий Account: сохранённое чтение, desktop](existing-reader-desktop.png).
- [Кабинет нового покупателя, desktop](new-cabinet-desktop.png) и [mobile](new-cabinet-mobile.png).
- Модераторское ограничение при сохранённых правах: [mobile](moderation-mobile.png) и [desktop](moderation-desktop.png).
- [Машиночитаемые результаты](results.json).

Скриншоты содержат только seeded материалы и synthetic пользователя. Auth cookies, login токены,
исходные Telegram payloads, реальные группы и production secrets не публикуются.

## Граница доказательства

Это локальная проверка двух приложений, а не реальная Telegram delivery, оплата или production
запуск. Tribute import/feed, 39 сценариев всей поставки, реальный batch и принятие #625 не входят
в этот PR. Source readiness, управление двумя ботами, реальные полномочия и разрешение включения
остаются gates владельца, перечисленными в runbook. Принятый provider и final-head review/CI ещё
должны быть зафиксированы перед итоговой передачей #64.
