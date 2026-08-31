# Telegram credentialed proof

Status: **pending owner-assisted execution** for Telegram #9. The application, wizard, probes,
owner recovery interface, and safe disposal path are versioned; no real BotFather credential,
closed chat, or temporary HTTPS callback has been supplied in this branch.

Run from the repository root with Node from `.node-version`:

```bash
pnpm credentialed-proof:wizard
```

The wizard has thirteen resumable stages and writes credentials/provider identifiers only to the
ignored local `.env`. Machine observations are reduced to status vocabulary, rights, booleans, and
counts in the ignored mode-`0600` `.credentialed-proof/evidence.json`. Neither file may be pasted
into an issue, PR, log, or committed report. Static verification uses only non-secret fixtures:

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
| Closed chat | private group/supergroup type and exact minimum client-assignable administrator-right names | pending |
| Webhook auth | correct secret accepted; missing/wrong secret rejected | pending |
| Webhook durability | inbox insert precedes `2xx`; duplicate update remains one durable inbox item | pending |
| Webhook retry | non-`2xx` delivery error observed, then retry/recovery without duplicate processing | pending |
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
- aggregate inbox/delivery/event/recovery counts;
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
