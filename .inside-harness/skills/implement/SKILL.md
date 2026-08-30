---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets. Resolve the fixed point before
editing so verification and review compare the whole implementation against one stable baseline.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

## Review closure

For implementation, specification, or architecture changes, read and follow `Review closure`,
`Architecture fitness`, and `Pruning` in the repository-root `WORKFLOW.md`. Those sections are the
authority for finding dispositions, learning promotion, and completion.

Invoke `/code-review` from the original fixed point. When review changes code or durable documents,
re-run the relevant verification and invoke `/code-review` from that same fixed point again. Commit
only after the `WORKFLOW.md` readiness gate is satisfied.
