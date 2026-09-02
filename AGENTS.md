# inside-telegram

## Repository role

This repository owns the Sachkov Inside Telegram application: BotContact lifecycle, `/start`
linking, Telegram identity invariants, canonical-chat Membership observations, reconciliation,
normalized Membership Evidence, and later separately specified communications. Platform remains
the authority for Accounts, permissions, entitlements, profiles, and every content-access decision.

## Working agreements

- For product scope, read `docs/product/telegram-application-brief.md`.
- For confirmed bootstrap stack, credentialed-proof gates, and unresolved setup decisions, read
  `docs/decisions/seed-decisions.md`.
- For canonical terms, read `CONTEXT.md` when it exists.
- For GitHub issue routing, Project fields, or Wayfinder operations, read
  `docs/agents/issue-tracker.md`.
- For readiness-label triage, read `docs/agents/triage-labels.md`.
- For repository ownership or ADR placement, read `docs/agents/domain.md`.

## Current verification

Run from this repository with Node from `.node-version`:

```bash
pnpm install --frozen-lockfile
pnpm infra:up
DATABASE_URL=postgresql://inside:inside@127.0.0.1:5433/inside_telegram pnpm check:full
git diff --check
git diff --cached --check
git diff --check origin/main...HEAD -- . ':(exclude).inside-harness/skills/**'
test "$(readlink .agents/skills)" = "../.inside-harness/skills"
test "$(readlink .claude/skills)" = "../.inside-harness/skills"
test -f .inside-harness/skills/REGISTRY.md
```

Use `pnpm infra:down` when the local PostgreSQL service is no longer needed. `pnpm check` runs all
checks that do not require PostgreSQL; `pnpm test:integration` always uses a real PostgreSQL
database through `DATABASE_URL`.

For a managed harness change, additionally run from the canonical Workspace root:

```bash
harness/bin/inside-harness health repositories/telegram
harness/bin/inside-harness diff repositories/telegram
```

The Workspace commands verify package provenance; application build, test and runtime remain
self-contained in this repository.

## Boundaries

- Keep this repository autonomous: vendor versioned cross-repository schemas and fixtures for
  tests; use authenticated runtime interfaces instead of source, database, or checkout sharing.
- Keep bot tokens, webhook secrets, chat identifiers, user data, and provider payloads out of Git
  and redacted from logs, fixtures, issue bodies, and pull-request evidence.
- Treat BotFather writes, chat administrator changes, credentials, external messages, marketing
  enablement, releases, and every pull-request merge as explicit owner gates.
- First delivery is the Membership bridge in the product brief. Communications and marketing use
  later Specifications and do not expand bridge tickets implicitly.

<!-- inside-product-harness:start -->
## Inside product harness

This repository uses the versioned Sachkov Inside product harness.

- For shared delivery rules and owner gates, read the repository-local `WORKFLOW.md` when the task
  touches issues, branches, pull requests, review, readiness, or merge.
- Native runtimes discover the selected skill profile through `.agents/skills` or `.claude/skills`.
  Fallback runtimes use `.inside-harness/skills/REGISTRY.md`: route by intent only to `Model` rows;
  open a `User` row only when the user names that skill.
- Managed skills and workflow files change in the canonical package and arrive through the harness
  lifecycle. Repository-specific skills stay local under unique names.
- Keep build, test, run, deploy, and agent work repository-local. Project-owned integrations may
  use native config; record them in `.inside-harness/integrations.json` without credentials.
<!-- inside-product-harness:end -->
