# Developer process

The process is the upstream skills in `.agents/skills` (sources in `.agents/skills/UPSTREAM.md`)
plus this contract. The contract covers only what upstream leaves open. Do not edit the copied
skills; standing behaviour lives here and in `AGENTS.md`.

## Flows and stages

There are two flows:

- small change: `issue → implement → review → PR`;
- feature: `grilling → spec → tickets → implement → review → PR`. A visual change is a feature
  with a prototype (skill `prototype`).

The owner starts grilling, the specification (`to-spec`) and the ticket breakdown (`to-tickets`),
each with its own command. Finish such a stage with its outcome and the stage you recommend next,
then wait. An implementation task labelled `ready-for-agent` runs from `implement` to a ready pull
request without stopping.

Everything that needs an owner decision is decided before tasks exist: in grilling, and for the
look of an interface in a prototype. A task is one vertical slice sized for one fresh context
window.

## Tracker

- A specification is an issue, not a file. Its tasks are its sub-issues; native GitHub blocking
  sets their order. The specification issue with its task list is the overview of the work.
- State of a task is the issue, its labels and its linked pull request. There are no Project
  boards, epics or issue types.
- Labels are the five upstream roles: `needs-triage`, `needs-info`, `ready-for-agent`,
  `ready-for-human`, `wontfix`, plus `wayfinder:*` set by the `wayfinder` skill. `ready-for-human`
  is only for work a human does.
- Create an issue in the repository that owns the outcome.
- A task that waits for the owner's acceptance stays open with a comment naming what the owner
  accepts.
- Durable decisions live in `GLOSSARY.md`, ADRs and `CODING_STANDARDS.md`.

## Merge

The right to merge is a line in the task body. Without that line, the owner merges.

## Is the task taken

A task is taken when the remote has its branch or a linked open pull request. Check both before
the first write:

```bash
git ls-remote --heads origin | grep -E "/[a-z]+/<issue>-"
gh issue view <issue> --json closedByPullRequestsReferences
```

Nothing protects the gap between the start and the first push.

## Branch, worktree and pull request

- Branch `<type>/<issue>-<slug>` from the current `origin/main`, in its own worktree. Types:
  `feat`, `fix`, `docs`, `chore`, `research`, `prototype`. Trivial untracked work uses
  `<type>/<slug>`.
- The primary checkout belongs to the owner: read it, do not change it. After the merge,
  fast-forward it only when it is on `main` and has no uncommitted changes.
- Worktree place: `worktrees/<repo>-<task>` at the Workspace root for a checkout under
  `repositories/`; `<parent>/<repo>.worktrees/<task>` for a standalone checkout. `<task>` is the
  branch without its type prefix.
- One task has one branch, one writing worktree and one pull request. Another session's worktree,
  branch, containers, volumes and stash entries are live state: leave them alone.
- After the first commit, push and open a draft pull request with `Closes #<issue>`. When one task
  needs several pull requests, only the last one closes it; the others say `Part of #<issue>`.
- Once the branch is pushed, integrate `origin/main` by merge; do not rebase or force-push.
- The skill `pr` sets the form of the pull request body.

## Review

- Record the starting point (`git rev-parse origin/main`) before the first change.
- Commit first, then review from the recorded starting point: a review before the commit sees an
  empty diff.
- The writing agent starts the review in a separate agent with a clean context. Its input is the
  diff, the task and the coding standards. If the runtime cannot start such an agent, run the
  review as a separate process with the same input.
- Every finding gets one outcome: fixed, moved to a linked issue, or rejected with evidence.
- After the fixes, run one more review pass. Close what remains with outcomes; do not loop until
  the review comes back clean.

## Done

Done means the repository's check command, named under `Commands` in `AGENTS.md`, is green on the
final head with its real exit code. The agent then:

1. marks the acceptance criteria in the task;
2. brings the pull request to green CI on the current head. A failed check is diagnosed and fixed,
   not re-run; re-run only a failure that diagnosis attributes to the CI provider;
3. reads `closingIssuesReferences` of the pull request and compares it with the task number:
   `gh pr view <pr> --json closingIssuesReferences --jq '.closingIssuesReferences[].number'`;
4. cleans up with the skill `session-cleanup`;
5. reports in chat in at most ten lines with links to the pull request and the task.

If a check cannot run, name what was not run.

## Rules from session reports

1. Scripts do not mask exit codes and run under macOS bash 3.2: no `wait -n`, no empty arrays
   under `set -u`.
2. Before a deploy, name the expected downtime.
3. After a deploy, run the check from the release runbook and put its result in the report.
4. Check the link between the pull request and the issue before reporting ready.
5. Before a commit, run the checks for what the change touches. Run the full check once, on the
   final head.
6. Restart a stand that the agent started at the owner's request without asking.
7. `lint` and `typecheck` are green before any report of readiness.

## Owner corrections

Owner corrections go through the upstream `retro`, without a journal. A mechanical mistake becomes
an automatic check: a test, a lint rule, a type or a guardrail. A judgement call becomes a rule in
`CODING_STANDARDS.md`, which the reviewer reads. When a `CODING_STANDARDS.md` file, root or nested,
is longer than 200 lines, `docs:check` prints a warning; open a task to turn rules into checks.

## Owner gates

Explicit owner approval is required for:

- releases and deployments;
- publishing;
- paid actions;
- credentials;
- external messages;
- a merge, unless the task body gives that right to the agent.

An approval covers the scope the owner stated and lasts until the owner withdraws it. Inside that
scope, act without asking again. Waiting for an answer is never consent.
