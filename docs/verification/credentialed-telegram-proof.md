# Telegram credentialed proof

Status: **pending owner-assisted execution** for Telegram #9. The application, wizard, probes,
owner recovery interface, and safe disposal path are versioned; no real BotFather credential,
closed chat, or temporary HTTPS callback has been supplied in this branch.

Prepare an ignored `.env` whose `DATABASE_URL` names an isolated loopback `issue9` or `proof`
database, then run from the repository root with Node from `.node-version`:

```bash
pnpm credentialed-proof:wizard
```

Before BotFather opens, the wizard verifies the required CLI versions, repository root, ignored
destinations, isolated database URL, and owner login readiness. It binds every probe and recovery
command to the selected `ENV_FILE` and gives the same `DOTENV_CONFIG_PATH` for the application
terminal. Its thirteen resumable stages write credentials/provider
identifiers only to that mode-`0600` file. Machine observations are reduced to ordered stage
snapshots containing status vocabulary, current administrator-right names, booleans, version
ranges, and aggregate counts in ignored mode-`0600` `.credentialed-proof/evidence.json`. Neither
file may be pasted into an issue, PR, log, or committed report. Static verification uses only
non-secret fixtures:

```bash
bash -n scripts/credentialed-proof-wizard.sh
shellcheck -e SC2034 scripts/credentialed-proof-wizard.sh
CREDENTIALED_PROOF_DRY_RUN=1 ENV_FILE=<temporary-file> \
  bash scripts/credentialed-proof-wizard.sh
```

## Required final evidence

The reviewing agent replaces `pending` only after observing the local evidence file and the owner
confirmations. Record no identifiers or provider payloads in this document.

| Area | Required redacted observation | Result |
|---|---|---|
| Bot identity | `getMe` id/username match the dedicated BotFather bot; old token rejects after revoke | pending |
| Closed chat | private group/supergroup type, owner-confirmed client minimum, implied `can_manage_chat`, and every current assignable administrator-right name | pending |
| Webhook auth | correct secret accepted; missing/wrong secret rejected | pending |
| Webhook durability | inbox insert precedes `2xx`; duplicate update remains one durable inbox item | pending |
| Webhook retry | exact synthetic marker absent during provider error/pending state, then present once after retry with provider queue drained | pending |
| Contactability | ordinary `/start`, block diagnostic, unblock + new `/start` recovery | pending |
| Link bearer | valid, expired, replay, concurrent consume, same-pair idempotence, conflict | pending |
| Membership | reachable statuses match normalization; removal denies and newer rejoin restores | pending |
| Reconciliation | deliberately missed removal repaired without stale positive extension | pending |
| Provider loss | bot demotion and provider outage degrade/fail closed; restoration recovers | pending |
| Owner recovery | dry-run read-only; exact-confirm execute; idempotent replay; immutable audit | pending |
| Disposal | webhook removed, pending test updates disposed, token revoked, chat/endpoint/secrets disposition recorded | pending |
| Secret scan | Git tree, issue, PR, durable report, and captured output contain no token, raw PII, chat ID, or provider payload | pending |

## Final report fields

When complete, add only:

- tested Git revisions and a rounded UTC proof window;
- boolean result for every row above;
- observed Telegram status and administrator-right vocabulary without chat/user/bot identifiers;
- ordered stage snapshots with aggregate inbox/link/delivery/membership/provider/reconciliation/recovery counts and evidence-version ranges;
- owner recovery fingerprints, never raw references;
- token/webhook/chat/endpoint disposal booleans;
- Standards and Spec review verdicts.

Production domains, permanent credentials, deploy, monitoring, traffic, and production GO remain
outside this proof.

## Official facts reverified 2026-08-31

- [Telegram Bot Features](https://core.telegram.org/bots/features#creating-a-new-bot) documents
  `/newbot`, token secrecy, and `/token` rotation through BotFather.
- [Telegram Bot API](https://core.telegram.org/bots/api#setwebhook) defines the HTTPS callback,
  supported ports, non-`2xx` retry, separate secret header, exact `allowed_updates`,
  `getWebhookInfo`, and pending-update disposal.
- [`chat_member`](https://core.telegram.org/bots/api#chatmemberupdated) requires the bot to be an
  administrator and the update type to be explicitly selected; `getChatMember` for another user is
  guaranteed only while the bot is an administrator.
- [Telegram webhook guide](https://core.telegram.org/bots/webhooks) owns the current TLS, port,
  certificate, and reachability requirements for the temporary callback.
