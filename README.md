# Sachkov Inside Telegram

Private repository for the Telegram application of Sachkov Inside.

The application starts as a production-grade Membership bridge and later becomes the Telegram
surface for Inside communications and marketing. Its first delivery connects a Telegram contact
to a Platform Account, observes membership in the canonical closed chat, and supplies bounded
evidence to Platform without making content requests wait for Telegram.

Current stage: **seed**. The repository contains the confirmed product boundary and decision log
only. Application code, harness, tracker specification, credentials, bot registration, deployment,
and production enablement have not been created yet.

## Durable documents

- [`docs/product/telegram-application-brief.md`](docs/product/telegram-application-brief.md) —
  confirmed product outcome and v1 boundary.
- [`docs/decisions/seed-decisions.md`](docs/decisions/seed-decisions.md) — confirmed decisions and
  unresolved inputs for the next artifact.

## Repository boundary

This repository will own Telegram bot identity handling, bot contacts, linking, member-status
updates, reconciliation, and normalized Membership Evidence. Platform remains the authority for
Platform Accounts, permissions, entitlements, profiles, and every content-access decision.
