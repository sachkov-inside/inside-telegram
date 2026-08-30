# Sachkov Inside Telegram

Private repository for the Telegram application of Sachkov Inside.

The application starts as a production-grade Membership bridge and later becomes the Telegram
surface for Inside communications and marketing. Its first delivery connects a Telegram contact
to a Platform Account, observes membership in the canonical closed chat, and supplies bounded
evidence to Platform without making content requests wait for Telegram.

Current stage: **ordinary `/start` vertical slice**. The application validates an authenticated
Telegram webhook, commits every accepted update to PostgreSQL before `202`, creates or reactivates
an independent `BotContact` in asynchronous durable processing, and plans a transactional welcome
through a durable delivery queue. Bot registration, credentials, real external messages,
deployment, and production enablement remain explicit owner gates.

## Ordinary `/start` runtime

- `POST /webhooks/telegram` requires an exact `X-Telegram-Bot-Api-Secret-Token`. A valid update is
  acknowledged only after the unique `(bot_identity, update_id)` inbox record commits.
- The update worker accepts only an ordinary private non-bot `/start`. Group/channel updates,
  missing or bot senders, and tokenized starts do not create contacts in this slice.
- `BotContacts.observeStart` atomically creates/reactivates the contact, records Contactability
  history, and creates one welcome delivery intent. It stores exact decimal Telegram IDs in
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
verification and owner-merge rules. The first user-visible implementation ticket is
[#3: ordinary `/start`](https://github.com/sachkov-inside/inside-telegram/issues/3).

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
