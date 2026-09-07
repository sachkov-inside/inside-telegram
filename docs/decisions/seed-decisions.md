# Seed decisions

Подтверждено владельцем 2026-08-30.

## Расширение communications от 2026-09-06

Исторические ограничения Membership bridge ниже относятся к первому релизу. Коммуникации теперь
определены [принятым общим контрактом](https://github.com/sachkov-inside/workspace/blob/1553211220c44882dbacce7519dd50e35493090e/docs/specifications/telegram-communications-v1.md):
он задаёт авторские заготовки и отдельное разрешение `communications:manage`, а для будущего
маркетинга — общий stop/resume. Техническая поставка заготовок и versioned API описана в
[локальном контракте интеграции](../integrations/communications-v1.md). Теперь реализация включает механизм сохранения и публикации воронок, общий intro и durable
расписание multipart-доставки (#28). Текущая авторская цель — одна общая воронка; её тексты и
конкретные тематические сценарии создаёт лично владелец. В поставке нет авторского контента или
автоматически опубликованных сценариев, несколько сценариев используются только в тестах.
Изменения прежней аудитории и stop/resume реализованы в #29; редактор и сквозная приёмка остаются
отдельной поставкой. [#30](https://github.com/sachkov-inside/inside-telegram/issues/30) добавляет разовые рассылки через
общий отправитель, снимок аудитории при запуске, аналитику контактов/источников/доставки и токены
переходов для Platform. UI и redirect consumer поставляются отдельно; это ещё не сквозная готовность.
Marketing по умолчанию выключен.

## Repository and ownership

- GitHub repository: private `sachkov-inside/inside-telegram`.
- Local checkout convention: `repositories/telegram` inside the Workspace multi-root checkout.
- Default branch: `main`.
- Dedicated new bot; display name direction: `Sachkov Inside`.
- Кирилл является primary BotFather owner; recovery должна быть документирована до credentialed
  proof.
- Exact bot username остаётся открытым до проверки доступности и отдельного BotFather write.

## Product boundary

- Первый release — Membership bridge, а не campaign platform.
- Linking использует `/start`, а не Telegram OIDC.
- Обычный `/start` создаёт BotContact без требования Account link.
- V1 outbound messages только transactional.
- В будущем тот же bot владеет communications и marketing capabilities через отдельные specs.
- Все BotContacts являются будущей messaging audience; отдельного consent/category state нет.
- Пользователь останавливает delivery через Telegram block; `/stop` не входит.
- Contact/link/history автоматически не удаляются; повторный `/start` реактивирует contactability.

## Membership and authority

- Один canonical closed Telegram chat является Membership Signal.
- Tribute/payment state не является identity, evidence, entitlement или content access.
- Telegram application владеет Telegram identity proof, BotContact, link invariants, member-status
  events, reconciliation и normalized evidence.
- Platform владеет Account, permission, Membership Entitlement и финальным ContentAccess.
- Positive evidence validity не превышает пять минут; stale/unavailable state fails closed.
- Exceptional identity transfer выполняется только audited owner procedure.

## Confirmed starting production baseline

- Application stack starts with TypeScript, Node.js 24 LTS, NestJS with Fastify, grammY,
  PostgreSQL, and Kysely with `pg`.
- PostgreSQL + Kysely is the production persistence baseline from the first runtime slice; it does
  not require a separate database-selection proof.
- Exact dependency versions, process shape, HTTP authentication, webhook topology, worker
  mechanism, physical schemas, and deployment remain decisions of the applicable vertical ticket
  or later application ADR.

## Implementation gate

Workspace PR [#88](https://github.com/sachkov-inside/workspace/pull/88) synchronizes the shared and
Platform contracts with the confirmed `/start`, BotContact, linking and asynchronous Membership
Evidence flow. Runtime ticket #3 begins only after that contract PR and repository bootstrap #2
are merged; this gate has no remaining product decision to repeat.

## Unresolved next-artifact decisions

- exact bot username and BotFather registration result;
- exact canonical/test chat and minimum bot administrator rights;
- Platform-to-Telegram and Telegram-to-Platform authentication mechanism;
- webhook/public callback environment and secret custody for credentialed proof;
- durable update acknowledgement, reconciliation worker, retry and scheduling mechanics;
- physical PostgreSQL schema and data minimization/privacy policy details;
- production release topology and every post-v1 messaging/marketing capability.
