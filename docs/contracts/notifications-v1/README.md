# Notifications corpus Platform #434

Protocol/schema/fixtures/scenarios/manifest/sources копируются byte-for-byte из exact Platform SHA,
записанного в [provenance.json](provenance.json). Candidate copy из unmerged PR требует review
и upstream acceptance до merge provider PR. Сетевые source imports и общая БД не используются.

[schema.json](schema.json), [fixtures.json](fixtures.json), [scenarios.json](scenarios.json),
[protocol.md](protocol.md) и [manifest.json](manifest.json) — единый corpus двух consumers.
[Provider specification](../../specifications/community-and-notifications-v1.md) определяет Bot API
действия, права, mapping и границу доказательств. Старый [billing bundle](../billing-v1/README.md)
сохраняет community контракт отдельно. Shape/hash checks не доказывают реальный broker или send.
