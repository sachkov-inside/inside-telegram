# Issue tracker: GitHub

Issues and Specifications for this repository live in `sachkov-inside/inside-telegram` GitHub
Issues. Run `gh` inside this clone so repository identity comes from `git remote`.

Shared product and cross-repository decisions remain in `sachkov-inside/workspace`; link the
Workspace parent rather than duplicating its discussion. Platform implementation remains in
`sachkov-inside/platform`. Tracked pull requests use `Closes #<number>`.

## Project routing

- Repository-owned Specifications, Tickets, and pull requests belong to
  [Inside — Developer Pipeline](https://github.com/orgs/sachkov-inside/projects/1).
- Owner-facing goals stay in Workspace and
  [Inside — Human Backlog](https://github.com/orgs/sachkov-inside/projects/2).
- The repository issue or pull-request state is authoritative when it conflicts with a Project
  field.

## Wayfinder

- A map is an issue labelled `wayfinder:map`; its decision tickets are native sub-issues labelled
  `wayfinder:research|prototype|grilling|task`.
- Use native dependencies for blocking and native parent/sub-issues for hierarchy.
- Use the assignee as the claim. An open, unblocked, and unassigned child is on the frontier.
- Resolve a decision with a durable comment, close its issue, and link the result from its parent.

## Cross-repository hierarchy

The Telegram root Specification is a native child of Workspace Specification
`sachkov-inside/workspace#65`. Telegram implementation tickets are native children of the Telegram
Specification. Platform convergence remains owned by `sachkov-inside/platform#52` and depends on
the independently passing Telegram provider contract.
