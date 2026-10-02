# inside-telegram

## Repository role

This repository owns the Sachkov Inside Telegram application: BotContact lifecycle, `/start`
linking, Telegram identity invariants, canonical-chat Membership observations, reconciliation,
normalized Membership Evidence, author templates, and the versioned communications boundary. Platform remains
the authority for Accounts, permissions, entitlements, profiles, and every content-access decision.

## Working agreements

- For product scope, read `docs/product/telegram-application-brief.md`.
- For community entitlements from Platform, read
  `docs/integrations/community-entitlements-v1.md`; its accepted contract is
  `docs/specifications/community-and-notifications-v1.md`.
- For author templates, communications API or Platform authorization, read
  `docs/integrations/communications-v1.md`.
- For sales funnel events to Platform, source labels or the consent step, read
  `docs/integrations/sales-funnel-events-v1.md`.
- For confirmed bootstrap stack, credentialed-proof gates, and unresolved setup decisions, read
  `docs/decisions/seed-decisions.md`.
- For canonical terms, read `GLOSSARY.md`.
- For GitHub issue routing or Wayfinder operations, read `docs/agents/issue-tracker.md`.
- For readiness-label triage, read `docs/agents/triage-labels.md`.
- For repository ownership or ADR placement, read `docs/agents/domain.md`.
- For which document owns a changed fact, read `docs/agents/documentation-maintenance.md`.

## Commands

`pnpm check:full` is the check that defines done: it must be green on the final head. Run from this
repository with Node from `.node-version`:

```bash
pnpm install --frozen-lockfile
pnpm infra:up
DATABASE_URL=postgresql://inside:inside@127.0.0.1:5433/inside_telegram pnpm check:full
git diff --check
git diff --cached --check
git diff --check origin/main...HEAD -- . ':(exclude).agents/skills/**'
```

`compose.yaml` fixes the project name `inside-telegram` and ports 5433/5673/15673, so a second
worktree running `pnpm infra:up` takes over another session's containers. While another session
owns them, start your own PostgreSQL and RabbitMQ on other loopback ports and point
`DATABASE_URL`, `NOTIFICATION_TEST_AMQP_URL` and `NOTIFICATION_TEST_MANAGEMENT_URL` at them; give
that RabbitMQ a non-`guest` user, because `guest` connects only from inside its container.

Use `pnpm infra:down` when the local PostgreSQL service is no longer needed. `pnpm check` runs all
checks that do not require PostgreSQL; `pnpm test:integration` always uses a real PostgreSQL
database through `DATABASE_URL`.

## Boundaries

- Keep this repository autonomous: vendor versioned cross-repository schemas and fixtures for
  tests; use authenticated runtime interfaces instead of source, database, or checkout sharing.
- Keep bot tokens, webhook secrets, chat identifiers, user data, and provider payloads out of Git
  and redacted from logs, fixtures, issue bodies, and pull-request evidence.
- Treat BotFather writes, chat administrator changes, credentials, external messages, marketing
  enablement, and releases as explicit owner gates; `Owner gates` in `WORKFLOW.md` lists the rest.
- First delivery is the Membership bridge in the product brief. Communications and marketing use
  later Specifications and do not expand bridge tickets implicitly.

## Process

- The developer process is `WORKFLOW.md` plus the skills in `.agents/skills`; `.claude/skills` is a
  symlink to them. Both are a byte-for-byte copy from `platform`. Do not edit them here: change
  them in `platform` and run its `scripts/copy-process.sh` against this repository.
- Read `WORKFLOW.md` when the task touches issues, branches, pull requests, review, readiness, or
  merge.
- The owner starts grilling, the specification and the ticket breakdown, each with its own command.
  A `ready-for-agent` implementation task runs to a ready pull request without stopping.
- Start a development session in this repository so its rules and skills load; a parent directory
  does not carry them.

## Human communication

- Speak to the user in their language. In Russian, prefer ordinary Russian words over optional
  English terms. Keep code, commands, exact product or API names, and established project terms
  unchanged. Do not invent abbreviations.
- Lead with what happened or what must be decided and why it matters. Use short, natural sentences
  with one idea each. Remove filler, but keep normal grammar.
- Use an unfamiliar specialist term only when it is needed for the current decision. Explain it in
  plain words on first use.
- When offering a choice, name the decision directly. Give each option a short everyday label and
  one sentence explaining what it changes. Mark the recommendation and explain its reason plainly.
- When a choice depends on facts not yet measured, state the criterion that decides it and what
  each outcome of the measurement means, so whoever measures can apply it without a new decision.
