# Communications integration v1

This application owns the physical `inside-communications-v1` schema and fixtures under
[`src/modules/communications/contracts/inside-communications-v1/`](../../src/modules/communications/contracts/inside-communications-v1/).
The product authority remains the accepted
[Workspace contract](https://github.com/sachkov-inside/workspace/blob/1553211220c44882dbacce7519dd50e35493090e/docs/specifications/telegram-communications-v1.md).
This document describes the transport implemented by [Telegram #27](https://github.com/sachkov-inside/inside-telegram/issues/27)
the funnel runtime in [Telegram #28](https://github.com/sachkov-inside/inside-telegram/issues/28),
and audience updates/preferences in [Telegram #29](https://github.com/sachkov-inside/inside-telegram/issues/29),
not a second product brief.

## Implemented operations

`POST /integrations/platform/v1/communications` uses the existing
`Authorization: Bearer <PLATFORM_INTEGRATION_SECRET>` service authentication. The Platform server
owns the authenticated Account context; never expose this credential in browser/MCP clients or let
clients supply the actor. It passes only `{ accountRef }`, derived from the authenticated Account.
Telegram rechecks `communications:manage` through the authorization operation below on every
request, including idempotent replay and reads. A service credential is the trust boundary for the
asserted actor; possession of a template ID or an arbitrary browser actor grants no authority.

The exact closed request shape is in schema definition `request`. Every command/query includes
`contractVersion`, `operation`, UUID `operationId`, bounded `actor`, `expectedRevision`, and its
operation-specific `payload`. Unknown fields and versions return `400 malformed`.

- `templates.save`: caller allocates `templateId`; revision `0` creates a template, current revision
  updates it. Each save increments the revision. A mismatched revision returns `409 revision_conflict`.
- `templates.read`: returns the current snapshot for the authenticated owner and configured bot.
  It uses `expectedRevision: 0`; reads do not mutate or cache operation results.
- A foreign or missing template returns `404 not_found`. Templates are scoped to the creating
  Account and bot. Delegated UI/MCP operations use that same Account actor.
- A repeated save operation returns the original committed result, even after later edits. A
  changed request or actor under that operation ID returns `409 operation_conflict`. Authorization
  is still required. Request, actor and result commit atomically with the template.
- Successful responses have `{ contractVersion, status: "ok", template }`; definition `response`
  also describes later query/command results. Stable errors map to `401 unauthorized`, `403 forbidden`,
  `404 not_found`, `400 malformed`, `422 unsupported_content`, `409 revision_conflict|operation_conflict`,
  `503 authorization_unavailable`, and `501 not_implemented`.

## Funnel operations and runtime

`funnels.save/read/list/publish/lifecycle/rollback`, `intro.save/read`, `deliveries.read` and
`delivery.resolve` are implemented.
They use the same service credential, fresh Account permission check, owner isolation, expected
revision and durable operation replay as templates. Save creates/updates the draft; source CRUD
is the draft's `sources` list. Publish freezes the entire draft, including entry response, step
parts and buttons, in an immutable publication record. Revision increases on every mutation;
replay of the same operation returns its original result even after later changes. List and
history pages contain at most 100 items with opaque UUID cursors. History includes the contact's
common intro and individual multipart states/attempts, without raw Telegram IDs.

Sources keep their ID/code reservation after removal or archive. A removed source no longer
routes after publish; reuse for another funnel is rejected. Step IDs and part ownership remain
historical. Reusing a deleted step, moving a historical part to a different step or replacing the
initial response ID is rejected. Content can be changed under its existing ID. Archive is the
non-destructive removal operation. `pause/resume/archive/restore` preserve enrollment and delivery
history; restore returns to paused. Exactly one published selection is used by ordinary `/start`.
Publishing a new default changes that selection atomically; draft `isDefault` describes the
selection requested at its next publication.

`intro.save` configures the one bot-wide common block under a stable `introId`; it has no implicit
Telegram send. Later edits do not resend an already claimed intro. No definitions, scenarios or
author copy are seeded by migrations. The current owner direction is one common funnel, with
owner-authored content; multiple funnels exist only in synthetic tests for the runtime contract.

`TELEGRAM_MARKETING_ENABLED=false` is independent of service delivery and is the default.
Before starting enabled workers, the application requires an intro and an available published
default funnel. Marketing dispatch additionally uses `TELEGRAM_DELIVERY_MODE=live`; its production
transport is otherwise disabled. The release gate is still separate, until
Platform convergence completes. Defining or publishing a draft never changes this configuration.

Ingress reserves `m_` plus 1–40 base64url characters for marketing sources. The 42-character
maximum deliberately stays below **every** legacy 43–64-character auth token, including tokens
starting with `m_`. The narrowed source schema and positive/negative fixtures prevent generating
an unreachable source. The merged #24 adapter handles `signin_` plus 35 base64url characters
and private confirmation callbacks. Malformed short sign-in payloads stay in that service lane.
Marketing and preference commands do not capture auth or sign-in callbacks.
An unavailable/unknown source gets a durable fallback and a `/start` keyboard button without
joining a different funnel. A thematic entry enrolls only its own funnel. Update receipts dedupe
fallback, intro and immediate response intents; deliberate new updates record separate source
events and repeat only the entry response, preserving the initial enrollment response anchor.

Migration `011-communication-funnels` owns definitions, publications, source/step reservations,
opaque communication contacts, source events, enrollments, per-part delivery state and shared
transport slots. Intro has one unique delivery key per contact. Each scheduled step has one key
per enrollment and stable step ID. The next step is materialized only after the preceding step's
confirmed terminal completion; its due time is `max(enrolledAt, firstPublishedAt, previousCompletionAt)
+ delay`. A restarted worker reads this state from PostgreSQL. There are no daily caps or quiet
hours between funnels. A pending initial response must finish before its scheduled steps.

The short claim transaction serializes workers for one bot and commits an `in_flight` part with a
unique attempt ID **before** external I/O. Recovery and result recording acquire the same scheduler
lock before reading delivery state, so recovery cannot overwrite newly confirmed parts. A stale claim becomes `unknown`, never sendable again
by lease expiry. Lost transport responses are unknown; confirmed API rejections get bounded
retries (at most three attempts per part) or a terminal failure. `429 retry_after` defers the bot's
shared capacity. The result transaction records the exact attempt and completion; a lost database
acknowledgement cannot turn persisted `sent` into another dispatch. Late evidence for the same
attempt can settle unknown to sent without erasing the earlier uncertainty. Confirmed parts are
never retried. Failure/unknown blocks remaining parts and subsequent scheduled steps in that funnel.

The shared PostgreSQL transport reservation allows one private-chat message per second and one
bot message per 40 ms, with no paid broadcast mode. Service responses have priority before marketing
claims and use the same slots while marketing is enabled. Their worker cycles are independent,
so slow marketing I/O cannot hold up service processing; marketing API calls time out after ten seconds. These conservative intervals follow the
[Telegram limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this).
Contactability and the persisted marketing preference are reread under row locks before the
marketing claim; lifecycle is checked under the publication row lock. External calls already
claimed cannot be cancelled retroactively. Test transport covers all six supported media types.

Published changes reconcile all enrollments, including completed participants, under the same
scheduler transaction lock as claim, result recording, stop and contactability changes. Only an
unattempted step adopts the current snapshot/delay/order. A started step owns its lane until a
terminal result, even if moved or deleted. The next delay uses the latest actual terminal
completion in that enrollment, independent of the new order. Delete sets cancel-request, cancels
pending/failed parts and waits for in-flight/unknown parts. History exposes `sent`, `cancelled`,
`skipped` and `suppressed` separately; `completedAt` appears only when all parts are terminal.
A sent/cancelled combination is a terminal partial cancellation, never a full sent result.

`funnels.rollback` takes a historical `publishedRevision` and creates a new publication under the
current expected revision. Historical IDs and first publication times survive. It can restore a
never-attempted deletion cancellation; sent, skipped and subscriber-suppressed markers never reset.
`delivery.resolve` takes a delivery revision, part ID, `skip|retry` and `duplicateRiskAccepted`.
Only failed/unknown parts can be resolved. Unknown retry requires explicit risk acceptance; a
cancel-request prohibits retry. The response is `{ deliveryId, partId, outcome }`, with outcome
`skipped|retry_requested`. Original attempt evidence remains unchanged; the authorized operation
stores actor, decision and result atomically. Retry acceptance appears on the following attempt.
Repeated operation IDs return the same result after fresh permission checking. At most three
automatic attempts are allowed; explicit decisions cannot grow history past the bounded limit.

Private human `/stop` and `/resume` persist one global preference and a deduplicated service reply
in one transaction, independently of marketing enablement. `/start` and sign-in never change that
preference. A stopped subscriber can request entry navigation and retain several enrollments.
Migration `012-marketing-preferences` adds the unavailable interval and preference receipts after
the merged sign-in/communications history. It is not another exception to migration ordering.
On resume or restored contactability, the current unsent order computes a virtual schedule: every
due time no later than the return time becomes a durable suppression; the first future due stays
unchanged. Operator pause/archive do not suppress overdue work. Unfinished immediate/started work
receives cancel-request when availability is lost; no already claimed external effect is undone.

`funnels.preview` reads draft/published step differences and the current eligible enrolled audience
under the definition/scheduler locks. It includes completed participants receiving added steps,
excludes stopped/unavailable contacts, and preserves all definitions and delivery history. It does
not send, reserve an operation receipt or calculate Platform content eligibility. Platform #308
adds the owning content validation to this preview.

Broadcasts, explicit test send, eligibility, tracking and statistics remain
contract-only and return `501 not_implemented`. Platform #308 owns the editor and target validation;
#310 owns complete user acceptance. Eligibility remains Platform-owned; tracking's bounded service
actor cannot manage communications. These changes do not enable a marketing release.

`test/integration/funnels.integration.test.ts` proves author isolation and revision conflicts,
parallel source entry and intro dedup, relative scheduling, two workers, 429, unknown, shared
service priority and crash boundaries against real PostgreSQL. It also covers completed/ongoing
backfill, pending edits and reorder, rollback, multipart cancel with unknown resolution, explicit
retry evidence, stop before/after due, first future due, edits while stopped, blocked/unblock,
operator pause, first entry while stopped and stop/publish against an in-flight external send. `test/unit/grammy-communications.adapter.test.ts`
covers transport mapping and namespace boundaries; the versioned schema fixtures include a
positive marketing source and a negative legacy-auth collision. Adapter architecture checks also
run their existing passing and deliberately failing seam fixtures.

## Platform author authorization operation

Telegram calls the configured `PLATFORM_AUTHOR_AUTHORIZATION_URL` by `POST` with
`Authorization: Bearer <PLATFORM_AUTHOR_AUTHORIZATION_SECRET>`. Platform #307 implements this
operation, conventionally at `/integrations/telegram/v1/communications/authorize`. The separate
outbound secret follows the existing evidence-delivery authentication pattern. Endpoint configuration
requires HTTPS except on loopback; redirects are rejected and requests time out after five seconds.
No result is cached. Both settings absent means fail closed; partial configuration fails startup.

Schema definitions `authorizationRequest` and `authorizationResponse` are the provider/consumer
seam. The request contains the contract version, fresh UUID `requestId`, exact permission
`communications:manage`, and one subject:

- `{ kind: "telegram", botIdentity, telegramIdentityRef, accountRef }`: the application resolves
  the identity and Account from its persisted confirmed PlatformLink, never username or forward
  metadata. Platform must verify the same **current confirmed** association and permission.
- `{ kind: "account", accountRef }`: Platform verifies the Account and current permission for a
  service-authenticated facade call. `materials:manage` alone is insufficient.

An allowed response echoes the version, request ID and exact Account reference with
`status: "allowed"`; a denied response echoes version/request ID with `status: "denied"`. Unknown,
revoked, inactive or mismatched subjects are denied. Missing/malformed/unavailable responses never
authorize. HTTP 401/403 deny; transport/provider errors fail closed as unavailable. No Telegram raw
ID, credentials or provider payload is returned by the management API.

## Author intake and snapshots

`/template` in a private human conversation opens one-message author mode after authorization.
The next supported message saves a snapshot and returns its UUID for pasting into the Platform
editor. `/cancel` exits. Successful capture exits; unsupported content leaves the mode open for a
correction. Media outside author mode is ignored. Authorization is checked again at capture, and
revocation clears the mode. An unavailable author check retries through the existing bounded inbox
policy; exhausted updates retain only redacted failure state and the author must retry explicitly.

The adapter accepts text, photo (largest provided size), video, video_note, voice and document.
Text/caption, supported entities, explicitly supplied URL buttons and bot-scoped `file_id` are
stored; provider metadata and media bytes are not copied. Edits, deletion, callbacks and source
message existence are not consulted after capture. Text is bounded to 4096 UTF-16 code units and
captions to 1024; video_note has no caption. A circle plus explanation is represented by separate
parts in later step/broadcast contracts.

The `entity` definition enumerates the supported subset. Validation rejects invalid UTF-16 ranges,
split surrogate pairs, illegal overlapping/nested entities, unknown entity types, albums, polls,
animation/audio/sticker/rich/paid/live media, and non-URL reply markup. URL buttons and text links
use HTTPS without embedded credentials; Telegram download endpoints are rejected. A failed
validation never truncates text or silently drops an entity. These constraints use the official
[MessageEntity](https://core.telegram.org/bots/api#messageentity) and
[sendVideoNote](https://core.telegram.org/bots/api#sendvideonote) documentation, checked 2026-09-06.

## Persistence and verification

Migration `010-communications-templates` adds templates, author modes, operation results and intake
receipts. The merged sign-in sequence owns `008-bot-sign-in`, `009-sign-in-reservation` and
`010-sign-in-message-result`. The migrator preserves the two supported historical deployment
orders through its explicit communications compatibility exception. Migration-history tests cover
both orders and reject missing dependencies; `012-marketing-preferences` follows the merged history.

Transaction-scoped PostgreSQL advisory locks serialize each author and template/operation. The
confirmed identity link is held against transfer during intake authorization and save. A unique
bot/update receipt, snapshot and durable reply intent commit in one transaction, making replay
after a lost acknowledgement safe. A later update cannot overtake an earlier pending message for
the sender. Existing inbox payload removal and start-response transport policies remain; a
transport-unknown receipt may repeat the same ID, but cannot create a second template. This is not
the future marketing delivery transport.

`fixtures.json` exercises valid and invalid wire shapes; `scenarios.json` is a versioned HTTP
sequence corpus for permission denial/revocation, foreign IDs, idempotency and stale revisions.
Consumers vendor these files and run their own adapter against them without a neighboring checkout.
`test/unit/communications-contract.test.ts` verifies shape/content and auth-routing regressions;
`test/unit/http-author-authorization.adapter.test.ts` verifies the Platform transport trust boundary;
`test/integration/communications.integration.test.ts` runs the shared scenarios against the actual
HTTP provider, PostgreSQL concurrency, rollback faults, lost acknowledgement replay, every media
snapshot and a fake Telegram transport. The existing adapter guardrail and negative fixture cover
the transport/persistence boundary in `pnpm check:full`.

The #29 review base is `fc4bdbead4b578763acd7778afa9e7686dabf17c`, including merged PR #25.
Full repository verification runs the actual combined sign-in, identity, Membership and
communications implementations with fake transports and real PostgreSQL. The author intake hook
runs only after the router returns ignored; `/stop` and `/resume` accept explicit private human
commands, while sign-in callbacks and legacy link tokens keep their existing handlers.

No real author permission endpoint, Platform editor, credentialed Telegram message, marketing
release or production enablement is proven here. Platform #307 supplies authorization, #308 the
editor, and #310 the cross-application acceptance. Every merge and release still requires owner GO.
