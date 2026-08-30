# Sachkov Inside Telegram

Private repository for the Telegram application of Sachkov Inside.

The application starts as a production-grade Membership bridge and later becomes the Telegram
surface for Inside communications and marketing. Its first delivery connects a Telegram contact
to a Platform Account, observes membership in the canonical closed chat, and supplies bounded
evidence to Platform without making content requests wait for Telegram.

Current stage: **Specification and delivery bootstrap**. The product boundary, root delivery
Specification, vertical ticket hierarchy, project harness, Telegram API research and repository
automation are defined. Application code begins with the ordinary `/start` slice after the
cross-repository Workspace contract is synchronized. Bot registration, credentials, deployment,
and production enablement remain explicit owner gates.

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

## Current verification

Until #3 creates the application toolchain, a fresh clone verifies its local bootstrap with:

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

These Workspace-only release checks do not create an application build/runtime dependency.

## Repository boundary

This repository will own Telegram bot identity handling, bot contacts, linking, member-status
updates, reconciliation, and normalized Membership Evidence. Platform remains the authority for
Platform Accounts, permissions, entitlements, profiles, and every content-access decision.
