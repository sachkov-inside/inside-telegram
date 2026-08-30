# Developer Pipeline

This is the project-specific engineering agreement for Sachkov Inside. Installed skills define
their own invocation and steps; this file defines only the shared rules for repositories, branches,
pull requests, and owner gates.

## Routing

Create an issue in the repository that owns the outcome:

| Outcome | Repository |
|---|---|
| Product discovery, owner decision, shared document, or cross-repository work | `workspace` |
| Change or bug in the public landing | `inside-landing` |
| Change or bug in the Membership platform | `platform` |
| Change or bug in the Telegram application | `inside-telegram` |

A cross-repository effort has a parent issue in Workspace and repository-local child issues.
The issue holds discussion and execution history; record confirmed durable knowledge once in a
versioned document. When connected, GitHub Project remains a projection over issues and pull
requests.

## Trackers

Use two organization-level Projects with different responsibilities:

- [Inside — Human Backlog](https://github.com/orgs/sachkov-inside/projects/2) contains owner-facing
  goals, epics, features, bugs, and chores written in plain language. These are Workspace issues
  labelled `backlog:human`; they describe the desired outcome and do not duplicate agent execution
  details.
- [Inside — Developer Pipeline](https://github.com/orgs/sachkov-inside/projects/1) contains
  repository-owned delivery issues and pull requests. It is the agent execution projection over
  Wayfinder maps, Specifications, Tickets, dependencies, claims, status, and linked pull requests.

One issue belongs to one Project. A Human Backlog item stays owner-facing while an agent creates or
links the repository-owned Specification and Tickets that deliver it. Keep requirements,
discussion, and execution history in the owning issue; cross-link the human outcome and delivery
track instead of copying their bodies. Removing `backlog:human` is only a classification repair;
promotion never removes the label or moves the human item.

`Status` records delivery state:

- `Inbox`: captured but not ready;
- `Ready`: ready for implementation;
- `In progress`: actively being worked;
- `Review`: implementation is in pull request review;
- `Blocked`: cannot advance without a dependency or owner decision;
- `Done`: the issue is closed or the pull request is merged.

`Priority` is `Now`, `Next`, or `Later`. `Area` is `Product`, `Platform`, `Landing`, or
`Operations`. Triage and Wayfinder labels describe readiness and work shape; they do not duplicate
delivery state or priority.

Use native `Parent issue` and sub-issues as the only delivery hierarchy. Use native dependencies
for blocking. A Wayfinder map carries `wayfinder:map`; Specifications and Tickets keep their own
issue contracts and readiness labels. Do not mirror these distinctions in a Project field. The
`Current` view contains issues only and shows pull requests through `Linked pull requests`.

Repository automation closes an open native parent after its last sub-issue closes as `completed`,
and repeats this up the parent chain. A child closed as `not_planned` does not complete its parent.
The normal issue-close workflow then moves each automatically closed parent to `Done`.

Repository workflows add new and reopened delivery issues and pull requests to Developer Pipeline.
The Workspace workflow routes `backlog:human` issues only to Human Backlog. Set `Area` and
`Priority` during delivery triage, move `Status` with the work, and treat the repository issue or
pull request state as authoritative when it conflicts with a Project.

## Issue contract

Write every tracker item with an owner-facing opening that explains the work without translating
implementation vocabulary:

1. **Outcome**: what changes for a user, the owner, or the product.
2. **Why now**: why this work is needed at the current stage.
3. **Delivered result**: what can be observed or used after the issue closes.
4. **Next or excluded**: what remains a later step and what this issue deliberately does not
   deliver.

Use equivalent headings in the issue's language. Prefer domain language from `CONTEXT.md`; define
an unavoidable implementation term in the sentence where it first matters. For a Human Backlog
item, add product-level acceptance, priority, and links to known delivery tracks; this concise
owner-facing body is the complete contract. Keep implementation scope and agent handoff details out
until the work is represented by delivery issues.

For a delivery Specification or Ticket, follow the opening with the agent contract: scope,
interfaces and seams when relevant, dependencies, acceptance criteria, owner decisions,
verification, and one stopping condition. A parent Specification describes the complete user- or
product-visible outcome. Every child says whether it delivers a user-visible slice, an enabling
capability, or an integration step, and links the later convergence that turns a technical step
into the completed outcome. A technical ticket must not read as if it delivers the whole feature
when another issue is required before a user can use it.

## Issues, branches, and pull requests

Product work, bugs, architecture, and substantial documentation changes start from one primary
repository-local issue. Trivial docs or chore work may go directly to a short pull request when it
needs no discussion, tracking, or owner decision.

Create branches from the current `main`. Tracked work uses `<type>/<issue>-<slug>`; trivial
untracked work uses `<type>/<slug>`. Supported types are `feat`, `fix`, `docs`, `chore`, `research`,
and `prototype`.

One meaningful task uses one branch and one pull request. For tracked work, the pull request
includes `Closes #<issue>`. Every pull request states the result, verification, `Not tested`, and
open owner decisions. Add UI evidence only for interface changes. GitHub deletes the head branch
after merge.

### Agent worktrees

The repository's primary local checkout is the owner's workspace. Treat its checked-out branch,
index, and files as owner-controlled state: inspect it read-only, and let the owner decide when it
advances after a merge. An explicit owner request concerning that checkout is the only authority to
change its branch or files.

Every tracked task has one writing worktree by default, regardless of how many agents help with it.
Fetch refs without changing the primary checkout, then create that worktree for the task branch
from the current `origin/main`. One worktree has one active writing agent, one task branch, and one
meaningful scope. Supporting agents gather evidence read-only and return it to the writing agent.
Create another writing worktree only for an independently mergeable child task with its own branch
and pull request. Parallel independently mergeable tasks use separate worktrees and branches.

Treat another session's worktree and branch as owned live state. Integrate upstream changes inside
the task worktree, and keep worktree paths out of committed configuration and documentation.

Worktree cleanup is the owning writing agent's final task step. After the pull request is merged, or
the issue is closed without a pull request, verify that the worktree has no uncommitted changes and
that every commit is preserved by a remote branch or the merged pull request. Then remove the task
worktree and delete its local task branch. Commits represented by a squash-merged pull request are
preserved even when they are not ancestors of `main`. If unpublished work remains, keep the
worktree and report the exact blocker. Remove another session's worktree only after confirming that
its task is terminal and its state is preserved.

### Long-lived branches and deployment

`main` is the only long-lived integration branch. Preview, staging, and production are deployment
environments, not branches.

Create a temporary `release/<version>` only for a real maintenance boundary: supporting multiple
production versions, freezing a release candidate while `main` advances, or meeting an external
calendar or certification requirement. Record its support period and deletion condition when it is
created. A normal hotfix uses `fix/<issue>-<slug>` into `main`; use a backport pull request only for
an active release branch.

## Ready and Done

Tracked work is ready for implementation when the result, scope, acceptance criteria, blockers,
and owner decisions are known. Multi-session delivery also requires an agreed decomposition and
dependencies. Read readiness roles from the repository-local `docs/agents/triage-labels.md` and
Wayfinder structure from `docs/agents/issue-tracker.md`.

Work is ready for owner merge when:

- acceptance criteria are met without silently expanding scope;
- relevant focused checks and full repository verification pass;
- durable documents and ADRs are updated when a confirmed decision changed;
- the pull request follows its template, links an issue when applicable, and states `Not tested`;
- a UI change includes mobile and desktop evidence and passes the repository-specific UI
  Definition of Done;
- the owner gives explicit merge approval.

Implementation, specification, and architecture changes run Standards and Spec `code-review` from
an agreed fixed point. Trivial docs or chore work needs only a bounded diff review and relevant
verification.

### Review closure

Every actionable review finding receives one explicit disposition before work is ready for merge:
fix it in the current change, defer it to a linked issue when it is valid but outside scope, or
reject it with concrete evidence. After fixes, re-run the relevant verification and both review
axes from the same fixed point. Completion means both axes pass or every remaining finding has an
explicit disposition; a raw review report is not a completion artifact.

Promote a finding only when it generalizes beyond one diff. Prefer the strongest durable home:
type, schema, test, lint or guardrail first; repository coding standard for recurring judgement;
specification for required behaviour; ADR for a hard-to-reverse trade-off; tracker issue for
deferred work. Pull request history is the durable home for one-off findings. Do not create a
repository review ledger.

### Architecture fitness

Every durable architecture rule names its owning repository or Module and the closest executable
fitness function. Prefer types and schemas for shape, focused tests for behaviour, import or
dependency guardrails for seams, and integration checks for infrastructure ownership. A new or
changed architecture seam includes a passing representative case and a negative fixture that
proves the guardrail fails when the rule is broken. Repository-specific fitness functions run as
part of that repository's full verification command.

`inside-harness health` owns shared harness fitness: managed-package integrity, runtime discovery,
coding-standard discoverability, and ADR lifecycle. A prose-only architecture rule states why it
cannot yet be enforced and becomes a fitness candidate when a stable seam appears.

### Pruning

Review every touched instruction or decision for sediment. Keep one authority for each meaning;
remove coding standards that are duplicated, stale, reduced to no-ops, or fully enforced by an
executable check unless the rationale remains necessary. Git history preserves removed rules.

Accepted ADRs remain as decision history. Every ADR declares `proposed`, `accepted`, `deprecated`,
or `superseded by ADR-NNNN`; replacement creates a new ADR and points the old one at it. Delete only
an unaccepted proposal whose discussion has no remaining value. Update context pointers when their
target or trigger changes.

Every completed agent session ends with a decision handoff in chat: the outcome, recommendation or
decision needed, material caveats, verification performed, and direct links to the durable document,
issue, and pull request when they exist. A file path is supporting detail, not the handoff itself.

## Owner gates

Explicit owner approval is required for:

- product and visual decisions;
- hard-to-reverse ADRs with a real trade-off;
- testing seams and ticket breakdown when the selected skill requires approval;
- publishing, payments, credentials, external messages, and other risky external writes;
- every pull request merge.

An agent implements a `ready-for-agent` issue autonomously within these boundaries. Only the owner,
or an agent acting after explicit owner approval, may squash-merge a pull request. Review readiness
alone is not merge permission.
