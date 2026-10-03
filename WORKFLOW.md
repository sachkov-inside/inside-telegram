# Developer process

The process is the upstream skills in `.agents/skills` (sources in `.agents/skills/UPSTREAM.md`)
plus this contract. The contract covers what upstream leaves open and the owner's overrides of it.
Do not edit the copied skills; standing behaviour lives here and in `AGENTS.md`.

## Flows and stages

There are two flows:

- small change: `issue → implement → review → PR`;
- feature: `grilling → spec → tickets → implement → review → PR`. A visual change is a feature
  with a prototype (skill `prototype`).

The owner starts grilling, the specification (`to-spec`) and the ticket breakdown (`to-tickets`),
each with its own command. Finish such a stage with its outcome and the stage you recommend next,
then wait. An implementation task labelled `ready-for-agent` runs from `implement` to a ready pull
request without stopping. The owner starts it with `/implement #<issue>`; when the task arrives as
plain text, read `.agents/skills/implement/SKILL.md` and follow it. The acceptance criteria of the
task name the pre-agreed seams for `tdd`: write those seams down, then write the failing test first,
without asking. A criterion with no behaviour needs no test.

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
- A defect outside the task that blocks it is a blocker. Take its open issue labelled
  `needs-triage` or `ready-for-agent`, or open one; label it `ready-for-agent`, link it to the task
  and fix it first. When the task body gives the agent the right to merge, one revert undoes the
  fix, and the fix changes only tests, CI jobs, documentation or scripts outside release and
  deploy, copy the merge line into the body of the blocker issue. Otherwise ask the owner whether
  the agent may merge.
- A task that waits for the owner's acceptance stays open with a comment naming what the owner
  accepts.
- Durable decisions live in `GLOSSARY.md`, ADRs and `CODING_STANDARDS.md`.

## Merge

The right to merge is a line in the task body. Without that line, the owner merges. When
`AGENTS.md` names a merge procedure, follow it.

## Is the task taken

A task is taken when the remote has its branch or a linked open pull request. Check both before
the first write:

```bash
git ls-remote --heads origin | grep -E "/[a-z]+/<issue>-"
gh pr list --state open --search "<issue> in:body"
```

Nothing protects the gap between the start and the first push.

## Branch, worktree and pull request

- Branch `<type>/<issue>-<slug>` from the current `origin/main`, in its own worktree. Types:
  `feat`, `fix`, `docs`, `chore`, `research`, `prototype`. Trivial untracked work uses
  `<type>/<slug>`.
- The primary checkout belongs to the owner: read it, do not change it. The only exception is
  `.reports/`, which the skill `report` writes. After the merge, fast-forward it with
  `git merge --ff-only` only when it is on `main` and its tracked files have no changes. Untracked
  files stay; the command stops by itself before it overwrites one.
- Worktree place: `worktrees/<repo>-<task>` at the Workspace root for a checkout under
  `repositories/`; `<parent>/<repo>.worktrees/<task>` for a standalone checkout. `<task>` is the
  branch without its type prefix.
- One task has one branch, one writing worktree and one open pull request. Another session's worktree,
  branch, containers, volumes and stash entries are live state: leave them alone.
- One agent session works in one worktree: the one it starts in, or the one it creates for its task.
  Do not `cd` into any other; another worktree needs a new session. A subagent started in its own
  worktree is a separate session. Reach the primary checkout for `.reports/` and the fast-forward
  after the merge through `git -C` or absolute paths.
- After the first commit, push and open a draft pull request with `Closes #<issue>`. When one task
  needs several pull requests, only the last one closes it; the others say `Part of #<issue>`.
- Once the branch is pushed, integrate `origin/main` by merge; do not rebase or force-push.
- The pull request body is a result card in the owner's language with the sections `Что сделано`,
  `Что нужно от владельца`, `Проверка` (checked automatically, for the owner to check by hand, not
  checked), `Ревью` (findings with outcomes), `Риск merge` and `Что дальше`. The skill `pr` fills
  it: Summary goes into `Что сделано`, Evidence into `Проверка`, Merge Danger into `Риск merge`.

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
2. brings the pull request to green CI on the current head. A failed check is diagnosed and fixed.
   Re-run a failure that diagnosis attributes to the CI provider. When the diff changes neither the
   failed test or job nor code that the failed test runs, re-run it once without further diagnosis
   and make sure an open issue tracks the failure: find it or open one with `needs-triage`. The
   re-run unblocks the pull request; the issue fixes the cause. A failure after that re-run is
   diagnosed; when it blocks the task, it is a blocker (see `Tracker`);
3. reads `closingIssuesReferences` of the pull request and compares it with the task number:
   `gh pr view <pr> --json closingIssuesReferences --jq '.closingIssuesReferences[].number'`;
4. cleans up with the skill `session-cleanup`; when the cleanup removes the worktree, it runs
   `report.py new` first;
5. writes the report by the skill `report` and names in it each leftover of the cleanup;
6. gives in chat the path to the report file and one line of outcome.

Steps 4 to 6 apply to any hand-off to the owner: a ready pull request, a stopped task or a result
that waits for acceptance. The report is one Markdown file in `.reports/` (HTML when it needs a
diagram). Its subsection `Проверено командой` names the check command and the pull request CI that
ran; a check that did not run goes to `Не проверено`. The report is delivered when `report.py finish` exits with 0.

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
