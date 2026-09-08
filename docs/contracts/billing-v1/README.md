# Community corpus Platform #403

Protocol/schema/fixtures/scenarios/manifest/sources — byte-identical копия Platform commit
`1fdcf11017e16690a95aa12a830492d1aaf0b6cd`; [provenance.json](provenance.json) фиксирует источник.
Подходящие consumer правила — [provider specification](../../specifications/community-and-notifications-v1.md).

[schema.json](schema.json), [fixtures.json](fixtures.json), [scenarios.json](scenarios.json),
[protocol.md](protocol.md) и [manifest.json](manifest.json) проверяются локально без чужого checkout.
Community entitlement и community dispatch остаются v1; старые notification shapes сохраняются
как immutable история и заменяются [Notifications](../notifications-v1/README.md).
Нельзя включать старый и новый notification send на одну бизнес-операцию.
