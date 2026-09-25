---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets. Resolve the fixed point before
editing so verification and review compare the whole implementation against one stable baseline.

Use /tdd where possible, at pre-agreed seams.

While iterating, run typechecking and the single test files for what you change; `Ready and Done`
in the repository-root `WORKFLOW.md` owns the rest of verification.

## Review closure

For implementation, specification, or architecture changes, read and follow `Review closure`,
`Rule sources`, `Documentation impact`, `Session learning`, `Pull request CI closure`,
`Implementation report`, `Architecture fitness`, `Pruning`, and `Session cleanup` in the
repository-root `WORKFLOW.md`. Those sections are the authority for finding dispositions, rule
sources, documentation reconciliation, current-head CI ownership, learning promotion, and
completion.

Invoke `/code-review` from the original fixed point. When review changes code or durable documents,
re-run the relevant verification and invoke `/code-review` from that same fixed point again. Commit
and push as `Pull request CI closure` describes. Before finishing, reconcile
`Documentation impact` and `Session learning`, execute the authoritative `Implementation report`
section, then its `Session cleanup` section.
