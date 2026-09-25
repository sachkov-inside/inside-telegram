# Developer Pipeline

This is the project-specific engineering agreement for Sachkov Inside. Installed skills define
their own invocation and steps; this file defines only the shared rules for repositories, branches,
pull requests, and owner gates.

## Routing

Create an issue in the repository that owns the outcome:

| Outcome | Repository |
|---|---|
| Product discovery, owner decision, shared document, or cross-repository work | `workspace` |
| Change or bug in the Membership platform | `platform` |
| Change or bug in the Telegram application | `inside-telegram` |

`inside-landing` is deprecated: create no issues or pull requests there, and leave its published
site and `main` unchanged.

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
- `Acceptance`: the delivery is merged or otherwise finished, and the issue waits for the owner's
  acceptance;
- `Done`: the issue is closed or the pull request is merged.

An open issue whose remaining acceptance criterion is the owner's own check, such as acceptance on
a stand or in production, carries the `tracker:acceptance` label. The writing agent adds it when
the last delivery for the issue is merged or finished and names what the owner accepts in an issue
comment. The label projects the issue to `Acceptance` and makes it unavailable to a new session.
The owner closes the issue after acceptance, or removes the label and states what returns to
delivery.

`Priority` is `Now`, `Next`, or `Later`. `Area` is `Product`, `Platform`, `Telegram`, `Content`, or
`Operations`; `Landing` remains only on history of the deprecated landing. Triage and Wayfinder
labels describe readiness and work shape; they do not duplicate delivery state or priority.

Every issue in either Project has exactly one native GitHub issue type, set when the issue is
created:

- `Epic`: a large outcome delivered by several issues, such as a Human Backlog goal, a parent
  Specification with children, or a Wayfinder map;
- `Feature`: a new capability for a user, an author, or the owner;
- `Improvement`: a better version of something that already works: UX, performance, reliability,
  technical debt, tests, process, or harness;
- `Bug`: behaviour that differs from what was intended, including a check that fails because of a
  defect;
- `Task`: work that adds no capability: release, acceptance, infrastructure, dependency updates, or
  an owner decision.

Type is the issue's native field, not a label or a Project field; do not use `bug` or `enhancement`
labels. Set or correct it with `gh api -X PATCH repos/{owner}/{repo}/issues/{number} -f type=<Type>`.
Type is independent of readiness, Wayfinder labels, Status, and Priority; correct it whenever triage
shows the work is of another kind.

Use native `Parent issue` and sub-issues as the only delivery hierarchy. Use native dependencies
for blocking. A Wayfinder map carries `wayfinder:map`; Specifications and Tickets keep their own
issue contracts and readiness labels. Do not mirror these distinctions in a Project field. The
`Current` view contains issues only and shows pull requests through `Linked pull requests`.

Tracker automation is defined in `docs/agents/tracker-automation.md`. Its shared policy and
workflow are managed harness files. GitHub issue and PR facts remain authoritative over Project
fields. Automatic parent completion is opt-in and never accepts Human Backlog outcomes.
Use the documented dry-run, bounded apply and recovery procedure when changing automation.
Set `Area` and `Priority` during triage; the controller does not infer product priorities.

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
index, and files as owner-controlled state and inspect it read-only while a task runs. After its
pull request merges, the writing agent advances that checkout: when it is on `main` and has no
uncommitted changes, fast-forward it to `origin/main`; otherwise leave it untouched and name the
branch or files that prevented the update in the handoff. Beyond this fast-forward, only an
explicit owner request concerning that checkout authorizes changing its branch or files.

Before writing a tracked task, follow the Agent sessions procedure in
`docs/agents/tracker-automation.md` and obtain a successful start receipt. Use the same session
identifier for block, handoff and release. Assignee records the responsible human, not a session
lock. Existing work without a receipt is an adoption case, not an available task.

Every tracked task has one writing worktree by default, regardless of how many agents help with it.
Fetch refs without changing the primary checkout, then create that worktree for the task branch
from the current `origin/main`. One worktree has one active writing agent, one task branch, and one
meaningful scope. Supporting agents gather evidence read-only and return it to the writing agent.
Create another writing worktree only for an independently mergeable child task with its own branch
and pull request. Parallel independently mergeable tasks use separate worktrees and branches.

Every agent worktree lives in one predictable place: an untracked directory set apart from the
primary checkouts. The Workspace `repositories/` directory holds primary checkouts only, and the
Workspace root's Git-ignored `worktrees/` directory is the one permitted place inside a checkout.
Place the worktree by where the repository's primary checkout lives:

| Primary checkout | Task worktree |
|---|---|
| The Workspace itself | `worktrees/workspace-<task>` at the Workspace root |
| `repositories/<repo>` inside the Workspace | `worktrees/<repo>-<task>` at the Workspace root |
| A standalone checkout `<parent>/<repo>` | `<parent>/<repo>.worktrees/<task>` |

`<repo>` is the checkout directory name, and `<task>` is the task branch without its type prefix:
`docs/212-worktree-location` becomes `212-worktree-location`. Each worktree is a direct child of its
placement directory, beside other worktrees rather than inside one.

Treat another session's worktree, branch, containers, processes, volumes, and stash entries as
owned live state. Every worktree shares one `git stash` stack, so give each safety stash entry a
unique message with `git stash push -m`. Integrate upstream changes inside the task worktree; once
the task branch is pushed, integrate by merging `origin/main` and never rebase or force-push it.
Keep worktree paths out of committed configuration and documentation; name only the placement
patterns above.

### Session cleanup

Cleanup is the owning writing agent's final task step, done before its closing handoff. A session
is complete when nothing it started keeps running and its local state is clean:

- stop and remove the containers, volumes, and stand processes the session started, and free their
  ports;
- after the pull request is merged, or the issue is closed without a pull request, verify that the
  task worktree has no uncommitted changes and that every commit is preserved by a remote branch or
  the merged pull request, then remove the worktree and delete its local task branch; commits
  represented by a squash-merged pull request are preserved even when they are not ancestors of
  `main`, so delete such a branch with `git branch -D`;
- prune stale worktree records, and delete merged local branches whose upstream is gone unless a
  worktree still uses them;
- drop the session's safety `git stash` entries, found by their messages, only after comparing
  them with the merged pull request;
- close the tracker session by the Agent sessions procedure: `release` after the merge, `handoff`
  while the pull request is open.

While the pull request is still open, keep the worktree and task branch and complete the other
steps. If unpublished work remains after the merge, keep the worktree and report the exact blocker.
Leave another session's resources in place and name their owner in the handoff. Remove another
session's worktree only after confirming that its task is terminal and its state is preserved.

List the leftovers from the repository root with one command. The Compose working directory, the
Compose project of a volume, and a process's current directory show which worktree owns a resource.

```bash
git worktree list; git branch -vv | grep ': gone]'; git stash list; \
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.project.working_dir"}}'; \
docker volume ls -f dangling=true --format '{{.Name}}\t{{.Label "com.docker.compose.project"}}'; \
lsof -nP -iTCP -sTCP:LISTEN
```

Read a listening process's current directory with `lsof -a -p <pid> -d cwd`; on Linux without
`lsof`, use `ss -ltnp` and `readlink /proc/<pid>/cwd`.

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
- the verification this section requires for the change passes;
- `Documentation impact` is reconciled, and every new or changed rule has a source under
  `Rule sources`;
- the current remote head passes `Pull request CI closure` and review closure is complete;
- the pull request follows its template, links an issue when applicable, and its final
  Implementation Report reflects the current remote head;
- a UI change includes mobile and desktop evidence and passes the repository-specific UI
  Definition of Done.

Readiness never includes merge approval. The agent reports readiness first; merging additionally
needs the owner's explicit approval under `Owner gates`.

Verification follows the change. While iterating, run the checks for the behaviour and files the
change touches; before reporting ready for merge, run the repository's full verification on the
final change. Repeat a check after its inputs change, after it fails, or when a new risk appears. A
passing local check on unchanged inputs remains evidence while iterating; pull request CI evidence
belongs to one head only. A documentation or editorial change needs a substantive check of its
content; tests run when executable code or an executable contract changes, or when the repository
requires them. Follow `diagnosing-bugs` when the first reading of a failing check does not name the
cause, when it fails on only one machine or only in CI, or when it fails again after a fix.

### Pull request CI closure

Commit and push once the checks for the change and review closure pass: pull request CI runs on
that pushed head. `Ready and Done` decides when to report a pull request ready for owner merge,
never when to commit, so no rule waits for CI before the commit that CI needs.

The writing agent owns the pull request feedback loop through a terminal result for its current
remote head. After opening or updating a pull request, resolve that head commit and monitor every
check started for it until each reaches a terminal state. Pending or queued checks are ongoing work,
not an owner handoff, and a successful run for a superseded head is not evidence for the current
change. When no check starts for a pushed head, read the pull request's `mergeable` state before
waiting longer: a conflicting pull request gets no `pull_request` checks until `origin/main` is
merged into the branch and the result is pushed.

When a task-relevant check fails, times out, is cancelled on the current head, or is unexpectedly
skipped, inspect its provider logs and failure artifacts, diagnose the cause, fix it in the same task
worktree, run the relevant local verification and review closure, push, and repeat against the new
remote head; `Ready and Done` names when that diagnosis follows `diagnosing-bugs`. A re-run never
repairs a failure. Re-run a failed check at most twice on the same head, and only when diagnosis
attributes it to the CI provider or infrastructure, or to a known defect outside the change that an
open issue tracks; in the last case, link that issue. A failure the change could cause is fixed, not
re-run. A re-run reuses the same head and base, so a fix merged to `main` needs a new head. When
both re-runs fail, treat the cause as an external blocker; preserve the worktree and report the
exact check and run.

A head passes pull request CI closure only when the intended local commit matches it, all required
checks for that head succeeded, and no task-relevant check is pending or failed. Merge, release and
deployment remain subject to their explicit owner gates.

Implementation, specification, and architecture changes run Standards and Spec `code-review` from
an agreed fixed point. Trivial docs or chore work needs only a bounded diff review and relevant
verification.

### Review closure

Every actionable review finding receives one explicit disposition before work is ready for merge:
fix it in the current change, defer it to a linked issue when it is valid but outside scope, or
reject it with concrete evidence. After fixes, re-run the relevant verification and both review
axes from the same fixed point. Completion means both axes pass or every remaining finding has an
explicit disposition; a raw review report is not a completion artifact. Say which way review
ended: the last round returned no new actionable finding, or it stopped with dispositions for the
findings it still produced.

Promote a finding only when it generalizes beyond one diff. Prefer the strongest durable home:
type, schema, test, lint, guardrail, or a script that removes the problem first; tracker issue for
deferred work or a problem that has an end; repository coding standard for recurring judgement;
specification for required behaviour; ADR for a hard-to-reverse trade-off; otherwise the nearest
owning document, such as the root or a nested `AGENTS.md`, `docs/agents/`, a runbook, or this
workflow through the canonical package. Pull request history is the durable home for one-off
findings. Do not create a repository review ledger. A promoted rule follows `Rule sources`.

### Rule sources

A new or changed rule in `AGENTS.md`, a coding standard, `WORKFLOW.md`, a skill, or an agent
document needs a source: an accepted Specification, an ADR, an owner decision, or an environment
fact confirmed by a check in the current session. A rule is any statement that requires, forbids,
or prescribes how agents or code must work. Name the source of every such rule in the
Implementation Report. A rule without a source is a proposal: list it under the owner decisions the
pull request still needs, and do not report the pull request ready until the owner decides. Review
reports an unsourced rule as behaviour the task did not ask for.

### Documentation impact

Before the Implementation Report, reconcile what the change did to durable knowledge:

1. From the final diff, list every changed durable fact: product behaviour, business rule, domain
   term, architecture seam, public contract, developer command, delivery workflow, or agent routing.
2. Compare the list with the Specification's `Documents and rules` section when it has one, and
   explain every difference.
3. Update each fact in exactly one owning document, named by the repository-local
   `docs/agents/documentation-maintenance.md` when it exists. Update pointers to that document, and
   remove or explicitly supersede current claims that now conflict with it.
4. When code, schemas, generated contracts, and tests are the complete authority, record
   `None — code/schema/tests are the authority` instead of making an empty prose edit.

The report's documentation section names each changed owning document or that statement.

### Session learning

Before the closing handoff, name what the session learned that the repository does not yet say: an
environment trap, a non-obvious command, a flaky check, or an owner decision. Give each item the
strongest durable home in the order `Review closure` sets for promoted findings. Deliver it in the
current pull request when it concerns the change, otherwise in a small follow-up pull request or
issue. Memory local to one runtime or machine is not a home for project knowledge; other agents
cannot read it. Knowledge added this way follows `Rule sources`.

### Implementation report

After final review closure and current-head pull request CI closure, the writing agent updates the
pull request body from the final diff, issue or specification, verification evidence, and review
outcomes. The repository pull request template is the single authority for the report format. The
report guides owner review; it does not replace Standards, Spec, CI, or owner approval.

Complete every applicable template section, state unchanged surfaces explicitly, and give a bounded
review path through the conceptual files or groups that explain the change. Separate generated and
mechanical files from that path. Record the final remote head SHA, read by a command against the
pull request in the same step rather than recalled, and the disposition of review findings. The same
holds for every readiness message that names a head. If code or durable documents change afterward,
repeat the relevant verification and review closure, then refresh the report for the new head.
Trivial documentation or chore work may keep only the compact template sections named by their
comments.

The report is complete when the owner can identify the delivered outcome, affected product and
business surfaces, material design constraints, evidence, remaining gaps, and requested decisions
without reconstructing them from the full diff.

### Architecture fitness

Every durable architecture rule names its owning repository or Module and the closest executable
fitness function. Prefer types and schemas for shape, focused tests for behaviour, import or
dependency guardrails for seams, and integration checks for infrastructure ownership. A new or
changed architecture seam includes a passing representative case and a negative fixture that
proves the guardrail fails when the rule is broken. Repository-specific fitness functions run as
part of that repository's full verification command.

`inside-harness health` owns shared harness fitness: managed-package integrity, runtime discovery,
coding-standard discoverability, ADR lifecycle, a Claude Code bridge beside every nested
`AGENTS.md`, and local pointers in agent, product, specification, and ADR documents. A prose-only
architecture rule states why it cannot yet be enforced and becomes a fitness candidate when a stable
seam appears.

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

## Pipeline stages

The Developer Pipeline is owner-driven. Work moves through stages: sharpen the idea (`grilling` or
`grill-with-docs`), Specification (`to-spec`), Ticket breakdown (`to-tickets`), and Implementation
(`implement`); `triage` and `wayfinder` are on-ramps. The owner starts each stage in the current
session.

An agent must not chain stages. Finishing a stage ends with a decision handoff and a recommended
next stage; starting that stage needs a new explicit owner request. An owner request that names
several stages, or a range such as "through Implementation", starts each of them in order; an
approval that `Owner gates` or the stage's skill requires inside a stage still stops for the owner
unless the request gave it. This boundary does not depend on runtime behavior, including runtimes
that ignore a skill's user-only invocation marker.

Start a development session in the repository that owns the outcome. The project harness loads from
the repository root; a parent navigation directory does not provide its skills or workflow.

## Owner gates

Explicit owner approval is required for:

- product and visual decisions;
- hard-to-reverse ADRs with a real trade-off;
- testing seams and ticket breakdown when the selected skill requires approval;
- publishing, payments, credentials, external messages, and other risky external writes;
- releases and deployments;
- every pull request merge.

An agent implements a `ready-for-agent` issue autonomously within these boundaries. Only the owner,
or an agent acting after explicit owner approval, may squash-merge a pull request. Review readiness
alone is not merge permission.

An owner approval covers the scope the owner stated, which may name several tasks, stages or pull
requests, and lasts until the owner withdraws or narrows it. Inside that scope, act without asking
again; a follow-up question or clarification from the owner adds to the current task rather than
cancelling it. A merge approval given for a reviewed head covers that head and the fixes the owner
requested; an approval given in advance for named tasks covers their pull requests once they meet
`Ready and Done`. Every gate above that falls outside the stated scope needs its own approval, and
so does every new product or visual decision; waiting for an answer is never consent. When a skill
or rule stops approved work, name the exact file, requirement and why it applies.
