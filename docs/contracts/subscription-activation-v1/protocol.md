# Subscription activation v1

The separate TELEGRAM_ACTIVATION_INGRESS_SECRET authenticates Telegram's verified identity and activation authority. No community-dispatch, membership-evidence or notification credential is interchangeable. All requests use private bot identity, never a user-supplied Account ID or membership statement.

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

## Temporary Tribute state (#625)

The shared Enrollment view state adds `pending_verification` and `suspended_source`. This shared definition occurs in BOTH `ownAccessResponse.value.enrollments[]` and `activationResponse.value.enrollment` (when non-null). The activation outcome's own state enum is unchanged. Binding operations are unchanged; the additive Tribute routing changes are specified below.

Platform owns these states. `pending_verification` means an approved temporary source lacks current usable confirmation (including TTL/timeout); it grants no temporary access. `suspended_source` means a confirmed source exit was latched; a later member observation does not restore that source. Telegram only validates and presents the state and offers the existing help/retry navigation; it does not derive policy or grant restoration. Independent Guide/course rights remain effective. Only Platform's explicit owner resolution or confirmed external period can replace an ended source.

## Tribute registry activation (#625)

Changed portable definitions relative to #627: `evidence.decision` adds `registry_lookup`; `activationResponse.value.rule` adds optional `verificationMode` (`course_membership` or `tribute_registry`). An absent mode retains the existing course behavior. Both nested Enrollment views also accept the two temporary states above. `begin`, `bindingQuery`, `bindingResponse` and `ownAccessQuery` are unchanged. No new endpoint or credential is introduced. Unknown mode/fields fail strict validation.

An opaque `a_<code>` may select a published, revisioned Tribute rule whose `sourceRef` names an owner-approved Platform Tribute policy. Its persisted verification mode is immutable. The code carries no recipient, chat, term or entitlement. Telegram supplies its privately verified recipient identity, so forwarding the link never selects the sender's source. No Account exists: persist the existing 30-day attempt and use ordinary sign-in/linking without grants. After linking, retrieve current binding and construct a fresh request against the rule revision.

For `tribute_registry`, Telegram must skip course `getChatMember` and submit `decision: registry_lookup` with the same exact audience, identity, binding, rule, timestamps and evidenceRef as the existing evidence envelope. These timestamps bound the authenticated request; they are not paid-period or membership proof. Platform rejects `member` as a substitute for a Tribute registry lookup and rejects `registry_lookup` for a course rule. Existing course links retain their source-group verification and unlimited course Enrollment without charge.

Platform alone reads the verified registry by policy and identity inside the locked activation transaction. No matching confirmed row, an unknown period, nonpaid trial/gift without an approved source, source mismatch or revoke yields `pending_review` with no new access. An explicit `confirmed_period` attaches its stored tier and exact finite period; current chat membership is irrelevant. A temporary row remains subject to its separately approved bounds and current evidence; registry lookup supplies no member observation and never restores a source_ended latch. Nonactive attached rows can be returned as `pending_review` with a non-null Enrollment; consumers must display its actual state instead of claiming activation succeeded.

Idempotency: a lost response must first replay the identical evidenceRef and payload, even if the binding subsequently changes. Accepted receipts are immutable. After a known pending/unavailable outcome, a user retry may obtain a fresh binding and submit a new evidenceRef to read newly confirmed registry facts. The durable attempt may be reused while its rule revision and retention remain valid. Multiple attempts or links with the same policy and identity use the same source key and Enrollment; neither replay nor repeat lookup changes its term. Own-access always performs current binding validation and presents all independent grounds.

Fixtures named Tribute positive/nonpaid/unknown-period/forwarded/duplicate are wire examples. Their policy relationships are assertions in `scenarios.json`, requiring real Platform PostgreSQL and consumer tests; schema validity alone does not prove access was granted or denied. Provider failures remain unavailable, never a fallback course or unlinked path.
