# Sachkov Inside Telegram

Private repository for the Telegram application of Sachkov Inside.

The application starts as a production-grade Membership bridge and later becomes the Telegram
surface for Inside communications and marketing. Its first delivery connects a Telegram contact
to a Platform Account, observes membership in the canonical closed chat, and supplies bounded
evidence to Platform without making content requests wait for Telegram.

Current stage: **initial Membership Evidence after `/start <token>` linking**. Final Platform
confirmation durably schedules a canonical-chat check; a worker verifies the bot administrator
prerequisite, calls `getChatMember`, normalizes the result, and creates a finite versioned envelope
for asynchronous authenticated delivery to Platform. Bot registration, real credentials,
member-status events, reconciliation, deployment, and production enablement remain explicit later
gates.

## Ordinary `/start` runtime

- `POST /webhooks/telegram` requires an exact `X-Telegram-Bot-Api-Secret-Token`. A valid update is
  acknowledged only after the unique `(bot_identity, update_id)` inbox record commits.
- The update worker accepts only private non-bot `/start` commands. Group/channel updates,
  missing or bot senders do not create contacts. Tokenized starts create/reactivate the same
  independent contact even when their token is malformed, unknown, expired, or replayed.
- `BotContacts.observeStart` atomically creates/reactivates the contact, records Contactability
  history, and creates one start-response delivery intent. It stores exact decimal Telegram IDs in
  PostgreSQL and never keys identity by username.
- Private `my_chat_member` block observations preserve the contact and history; a later `/start`
  restores Contactability.
- Delivery records `delivered`, stable Telegram API rejection, retryable Telegram API rejection,
  and unknown transport outcomes as distinct typed attempts. Retries stop after three attempts;
  unknown outcomes retain the diagnosable duplicate risk.
- `GET /health`, `GET /ready`, and `GET /metrics` expose redacted operational signals. Processed or
  terminally failed inbox rows retain their deduplication key but discard the provider payload.

`TELEGRAM_DELIVERY_MODE=disabled` is the safe default. It still processes starts and creates the
durable welcome intent, but it never calls Telegram. Enabling `live` requires a bot token and the
separate owner gate for external messaging.

## Platform identity-linking contract

- `POST /integrations/platform/v1/identity-links` requires
  `Authorization: Bearer <PLATFORM_INTEGRATION_SECRET>` and an
  `inside.identity-linking.v1` envelope. Platform generates the raw bearer and sends only its
  SHA-256/base64url digest, an opaque Account reference, expiry, and return correlation.
- A raw deep-link token uses only base64url characters, is 43–64 characters long, and expires no
  later than ten minutes after registration. Telegram ingress replaces it with the digest before
  the durable update commit; neither the bearer nor Platform email/raw identifiers enter stored
  link state or the wire response.
- The first valid private `/start <token>` atomically consumes the transaction and records a
  Telegram candidate, but creates no `PlatformLink`, Membership Evidence, entitlement, or access.
  Every tokenized start plans the same neutral link-receipt message, including malformed, expired,
  replayed, and conflicting receipts, so the bot discloses no Account state.
- `POST /integrations/platform/v1/identity-links/:linkTransactionRef/confirm` uses the same Bearer
  credential and requires the original Account reference and return correlation. Outcomes are
  `pending`, `linked`, `idempotent`, `expired`, `malformed`, or `recovery-required`; Telegram-side
  receipt outcomes additionally distinguish `replayed` and `conflict` while the bot response stays
  neutral.
- One Telegram identity remains historically bound to its first Platform Account. Repeating that
  pair is idempotent; attempting the same identity with another Account requires the future audited
  owner recovery in issue #9.

The executable wire schema and named fixtures live in
[`src/modules/identity-linking/contracts/inside-identity-linking-v1/`](src/modules/identity-linking/contracts/inside-identity-linking-v1/).
The Workspace-owned Membership Evidence schema and fixtures are vendored with a reviewed source
commit and SHA-256 snapshot in
[`src/contracts/inside-membership-evidence-v1/`](src/contracts/inside-membership-evidence-v1/).

## Initial Membership Evidence

- `TELEGRAM_CANONICAL_CHAT_ID` is required configuration and contains no committed real chat
  identifier. `TELEGRAM_MEMBERSHIP_MODE=disabled` is the safe default; `live` additionally requires
  `TELEGRAM_BOT_TOKEN`.
- A final link confirmation creates one durable initial check. Telegram reads happen in the worker,
  never in Platform confirmation or a content request.
- `creator`, `administrator`, `member`, and `restricted + is_member=true` normalize to `member`;
  `left`, `kicked`, and `restricted + is_member=false` normalize to `not_member`; unknown values,
  API errors, timeouts, or a missing bot administrator prerequisite fail closed as `unavailable`.
- Successful observations atomically allocate a monotonic per-link evidence version. Positive
  evidence expires after five minutes; unavailable results carry no revision or new validity.
- The exact `inside.membership-evidence.v1` envelope enters a durable outbox. Retries reuse one
  `Idempotency-Key`; `PLATFORM_EVIDENCE_DELIVERY_MODE=live` requires a separate endpoint and Bearer
  credential.
- A separate Telegram delivery intent reports linked member, non-member, or temporary unavailable
  state without promising content access before Platform accepts the evidence.

## Durable documents

- [`docs/product/telegram-application-brief.md`](docs/product/telegram-application-brief.md) —
  confirmed product outcome and v1 boundary.
- [`docs/decisions/seed-decisions.md`](docs/decisions/seed-decisions.md) — confirmed decisions and
  unresolved inputs for the next artifact.
- [`CONTEXT.md`](CONTEXT.md) — canonical application terminology.
- [`docs/research/telegram-bot-membership-v1.md`](docs/research/telegram-bot-membership-v1.md) —
  official Telegram Bot API and grammY facts plus credentialed proof gaps.
- [Telegram Membership bridge v1 Specification](https://github.com/sachkov-inside/inside-telegram/issues/1)
  — native parent of the approved vertical delivery tickets.

## Delivery

Issues and pull requests are projected into
[Inside — Developer Pipeline](https://github.com/orgs/sachkov-inside/projects/1). Read
[`AGENTS.md`](AGENTS.md) first, then [`WORKFLOW.md`](WORKFLOW.md) for branch, pull-request,
verification and owner-merge rules. The active delivery chain is rooted at
[#1: Telegram Membership bridge v1](https://github.com/sachkov-inside/inside-telegram/issues/1).

## Local development

Use Node from `.node-version`, then:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm infra:up
pnpm db:migrate
pnpm dev
```

The example configuration binds locally, uses PostgreSQL on port `5433`, and keeps Telegram
delivery disabled.

## Current verification

The full repository check uses a real PostgreSQL database:

```bash
pnpm infra:up
DATABASE_URL=postgresql://inside:inside@127.0.0.1:5433/inside_telegram pnpm check:full
```

The application CI runs the same command on Node 24 with PostgreSQL 18. The repository harness is
verified with:

```bash
git diff --check origin/main...HEAD -- . ':(exclude).inside-harness/skills/**'
test "$(readlink .agents/skills)" = "../.inside-harness/skills"
test "$(readlink .claude/skills)" = "../.inside-harness/skills"
test -f .inside-harness/skills/REGISTRY.md
```

A managed harness release is additionally checked from the canonical Workspace root:

```bash
harness/bin/inside-harness health repositories/telegram
harness/bin/inside-harness diff repositories/telegram
```

These Workspace-only harness checks do not create an application build/runtime dependency.

## Repository boundary

This repository will own Telegram bot identity handling, bot contacts, linking, member-status
updates, reconciliation, and normalized Membership Evidence. Platform remains the authority for
Platform Accounts, permissions, entitlements, profiles, and every content-access decision.
