# Issue tracker: GitHub

Issues and Specifications for this repository live in `sachkov-inside/inside-telegram` GitHub
Issues. Run `gh` inside this clone so repository identity comes from `git remote`.

State of a task is the issue, its labels and its linked pull request; there are no Project boards.
A specification is an issue and its tasks are its sub-issues. Platform implementation remains in
`sachkov-inside/platform`. Tracked pull requests use `Closes #<number>`.

## Wayfinder

- A map is an issue labelled `wayfinder:map`; its decision tickets are native sub-issues labelled
  `wayfinder:research|prototype|grilling|task`.
- Use native dependencies for blocking and native parent/sub-issues for hierarchy.
- A ticket is taken when the remote has its branch or a linked open pull request; `WORKFLOW.md`
  names the check. Assignee records the responsible human.
- Resolve a decision with a durable comment, close its issue, and link the result from its parent.

## Cross-repository hierarchy

The Telegram root Specification is a native child of Workspace Initiative
`sachkov-inside/workspace#65`. Telegram implementation tickets are native children of the Telegram
Specification. Platform convergence remains owned by `sachkov-inside/platform#52` and depends on
the independently passing Telegram provider contract.
