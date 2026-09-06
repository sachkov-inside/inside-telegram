# Communications integration v1

This application owns the physical `inside-communications-v1` schema and fixtures under
[`src/modules/communications/contracts/inside-communications-v1/`](../../src/modules/communications/contracts/inside-communications-v1/).
The product authority remains the accepted
[Workspace contract](https://github.com/sachkov-inside/workspace/blob/1553211220c44882dbacce7519dd50e35493090e/docs/specifications/telegram-communications-v1.md).
This document describes transport and the implemented template slice of
[Telegram #27](https://github.com/sachkov-inside/inside-telegram/issues/27), not a second product brief.

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

The schema also defines funnels, publish/preview/rollback, source links, broadcasts, explicit
retry/skip, test send, eligibility, tracking and statistics. They are **contract-only** in this
slice; they return `501`, create no runtime state and send nothing. `expectedRevision` is `0` for
queries/events and the current aggregate revision for mutations. The scheduling and publication
semantics remain in the Workspace contract and subsequent owning tickets. Eligibility is a
Platform-owned operation over published free Material/Series targets; the vendored envelope can
be used by its authenticated endpoint. Tracking uses the bounded service actor
`{ serviceRef: "platform-tracking" }`, because a public hit need not have an Account. That actor
is accepted only for tracking operations and cannot manage templates or communications.

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
receipts. Names 008/009 belong to the currently separate bot-sign-in PR #25; whichever change lands
second must reconcile migration order against deployed state before release. Do not install an
older missing migration behind an already applied migration.

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

The main baseline for this ticket is `04b572ad748423e193d918c1ceec552c3985bc84`. PR #25's sign-in
namespace (`signin_` plus 35 base64url characters, below the legacy 43–64-character range) was
inspected for compatibility: the new intake hook runs only after the existing router returns
ignored, never captures `/start`, and never processes callbacks. This is routing regression
coverage, not a claim that the unmerged sign-in implementation ran in this branch.

No real author permission endpoint, Platform editor, credentialed Telegram message, marketing
release or production enablement is proven here. Platform #307 supplies authorization, #308 the
editor, and #310 the cross-application acceptance. Every merge and release still requires owner GO.
