# Skills: источники

## Чистая копия upstream

Источник: <https://github.com/mattpocock/skills>, ветка `main`, commit
`d81f3a183412e71a5b1e84ca21bc1a35eea03a60` от 2026-09-29.

Скопированы все каталоги из `skills/engineering` и `skills/productivity`, 27 skills:

`ask-matt`, `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grill-me`,
`grill-with-docs`, `grilling`, `handoff`, `implement`, `implement-spec`,
`improve-codebase-architecture`, `pr`, `prototype`, `research`, `retro`,
`setup-matt-pocock-skills`, `tdd`, `teach`, `to-questionnaire`, `to-spec`, `to-tickets`, `triage`,
`wait-what`, `wayfinder`, `wizard`, `writing-for-agents`.

Эти каталоги не правятся. Постоянное поведение проекта живёт в `WORKFLOW.md` и `AGENTS.md`.

## Не из upstream

- Frontend-набор, только в `platform`: `impeccable`, `vercel-react-best-practices`,
  `modern-web-guidance`, `playwright-cli`.
- `karpathy-guidelines`: остаётся до переноса его правил в профиль устройства.
- Свои skills проекта: `session-cleanup`.

## Проверка и обновление

Копия чистая, когда команда ничего не печатает:

```bash
git clone --quiet https://github.com/mattpocock/skills /tmp/mattpocock-skills
git -C /tmp/mattpocock-skills checkout --quiet d81f3a183412e71a5b1e84ca21bc1a35eea03a60
for d in /tmp/mattpocock-skills/skills/engineering/*/ /tmp/mattpocock-skills/skills/productivity/*/; do
  diff -rq "${d%/}" ".agents/skills/$(basename "$d")"
done
```

Обновление: заменить 27 каталогов копией с нового commit, записать его здесь и посмотреть
`git diff`.

## Копия в другой репозиторий

`platform` — источник процесса. `inside-telegram` получает `WORKFLOW.md`, skills без
frontend-набора, `docs/agents/triage-labels.md` и labels одной командой из `platform`:

```bash
bash scripts/copy-process.sh <путь к репозиторию>
bash scripts/copy-process.sh --check <путь к репозиторию>
```

Копию не правят на месте: правка идёт в `platform` и приходит повторным запуском команды.
