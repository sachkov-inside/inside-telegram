# Telegram ↔ Platform Membership conformance

Status: **passed in a controlled two-application environment** for Telegram #8 and Platform #52.
Production credentials, Telegram registration, deployment, and traffic remain Telegram #9.

## Tested revisions

| Application | Revision | Role |
|---|---|---|
| Telegram | `sachkov-inside/inside-telegram@4d9aca2c5431200317a547a2c32d0fdc81e9cdb0` | identity-link provider and Membership Evidence producer |
| Platform | `sachkov-inside/platform@1e10837689a39665087da26fa6038faebbeb7596` | Account-bound link consumer, evidence ingress, entitlement projection, and ContentAccess |

The proof ran each application from its own worktree, package graph, migration ledger, and
PostgreSQL database. The only application seam was authenticated loopback HTTP. No test or runtime
imported code, packages, migrations, database tables, or fixtures from the other checkout.

## Supported-version matrix

| Interface | Telegram | Platform | Compatibility behavior |
|---|---|---|---|
| `inside.identity-linking.v1` begin | accepts authenticated digest + opaque Account correlation | emits through the production HTTP adapter | exact Account/correlation binding; malformed or other versions reject |
| `inside.identity-linking.v1` confirm | returns typed final or recovery state | accepts only for the Account that began the local transaction | link alone grants no entitlement |
| `inside.membership-evidence.v1` | emits the canonical normalized envelope | strictly validates and accepts it | Bearer + `Idempotency-Key` + `X-Inside-Membership-Evidence-Source` are required |
| any Membership Evidence version other than v1 | never emitted | rejects with `unsupported_contract` | no current projection change |

Both repositories vendor the same Workspace artifacts from
`sachkov-inside/workspace@345fbdbb8e4ac8eacff203a8fa91a40032adecc1`:

- `schema.json` SHA-256 `4fd818665f46dae9ec0590d5d8a3888fb572d94b26957e93c46aaf7be03743ed`;
- `fixtures.json` SHA-256 `d7d47bcc43f0fb6f73bb64e1cf9053a0443b9d4573605ea9f601e1e17e611dc4`.

Telegram verifies the exact digests, JSON round trip, schema result, and provider-side five-minute
invariant for every applicable corpus case. Platform verifies the same digests and executes the
consumer outcome corpus. To update the contract, first merge a reviewed Workspace artifact change,
then update each repository's vendored files and `snapshot.json` provenance in independent PRs;
never read a Workspace or sibling checkout at build/test/runtime.

## Two-application journey

A temporary orchestration process started the production-shaped Nest/Fastify applications on
separate loopback ports. Platform called Telegram's real begin/confirm endpoints through
`HttpTelegramLinkProvider`; Telegram called Platform's real evidence ingress through
`HttpPlatformEvidenceAdapter`. A synthetic ES384/JWKS Account proof and temporary base64url
integration credentials existed only in process memory. The journey proved:

| Case | Observed outcome |
|---|---|
| Account link before evidence | protected Material returned a locked teaser |
| initial member | `link_time` evidence created a bounded entitlement; Material body became available |
| initial non-member | second linked Account remained locked |
| newer removal | `member_status_event` revision denied on the next Material request |
| older replay | did not change the Platform projection or restore access |
| newer rejoin | restored the bounded entitlement and Material body |
| duplicate Telegram update | inbox/outbox replay left the evidence revision unchanged |
| duplicate Telegram identity for another Account | Telegram recorded conflict; Platform returned `recovery-required`; no transfer occurred |
| provider outage and real TTL expiry | reconciliation emitted unavailable evidence; after the actual five-minute TTL the Material locked |
| Platform request during outage | membership-adapter calls before/after the request were identical (`0` request-path Telegram calls) |
| provider recovery | newer administrator + subject-member events restored access |
| wrong evidence credential | HTTP 401 and no projection change |
| `inside.membership-evidence.v2` | HTTP 400 `unsupported_contract` and no projection change |

The redacted terminal audit after recovery was:

- Telegram: 2 linked identities and 1 conflicting transaction; delivered outbox rows were
  `link_time=2`, `member_status_event=3`, `reconciliation=12`;
- Platform: 3 link transactions (`linked=2`, `recovery_required=1`), 2 current projections
  (`member=1`, `not_member=1`), and 18 evidence receipts;
- Platform receipts: 5 applied observed revisions, 12 accepted unavailable reconciliation
  observations during the deliberate outage, and 1 unsupported-version audit receipt;
- both link schemas contained zero raw bearer/token columns. Telegram ingress had already replaced
  the deep-link bearer with its SHA-256/base64url digest before persistence.

## Verification

Telegram revision `4d9aca2` passed:

```bash
DATABASE_URL=postgresql://inside:inside@127.0.0.1:5433/<task-db> pnpm check:full
```

Results: format, lint, typecheck, architecture guardrails, build, 95 unit tests, and 66 PostgreSQL
integration tests passed. The cross-application run then migrated fresh task-specific databases and
completed `inside.telegram-platform-conformance.v1` with every assertion true.

The Workspace harness health/diff command separately reports pre-existing managed drift between
the installed Telegram harness and the current Workspace package (`WORKFLOW.md` and
`.inside-harness/product-harness.json`). No #8 source or test file is inside that managed surface,
and this delivery does not rewrite the owner's harness state.

No real bot token, Telegram user, chat identifier, email, production endpoint, or production secret
was used or recorded. The temporary proof databases and runner files were removed after the
redacted counts above were captured.
