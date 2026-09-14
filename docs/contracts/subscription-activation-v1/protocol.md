# Subscription activation v1

The separate TELEGRAM_ACTIVATION_INGRESS_SECRET authenticates Telegram's course-source authority. No community-dispatch, membership-evidence or notification credential is interchangeable. All requests use private bot identity, never a user-supplied Account ID or membership statement.

POST /integrations/telegram/v1/subscription-activation/attempts persists attemptId and rule revision. Without an Account it creates no access. The same attempt resumes after linking. POST /evidence accepts source proof: exact audience, sourceRef, identityRef, accountRef, linkRef/linkRevision and ruleId/ruleRevision. checkedAt must not be future or more than five minutes old; validUntil must be future and at most five minutes after checkedAt. Clock and relational constraints are runtime assertions, not only JSON Schema validation.

Course identity is SHA-256 of UTF-8 JSON array ["course", sourceRef, identityRef]. Different links/rules for this source do not produce new rights. Only the first committed activation starts the unlimited period. Enrollment, grant, source relation, access change, attempt result and evidence receipt commit atomically. Revoke is an independent owner decision: retries never undo it. A lost answer is retried using exactly the original evidenceRef and payload. An expired proof requires fresh source verification.

POST /own-access requires the exact current private binding and returns independent grounds, Enrollment snapshots and admission state. A tariff never clears moderation. Responses are private/no-store. Examples contain synthetic identifiers; no provider is enabled by this bundle. Telegram #64 implements the consumer and real source verification.

## Current binding lookup (Platform #627)

`POST /integrations/telegram/v1/subscription-activation/binding` is an additive v1 operation. Portable definitions `bindingQuery` and `bindingResponse` in `schema.json` are authoritative; fixtures exercise both production Zod and JSON Schema. It uses only the existing `TELEGRAM_ACTIVATION_INGRESS_SECRET` bearer credential. Missing, invalid and other integration credentials return HTTP 401. All responses, including errors, carry `Cache-Control: private, no-store`.

The strict request is `{"contractVersion":"inside.subscription-activation.v1","identityRef":"identity-course-buyer"}`. The source authority supplies the privately verified identity; this is not username discovery or a public Account search. No internal Account UUID is accepted or returned. References are nonempty strings of at most 256 characters.

HTTP 200 returns one of:

- `{"ok":true,"value":{"contractVersion":"inside.subscription-activation.v1","state":"linked","binding":{"accountRef":"platform-principal","identityRef":"identity-course-buyer","linkRef":"00000000-0000-4000-8000-000000000002","linkRevision":2}}}`
- `{"ok":true,"value":{"contractVersion":"inside.subscription-activation.v1","state":"unlinked"}}`
- `{"ok":false,"error":{"code":"invalid_input"}}`, with `identity_conflict` or `unavailable` as the other allowed codes.

All objects reject unknown fields. `linkRef` is a UUID and `linkRevision` a positive integer. Linked references come exactly from Platform's current account-link state; the browser linking transaction's `linkRef` is not interchangeable. An absent or tombstoned binding is unlinked. Multiple current bindings are identity_conflict. Storage/provider read failure or malformed dependency output is unavailable, never an unlinked fallback.

Telegram can begin an attempt before linking, then look up the current binding before sending fresh verified evidence or querying own-access. Lookup creates no access and reserves no binding: a subsequent relink/unlink still causes existing exact evidence and own-access validation to reject stale references. Resolve the current binding again before constructing fresh evidence; do not rewrite an already accepted evidence receipt. Exact lost-response replay retains its existing durable result even after unlink. This endpoint performs no Telegram membership verification itself.
