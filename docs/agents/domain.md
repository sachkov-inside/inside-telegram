# Domain docs

Read [`docs/product/telegram-application-brief.md`](../product/telegram-application-brief.md) for
the canonical Telegram product boundary. Read root `CONTEXT.md` and relevant `docs/adr/` entries
when they exist.

Shared Membership authority and wire-contract decisions arrive through the linked Workspace
Specification. Record each Telegram-specific consequence once:

- product scope in the Telegram application brief;
- application behavior and interfaces in the root technical Specification;
- canonical terminology in `CONTEXT.md`;
- a hard-to-reverse, surprising technical trade-off in an application ADR.

Keep build, test, run, deploy, and agent runtime dependent only on files in this repository.
