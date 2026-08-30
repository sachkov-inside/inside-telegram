# Triage labels

Use the canonical roles from `mattpocock/skills` without renaming them.

| Canonical role | GitHub label | Meaning |
|---|---|---|
| `needs-triage` | `needs-triage` | Maintainer evaluation is required |
| `needs-info` | `needs-info` | Reporter information is required |
| `ready-for-agent` | `ready-for-agent` | Fully specified for autonomous agent implementation |
| `ready-for-human` | `ready-for-human` | Human implementation or judgment is required |
| `wontfix` | `wontfix` | The work will not be actioned |

Every triaged delivery issue has exactly one role from this table. A Workspace owner-facing issue
labelled `backlog:human` is an input to delivery rather than an implementation issue: it carries no
readiness role until an agent promotes its outcome into repository-owned Specifications and
Tickets. `backlog:human` routes the issue between Projects and never substitutes for readiness.
Category labels are optional and independent from readiness.
