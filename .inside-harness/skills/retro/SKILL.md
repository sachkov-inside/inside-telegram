---
name: retro
description: "Conduct a retrospective on a coding session."
disable-model-invocation: true
---

The owner has asked for a **retrospective**. You are suggesting improvements to the coding agent's **environment** so that the session's mistakes do not repeat in future runs.

## Steps

1. Call the Skill tool with `writing-for-agents` for the writing style guide.

2. Read the primary sources for the session the owner specifies. This may mean searching through session logs on this machine. If the owner doesn't specify a session, default to the current one. Every **owner correction** in the session (see `Owner corrections` in the repository-root `WORKFLOW.md`) is a candidate.

3. Look for candidates for improvement in these categories.

- **Navigation**: how easy was it for the agent to find the right files? Are there hidden dependencies between files? Would a **navigation pointer** make it easier? _Use when_ the session took a long time to find a piece of information.
- **Automated checks**: are there automated checks that could catch errors the agent made? Linting, typing, tests, filesystem linters? Read the repo's own check command first (its `package.json`/build-tool `lint`/`check` scripts, its CI workflow), so a check that already exists but sits unwired or silently broken is the finding, not a reinvention. A repo with no **guardrail** (no pre-commit hook and no CI job running its lint/typecheck/test command) is itself a finding. _Use when_ the agent made a mistake an automated check could have caught, or the repo has no guardrail at all.
- **Coding standards**: should the **reviewer agent** be given a new rule to enforce? Should an existing rule be removed or clarified? Classify each mistake as `Owner corrections` in the repository-root `WORKFLOW.md` does; for a mechanical one, build the cheapest check the repo's existing guardrail allows. _Use when_ the reviewer agent failed to catch a mistake, or the owner corrected one.
- **AGENTS.md**: are there steering instructions that should move to coding standards, automated checks, or a document behind a pointer? _Use when_ the `AGENTS.md` file is particularly large.
- **Tool economy**: did the agent make expensive tool calls that could be streamlined? Is any custom tooling (CLIs, MCPs) particularly token-inefficient? _Use when_ the agent made an expensive tool call.
- **No-ops**: look for instructions in steering files that don't modify the agent's behavior. _Use when_ the steering files are large and unwieldy.
- **Information access**: look for opportunities to increase the agent's access to information: teeing dev server logs, read-only access to third-party services. _Use when_ a crucial piece of information was not available to the agent.

4. Present the candidates to the owner, most severe first. For each, give the session evidence, the proposed durable home in the order `Review closure` in `WORKFLOW.md` sets, and the rule's source under `Rule sources`.

5. Deliver the candidates the owner approves as `Owner corrections` delivers a lesson, through the repository's normal branch and pull request flow. A change to a managed harness file (`WORKFLOW.md`, the managed product harness block in `AGENTS.md`, a skill, a managed workflow or script) belongs to the canonical package in Workspace: outside Workspace, open an issue there with the evidence instead of editing the installed copy. The retrospective is done when every approved candidate is delivered, or tracked by an issue for a managed-file change in Workspace or a check too large for a pull request.

## Reference

### Implementation vs Review

All work goes through two stages: implementation and review. The implementation agent has the most **context pressure**. They are responsible for exploration, writing code, and debugging failures.

The review agent has the least context pressure: it receives a diff, so no exploration is needed. It often does not need to write code or debug.

This means that the review agent should be responsible for imposing coding standards, not the implementation agent.

### Files

- `CLAUDE.md`/`AGENTS.md`: these files are pushed to the context window of any agent working in this repo. Use them sparingly, usually only for **navigation pointers** to other files.
- `CODING_STANDARDS.md`: read during review by the Standards axis of `code-review`, not during implementation. Add **navigation pointers** to docs folders if the standards file gets more than 1,000 lines long.
- Docs: use docs as reference files, pointed to by other files. Look for existing docs before writing new ones; `docs/agents/documentation-maintenance.md`, when present, names each fact's owning document.
- Skills: use skills for docs (since their description goes into the agent's context window), or for user-invoked commands. Follow the advice in the `writing-for-agents` skill.
