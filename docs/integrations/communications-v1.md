# Communications integration v1

This application owns the physical `inside-communications-v1` schema and fixtures under
[`src/modules/communications/contracts/inside-communications-v1/`](../../src/modules/communications/contracts/inside-communications-v1/).
The product authority remains the accepted
[Workspace contract](https://github.com/sachkov-inside/workspace/blob/1553211220c44882dbacce7519dd50e35493090e/docs/specifications/telegram-communications-v1.md).
This document describes the transport implemented by [Telegram #27](https://github.com/sachkov-inside/inside-telegram/issues/27)
the funnel runtime in [Telegram #28](https://github.com/sachkov-inside/inside-telegram/issues/28),
audience updates/preferences in [Telegram #29](https://github.com/sachkov-inside/inside-telegram/issues/29),
and broadcasts/analytics in [Telegram #30](https://github.com/sachkov-inside/inside-telegram/issues/30),
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

Eligibility remains contract-only and returns `501 not_implemented`. Explicit author samples are
implemented by `templates.testSend` in #37. Platform #308 owns the editor and target validation;
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

## Broadcast operations and analytics

`broadcasts.save/read/list/launch/lifecycle` use the existing Account authorization, revision,
operation replay and actor audit. Save creates a draft; `scheduledAt` alone never arms it.
`launch` arms the saved UTC schedule, or starts immediately if the time is absent or already due.
A future scheduled launch returns no audience snapshot. The worker records the actual launch time,
snapshot UUID and all recipient delivery intents in one transaction when it first processes the
armed schedule. The originating launch operation remains attached to that record. Replaying it
returns its original response; read returns the current state and revision.

The audience is all BotContacts or a deduplicated union of owned funnel enrollments. Legacy contacts
need no Account or enrollment. Stop and blocked contacts are excluded at launch. The shared
scheduler lock serializes launch, contact changes and dispatch claims. After launch, content and
audience cannot be edited. Resume preserves the snapshot; cancelled/completed IDs cannot launch
again. Pause before launch delays the snapshot until resumed. Cancel preserves in-flight/unknown
history and prevents new parts. Empty snapshots complete immediately.

Broadcasts use `communication_deliveries`, the same worker and Telegram capacity slots as funnels,
with service responses retaining priority. Stop/block persist `suppressed` on pending/failed parts,
including delayed retries; in-flight/unknown parts retain evidence and a cancellation reason.
Resume/unblock never revives these recipients. A confirmed Telegram 403 updates contactability and
suppresses remaining work. `delivery.resolve` and `deliveries.read` include owned broadcasts with
the same unknown-risk decision and immutable attempt history as funnels. A partial cancellation
never reports full success. These commands do not themselves send real Telegram messages unless
the separately gated live marketing runtime is enabled.

`statistics.read` provides bot-wide contact totals/reachability/preferences, distinct participants
in owned funnels, delivery counts, and paged contacts with first/latest sources and entry history.
Optional funnel/broadcast filters restrict delivery statistics and the contact page; global contact
totals retain their bot-wide meaning. Counts sent/suppressed/failed/unknown/pending count **parts**;
`partialCancelled` counts terminal deliveries containing sent and cancelled/suppressed parts.
`broadcasts.read/list` expose snapshot size and lifecycle; `deliveries.read` provides recipient
progress, cancelled/skipped parts and diagnostic reasons. Contact IDs are opaque; raw Telegram IDs,
provider payloads and credentials are not returned.

Pages have at most 100 records. Contact and broadcast cursors are UUIDs. Each contact contains the
first 100 entries and `nextEntryCursor`; `entries.read` with `contactId` and that cursor walks the
remaining history without truncation. Entry cursors are opaque. Default/unknown entries have nullable
source IDs; source code, funnel, outcome and timestamp are preserved. Duplicate webhooks add no
entry, while an intentional second start has its own observation. These are observations of entry,
not claims of purchase attribution or proof that the person read a material.

### Tracking consumer seam

The optional paired `PLATFORM_TRACKING_REDIRECT_URL` and `PLATFORM_TRACKING_TARGET_PREFIXES` configure
one Platform redirect route and a JSON array of trusted content URL prefixes. Prefixes are normalized
HTTPS URLs with non-root paths ending in `/`; configure only actual content routes, never generic
redirect/auth endpoints. No credential, query or fragment is accepted. Absent configuration leaves
original links intact; partial or unrestricted configuration fails startup. Prefix examples in
`.env.example` are synthetic and do not assert the consumer's final route names.

Before a shared delivery claim commits, matching URL buttons and text-link/URL entities receive
opaque random tokens bound to the delivery, part and frozen destination. Text/entities retain their
UTF-16 offsets. Token creation and claim commit atomically; retry reuses the token. The stored
content snapshot remains the author's original content. Unmatched external links stay unchanged.

`tracking.resolve` and `tracking.recordHit` require the existing service bearer credential and the
closed `{ serviceRef: "platform-tracking" }` actor. The tracking actor cannot manage communications;
an Account actor cannot use the tracking route. Resolve accepts only a token, rechecks its persisted
destination against current configured prefixes, and returns `safeUrl`. It accepts no redirect URL
and grants no content authorization.

`recordHit` accepts an event UUID, token, occurrence time and `unknown|known_automation` classification.
The persisted bot/event key makes concurrent/repeated ingestion idempotent; a changed payload under
that event or operation ID returns conflict. The service actor and operation are audited atomically
with ingestion. Future events beyond one minute and events predating token creation by
more than one minute are rejected. Repeated visits with different event IDs remain separate.
`trackingHits`/`uniqueTokensWithHits` exclude `known_automation`; `knownAutomationHits` is reported
separately. The consumer classifies known automation using its versioned rule; the provider does not
claim complete human detection. Forwarded links identify a delivery, not the visitor.

`analyticsLagSeconds` is the largest observed receive-minus-occur delay of ingested events in scope.
It cannot observe events still queued in Platform. Platform #309 must expose its own durable pending
queue/lag and preserve resolved navigation when ingestion fails. No click is treated as reading,
Account linkage, conversion or payment. There is no retention deletion of delivery/source/hit history.

Migration `013-broadcast-analytics` adds broadcasts and token/hit ledgers without rewriting earlier
migrations. `broadcasts.integration.test.ts` proves PostgreSQL snapshot/stop races, fake-clock schedule,
replay, cancel/unknown, 429/blocked, lost acknowledgement, source paging and authenticated event
negatives. `communication-tracking.test.ts` and versioned fixtures contain passing and rejected URL,
actor and redirect shapes. Full checks also retain sign-in, identity and Membership regressions.
All transports in these tests are fake. Platform #307/#309 supply consumers, and only #310 closes
cross-application acceptance. Real author copy, real Telegram delivery and production enablement
remain separate owner work.

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

## Legacy author composer and shared saved posts (#37)

The original composer remains for persisted-session recovery. The current `/admin` flow is
described in [Simple Telegram authoring](#simple-telegram-authoring-43). Every command and callback checks the current confirmed link
and `communications:manage`. The menu creates/replaces native posts, lists saved posts, configures
HTTPS button text/URL with automatic placement, sends samples to the author, and assembles ordered broadcast parts.
The all-contact audience, schedule (explicit Moscow UTC+3 input), launch/pause/resume/cancel and statistics call the
same `Communications`/`Funnels` operations as the authenticated API. `/template` remains compatible.
Callbacks carry a session menu token; stale menus cannot apply a mutation against a newer screen.
Session state, update receipt, operation receipt, mutation and author reply queue commit together.

`templates.list` returns at most 100 owner/bot-scoped snapshots and a UUID cursor. Optional zero-based
`button.row` groups buttons horizontally (maximum 8 per row, 20 total). Missing row preserves the
legacy vertical layout. The sender strips this internal metadata into Telegram inline keyboard rows.

`templates.testSend` requires the saved revision and queues that snapshot to the actor's confirmed
Telegram identity, with no caller-selected destination. Repeated operation IDs return the same
`testDeliveryId`. A separate author outbox runs with service delivery enabled, even when marketing
is disabled. It rechecks the persisted link/current permission, reserves shared transport capacity,
and commits `sending` before Telegram I/O. A lost reply or stale sending lease becomes `unknown`;
no automatic resend follows an uncertain result. Source edits never update queued samples.

A broadcast copies selected post content. Neither Telegram source edits nor `templates.save` silently
updates that copy: the author explicitly replaces a selected part before launch. Scheduled/paused
broadcasts retain the existing revision and lifecycle checks. No real sends or marketing enablement
are part of the local verification; real Telegram appearance remains owner acceptance.

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

## Legacy funnel author menu (#38)

`/admin` → «Воронки» uses the same persisted author session, fresh confirmed-link authorization,
update receipts and author-only outbox as posts and broadcasts. It creates and edits the entry
response, delayed multipart steps, order, delay (seconds/minutes/hours/days), default selection and
sources. The common intro is edited separately. Contents come from `templates.list/read`; choosing
copies the saved version, explicit replacement retains the part ID, and additions allocate new IDs.
Changing a saved post does not modify a chosen draft or publication.

Composition remains a private scratch snapshot until «Сохранить черновик» (durable recovery is
described under #43 below). Preview
and publish require the same saved revision; publication rechecks the exact snapshot under the
existing definition lock. Menu callbacks and business writes share one transaction and update
receipt. A savepoint rolls back a rejected funnel action before the menu reports a conflict,
including conflicts discovered after a draft write. Duplicate updates cannot publish or sample twice.
Archive, pause, resume and restore use the existing lifecycle operations. Detailed delivery history,
retry/skip and rollback remain available in the web editor and delegated operations.

`PLATFORM_AUTHOR_CONTENT_VALIDATION_URL` configures Platform's service-only
`POST /integrations/telegram/v1/communications/validate-content`; it reuses
`PLATFORM_AUTHOR_AUTHORIZATION_SECRET` and requires the authorization configuration. HTTPS is
mandatory outside loopback. Request/response definitions are `contentValidationRequest` and
`contentValidationResponse` in the canonical schema. The request includes the confirmed author and
the selected immutable message parts. Platform rechecks the author and Material/Series eligibility
without calling Telegram back while the author transaction holds definition locks. Request ID and
Account association must match the response. Invalid targets, denied authorization, missing
configuration, malformed response and unavailable Platform all prevent bot publication. The common
intro is checked before save because saving immediately applies it to future recipients.

No real Telegram send, marketing enablement or deployment is part of local verification. Author
samples are queued only for the confirmed author's private chat and use the existing transport gate.

## Simple Telegram authoring (#43)

The current `/admin` menu contains «Рассылки», «Воронки», and «Статистика».
Create a broadcast or funnel, send one native message, choose its time, then send the next.
«Готово» returns to the short summary. The incoming order is the delivery order; elapsed times
cannot decrease. Text, photo, video, video note, voice and document preserve native formatting and
file IDs. Albums are rejected without losing accepted messages. The first message supplies the name.
Broadcasts allow 20 messages; funnels allow 100 across entry and delayed steps.

A broadcast time is elapsed from its actual launch: «Сразу», «Через 1 час», «Через 2 часа», or
free text such as `20 минут`. The optional `sendAfterSeconds` on each broadcast part is an integer
0..2147483647, defaults to zero, and is nondecreasing. Saving never starts the clock. «Запустить»
shows confirmation; only the final confirmation launches for all eligible bot contacts. Stopped or
unreachable contacts are excluded. A scheduled API broadcast anchors offsets to actual launch too.
Pause suspends delivery without resetting the launch clock; resume sends overdue parts in order.
Cancel stops future parts. Retries and unknown outcomes keep the existing durable delivery policy.

A newly authored funnel sends its first message immediately on entry. Later messages use
`delayAnchor: "entry"` and `delaySeconds` from that person's entry, so +1h/+2h mean one and two hours,
not one then three. Previously saved steps without `delayAnchor` retain delays after the preceding
step. Entry-anchored steps still respect earlier unfinished delivery; a late worker catches up in
order. Saving remains separate from publication. «Сделать основной» selects the funnel for ordinary
entry; «Включить воронку» explicitly publishes. Existing published edits require «Применить изменения».
An unpublished draft can be archived/cancelled and restored to draft without publishing.

Each message waits in a durable bot/Account-scoped composition until its time is accepted.
Acceptance saves the canonical provider draft and update receipt atomically. `/admin` or restart
preserves pending content; reopen the draft and continue. An incomplete time, invalid message,
stale callback or revision conflict does not lose the candidate or attach it twice. «Не добавлять это
сообщение» discards just the pending message. «Готово» cannot bypass an unanswered time prompt.
The next message captures a fresh expectedRevision. Concurrent agent edits require reread/reconciliation.

The ordinary menu omits saved-post browsing, replacement, reordering, button rows and agent handoff.
Advanced authenticated API/MCP operations and legacy persisted composer recovery remain available.
The owner works with an agent in the terminal: list/read the canonical draft as the same Account with
`communications:manage`, preserve native content and stable IDs, then save using expectedRevision and
operationId. Replays reuse operationId. Bot token possession does not grant author access. Launch and
publication require the owner's instruction. Reopening the bot reads the same provider draft.
Platform vendors the additive timing schema and generates its HTTP/MCP validators from it.

Menu navigation updates the last confirmed author menu in place; native previews end with a fresh
menu. When the broadcast delivers to its linked owning author, the scheduler atomically enqueues a
fresh menu after the currently due group of posts. Future scheduled groups get their own footer.
Ordinary subscribers never receive admin controls. The footer only navigates; opening it rechecks
current permissions. Author delivery rechecks the link and permission before sending. Unknown
transport outcomes never trigger an automatic resend or a false successful-delivery footer.

Migration `015-author-drafts` owns private incomplete destinations and pending compositions. These checkpoints never authorize subscriber delivery. No new database migration
is required for timing: immutable delivery snapshots and published funnel JSON retain the new fields.
The schema fixtures, PostgreSQL author-flow tests and clock-controlled scheduler tests cover this
flow, exact elapsed times, pause/cancel, recovery, conflicts, permission boundaries and footer ordering.
