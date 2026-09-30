# Sales funnel events v1

Platform owns the contract `inside.sales-funnel-events.v1` and the Sales Funnel report
([platform#816](https://github.com/sachkov-inside/platform/issues/816), Platform document
`docs/integrations/sales-funnel-events-v1.md`). This document describes the Telegram side delivered
by [Telegram #118](https://github.com/sachkov-inside/inside-telegram/issues/118). The request and
receipt schemas are vendored verbatim from Platform's OpenAPI operation `recordSalesFunnelBotEvents`
in [`src/contracts/inside-sales-funnel-events-v1/`](../../src/contracts/inside-sales-funnel-events-v1/);
replace them only from a newer Platform OpenAPI.

## Events

Every event carries `eventId`, `contactRef` and `occurredAt`. `contactRef` is the contact's
`communication_contacts.contact_id`; a Telegram user id, username or name never enters an event.

| `kind` | Written when | Extra field |
|---|---|---|
| `bot_entered` | A private `/start` enters the marketing flow (`TELEGRAM_MARKETING_ENABLED=true`, no link, sign-in or activation token), once per Telegram update | `sourceCode`: the `m_…` label of the link, or `null` for `/start` without a label or with a label outside `^[A-Za-z0-9_-]{1,64}$` |
| `marketing_consent` | `/stop` (`granted: false`), `/resume` or the consent button (`granted: true`), once per Telegram update | `granted` |
| `account_linked` | A link to a Platform Account is confirmed, including an owner transfer to another Account | `telegramIdentityRef`, the ref of the linking protocol |

Source labels use the existing `m_` namespace: links are `?start=m_survey`, `?start=m_site`,
`?start=m_channel`, `?start=m_youtube` (coordinator decision for #118, 2026-09-30). Parsing of
`/start` parameters is unchanged; an unprefixed label such as `?start=survey` is still read as a
malformed link token and enters no funnel.

Marketing being enabled by default is not consent and produces no event. A contact without a
communication record (older data) gets one when its link is confirmed, as `/start` would create it,
so every confirmed link is reported.

## Consent step

`TELEGRAM_MARKETING_CONSENT_TEXT`, `TELEGRAM_MARKETING_CONSENT_BUTTON` and
`TELEGRAM_MARKETING_CONSENT_CONFIRMATION` are set together or not at all. When set, every marketing
entry into a published funnel sends the prompt with one button to a contact whose marketing is on
and whose latest explicit choice is not consent. The button (`marketing:consent`) records the same
preference as `/resume`, so it also turns marketing back on after `/stop`; it reports
`granted: true` and answers with the confirmation text. The step is a mechanism only: a contact
who has not pressed it still receives funnel messages, as before. Its wording, its placement in the
funnel and whether funnel messages should wait for it are decided with the funnel content in
[ai-engineering#189](https://github.com/sachkov-inside/ai-engineering/issues/189). Without the
texts no prompt is sent; `/stop` and `/resume` are still reported.

## Delivery

Each event is written to `sales_funnel_event_outbox` in the transaction of the fact it reports.
Its `eventId` is derived from that fact (SHA-256 of the fact name as an RFC 9562 version 8 UUID), so
a replayed update or a repeated emission yields the same id. Migration `029-sales-funnel-events`
queued past entries, `/stop`/`/resume` preferences and confirmed links once under the same ids.

With `PLATFORM_SALES_FUNNEL_DELIVERY_MODE=live`, the `sales-funnel` worker posts one event per
request to `PLATFORM_SALES_FUNNEL_EVENTS_URL`
(`https://<platform>/integrations/telegram/v1/sales-funnel/events`) with
`Authorization: Bearer <PLATFORM_SALES_FUNNEL_EVENTS_SECRET>`, which equals Platform's
`TELEGRAM_SALES_FUNNEL_INGRESS_SECRET` and differs from every other credential. One event per request
keeps a `409` from rejecting unrelated events.

- `200` with a receipt that accounts for the event marks it delivered; a duplicate is delivered too.
- `409` marks it `rejected` with `platform_event_conflict` and logs `event_conflict`: a contract
  error that needs a person, never retried.
- Every other answer, an invalid receipt or a transport failure retries the same event with backoff
  up to five minutes, without limit.
- With delivery disabled, events stay queued and are sent once delivery is enabled.

The behaviour is exercised by `test/integration/sales-funnel-events.integration.test.ts` against a
local double that validates the vendored schema and applies Platform's duplicate and conflict rules,
and by `test/unit/sales-funnel.test.ts`.
