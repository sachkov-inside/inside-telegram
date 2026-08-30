# inside-telegram

## Repository role

This repository owns the Sachkov Inside Telegram application: BotContact lifecycle, `/start`
linking, Telegram identity invariants, canonical-chat Membership observations, reconciliation,
normalized Membership Evidence, and later separately specified communications. Platform remains
the authority for Accounts, permissions, entitlements, profiles, and every content-access decision.

## Working agreements

- For product scope, read `docs/product/telegram-application-brief.md`.
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
git diff --check origin/main...HEAD -- . ':(exclude).inside-harness/skills/**'
test "$(readlink .agents/skills)" = "../.inside-harness/skills"
test "$(readlink .claude/skills)" = "../.inside-harness/skills"
test -f .inside-harness/skills/REGISTRY.md
```

Use `pnpm infra:down` when the local PostgreSQL service is no longer needed. `pnpm check` runs all
checks that do not require PostgreSQL; `pnpm test:integration` always uses a real PostgreSQL
database through `DATABASE_URL`.

For a managed harness release, additionally run from the canonical Workspace root:

```bash
harness/bin/inside-harness health repositories/telegram
harness/bin/inside-harness diff repositories/telegram
```

The Workspace commands verify release provenance; application build, test and runtime remain
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

- For shared issue routing, branches, pull requests, readiness, Project status, and
  owner-controlled merge, read the repository-local `WORKFLOW.md`.
- Shared skills live once in `.inside-harness/skills/`; runtime discovery paths are relative links
  to that snapshot. Shared skills, `WORKFLOW.md`, triage labels, state, and the registry are managed
  artifacts: change their canonical package source and distribute it through the harness lifecycle.
- Repository-specific instructions and skills remain local. Give local skills unique names in the
  shared snapshot; do not shadow a managed skill.
- Invoke skills only when their descriptions match the task. Installing the suite does not make
  every workflow mandatory for every request.
- Runtimes without native project discovery search `.inside-harness/skills/REGISTRY.md` by intent
  and open only the matching `SKILL.md`.
- Keep this repository autonomous: build, test, run, deploy, and agent work must not depend on
  another repository, machine-local paths, or user-level skills, MCP, plugins, or hooks.
<!-- inside-product-harness:end -->
