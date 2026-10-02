# Documentation maintenance

Use this table to find the owner of a changed durable fact. Every durable fact has one owning document. Product scope, application behaviour, canonical terms,
and ADRs follow [domain.md](domain.md); this table adds the owners that routing does not cover.

| Changed fact | Owning document |
|---|---|
| Wire contract shared with Platform | The versioned protocol under [docs/contracts](../contracts/) |
| Integration with a Platform capability | The matching document under [docs/integrations](../integrations/) |
| Bootstrap stack, credentialed-proof gates, open setup decisions | [docs/decisions/seed-decisions.md](../decisions/seed-decisions.md) |
| Run, deploy, recovery, or relay procedure | The matching runbook under [docs/operations](../operations/) |
| Agent routing and verification commands | [AGENTS.md](../../AGENTS.md) |
| Delivery workflow, review, readiness, shared skills | `WORKFLOW.md` and `.agents/skills` in `platform`; this repository holds a copy made by `scripts/copy-process.sh` |

When code, schemas, and tests are the complete authority for a local detail, record
`None — code/schema/tests are the authority` in the pull request instead of an empty prose edit.
