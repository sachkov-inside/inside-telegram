# Project Skill Registry

Fallback runtimes may route by intent only to `Model` skills. Open a `User` skill only
when the user names it explicitly, then read only that skill's `SKILL.md`.

| Skill | Invocation | Project path | When to use |
|---|---|---|---|
| `ask-matt` | User | `.inside-harness/skills/ask-matt` | Ask which skill or flow fits your situation. A router over the skills in this repo. |
| `code-review` | Model | `.inside-harness/skills/code-review` | Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \"review since X\". |
| `codebase-design` | Model | `.inside-harness/skills/codebase-design` | Shared vocabulary for designing deep modules. Use when the user wants to design or improve a module's interface, find deepening opportunities, decide where a seam goes, make code more testable or AI-navigable, or when another skill needs the deep-module vocabulary. |
| `diagnosing-bugs` | Model | `.inside-harness/skills/diagnosing-bugs` | Diagnosis loop for hard bugs and performance regressions. Use when the user says "diagnose"/"debug this", or reports something broken/throwing/failing/slow. |
| `domain-modeling` | Model | `.inside-harness/skills/domain-modeling` | Build and sharpen a project's domain model. Use when discussing codebase terminology, writing or editing a CONTEXT.md, or recording or editing an ADR. |
| `grill-me` | User | `.inside-harness/skills/grill-me` | A relentless interview to sharpen a plan or design. |
| `grill-with-docs` | User | `.inside-harness/skills/grill-with-docs` | A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go. |
| `grilling` | Model | `.inside-harness/skills/grilling` | Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases. |
| `handoff` | User | `.inside-harness/skills/handoff` | Compact the current conversation into a handoff document for another agent to pick up. |
| `implement` | User | `.inside-harness/skills/implement` | Implement a piece of work based on a spec or set of tickets. |
| `improve-codebase-architecture` | User | `.inside-harness/skills/improve-codebase-architecture` | Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick. |
| `karpathy-guidelines` | Model | `.inside-harness/skills/karpathy-guidelines` | Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria. |
| `prototype` | Model | `.inside-harness/skills/prototype` | Build a throwaway prototype to answer a design question. Use when the user wants to sanity-check whether a state model or logic feels right, or explore what a UI should look like. |
| `research` | Model | `.inside-harness/skills/research` | Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent. |
| `resolving-merge-conflicts` | Model | `.inside-harness/skills/resolving-merge-conflicts` | Use when you need to resolve an in-progress git merge/rebase conflict. |
| `setup-matt-pocock-skills` | User | `.inside-harness/skills/setup-matt-pocock-skills` | Configure this repo for the engineering skills: set up its issue tracker, triage label vocabulary, and domain doc layout. Run once before first use of the other engineering skills. |
| `tdd` | Model | `.inside-harness/skills/tdd` | Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests. |
| `teach` | User | `.inside-harness/skills/teach` | Teach the user a new skill or concept, within this workspace. |
| `to-questionnaire` | User | `.inside-harness/skills/to-questionnaire` | Turn a decision you can't fully answer into a questionnaire for someone else to fill in. |
| `to-spec` | User | `.inside-harness/skills/to-spec` | Turn the current conversation into a spec and publish it to the project issue tracker: no interview, just synthesis of what you've already discussed. |
| `to-tickets` | User | `.inside-harness/skills/to-tickets` | Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the configured tracker (edges as text in one file per ticket locally, or native blocking links on a real tracker). |
| `triage` | User | `.inside-harness/skills/triage` | Move issues and external PRs through a state machine of triage roles, categorise, verify, grill if needed, and write agent-ready briefs. |
| `wait-what` | User | `.inside-harness/skills/wait-what` | Stop. That last message did not land: re-pitch it. |
| `wayfinder` | User | `.inside-harness/skills/wayfinder` | Plan a huge chunk of work (more than one agent session can hold) as a shared map of decision tickets on your issue tracker, and resolve them one at a time until the way to the destination is clear. |
| `wizard` | Model | `.inside-harness/skills/wizard` | Generate an interactive bash wizard that walks a human through steps only they can perform. Use when provisioning infrastructure, setting up credentials or CI secrets, walking an unfamiliar third-party dashboard, or running a one-off migration or cutover. Don't invoke this for steps the agent can perform itself. |
| `writing-for-agents` | Model | `.inside-harness/skills/writing-for-agents` | Writing documents for agents. Use when creating or editing skills, or modifying AGENTS.md or CLAUDE.md. |
