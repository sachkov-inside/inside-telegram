#!/usr/bin/env python3
"""Отчёт агента: создать файл с фактами, проверить разделы, сдать.

    report.py new --task <номер|ссылка|строка> --name <имя> [--html] [--worktree <путь>] [--agent <агент>]
    report.py check <файл отчёта>
    report.py finish <файл отчёта>

Отчёт — один файл: <основной каталог проекта>/.reports/<задача>/<дата>-<имя>.md
(или .html, если нужна диаграмма). Зависимостей нет: только стандартная библиотека Python 3.9+.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

STATUSES = ("готово", "остановлено", "ждёт приёмки")
AGENTS = {"claude-code", "codex", "other"}
SECTIONS = ("Что сделано", "Что нужно от владельца", "Проверка", "Решения", "Что дальше")
PROVED = "Проверено командой"
URL = re.compile(r"^https?://\S+$")
SLUG = re.compile(r"[^a-z0-9а-яё]+")
COMMENT = re.compile(r"<!--.*?-->", re.S)
TAG = re.compile(r"<[^>]+>")


# ── Проверка разделов ─────────────────────────────────────────────────────


def sections(text: str, is_html: bool) -> tuple[str, dict[str, str]]:
    """Шапка до первого раздела и разделы второго уровня: заголовок → текст."""
    text = COMMENT.sub("", text)
    if is_html:
        text = re.sub(r"<style.*?</style>|<script.*?</script>|<svg.*?</svg>", "", text, flags=re.S | re.I)
        text = re.sub(r"<h2[^>]*>(.*?)</h2>", lambda m: "\n## " + TAG.sub("", m.group(1)) + "\n", text, flags=re.S | re.I)
        text = re.sub(r"<h3[^>]*>(.*?)</h3>", lambda m: "\n### " + TAG.sub("", m.group(1)) + "\n", text, flags=re.S | re.I)
        text = re.sub(r"<li[^>]*>", "\n- ", text, flags=re.I)
        text = re.sub(r"</?code[^>]*>", "`", text, flags=re.I)
        text = re.sub(r'<a [^>]*href="(https?://[^"]+)"[^>]*>', r" \1 ", text, flags=re.I)
        text = TAG.sub("", text)
    text = re.sub(r"^```.*?^```", "", text, flags=re.S | re.M)
    parts = re.split(r"^## +(.+?)\s*$", text, flags=re.M)
    return parts[0], {title.strip(): body.strip() for title, body in zip(parts[1::2], parts[2::2])}


def validate(text: str, is_html: bool = False) -> list[str]:
    """Ошибки отчёта; пустой список значит «отчёт верен»."""
    errors: list[str] = []
    head, found = sections(text, is_html)
    status = re.search(r"^Статус:\s*(.+?)\s*$", head, re.M)
    if not status or status.group(1) not in STATUSES:
        errors.append(f"шапка: строка «Статус: …», допустимы {', '.join(STATUSES)}")
    for title in SECTIONS:
        if title not in found:
            errors.append(f"раздел «{title}» отсутствует")
        elif not found[title]:
            errors.append(f"раздел «{title}» пуст; нечего сказать — напиши «Нет.»")
    checks = found.get("Проверка", "")
    if "Проверка" in found and not re.search(r"^\s*[-*] +\S", checks, re.M):
        errors.append("раздел «Проверка»: нужен хотя бы один пункт списка")
    for block in re.split(r"^### +", checks, flags=re.M):
        if not block.startswith(PROVED):
            continue
        for line in re.findall(r"^\s*[-*] +(.+)$", block, re.M):
            if "`" not in line and "http" not in line:
                errors.append(f"«{PROVED}»: у пункта нужна команда в `…` или ссылка: {line[:80]}")
    return errors


def check_file(path: Path) -> list[str]:
    if path.suffix not in {".md", ".html"}:
        return [f"{path}: отчёт — файл .md или .html"]
    try:
        return validate(path.read_text(encoding="utf-8"), is_html=path.suffix == ".html")
    except (OSError, UnicodeDecodeError) as error:
        return [f"{path}: не читается: {error}"]


# ── Факты из git, tracker и сессии ────────────────────────────────────────


def _run(args: list[str], cwd: Path | None = None, timeout: float = 10) -> str | None:
    try:
        done = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout.strip() if done.returncode == 0 else None


def main_checkout(path: Path) -> Path | None:
    """Основной каталог проекта: из worktree он находится через общий каталог git."""
    common = _run(["git", "-C", str(path), "rev-parse", "--path-format=absolute", "--git-common-dir"])
    if not common:
        return None
    common_path = Path(common).resolve()
    return common_path.parent if common_path.name == ".git" else common_path


def slug(text: str, limit: int = 48) -> str:
    value = SLUG.sub("-", text.lower()).strip("-")
    return value[:limit].strip("-") or "report"


def session_facts(agent: str | None) -> tuple[str, str]:
    if os.environ.get("CLAUDE_CODE_SESSION_ID"):
        return agent or "claude-code", os.environ["CLAUDE_CODE_SESSION_ID"]
    if os.environ.get("CODEX_THREAD_ID"):
        return agent or "codex", os.environ["CODEX_THREAD_ID"]
    return agent or "other", "unknown"


def task_facts(ref: str, cwd: Path) -> tuple[str, str, str]:
    """Задача: строка для шапки, имя каталога, заголовок отчёта."""
    match = re.fullmatch(r"#?(\d+)", ref.strip())
    if match or URL.match(ref.strip()):
        raw = _run(["gh", "issue", "view", ref.strip().lstrip("#"), "--json", "number,title,url"], cwd=cwd)
        try:
            issue = json.loads(raw or "")
            return f"[#{issue['number']}]({issue['url']}) {issue['title']}", str(issue["number"]), issue["title"]
        except (ValueError, KeyError):
            number = match.group(1) if match else slug(ref)
            return f"#{number}", number, f"Задача #{number}"
    return ref.strip(), slug(ref, 32), ref.strip()


MD = """# {title}

Статус: ждёт приёмки
Задача: {task}
Проект: {project}; ветка `{branch}`; worktree `{worktree}`
PR: {pr}
Сессия: {agent} `{session}`
Создан: {created}

<!-- Статус: готово, остановлено или ждёт приёмки. Комментарии finish не читает. -->

## Что сделано

<!-- От одной до пяти строк простыми словами: кто что сделал. -->

## Что нужно от владельца

<!-- Решение, вход, gate. Ничего — «Нет.» -->

## Проверка

### Проверено командой

<!-- - Что проверено: `команда` или ссылка на CI. -->

### Проверить владельцу

### Не проверено

## Решения

<!-- Развилки, которые агент решил сам, и почему. Не было — «Нет.» -->

## Что дальше
"""

HTML = """<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{ color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --mute: #6e6e73; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --fg: #f2f2f2; --bg: #1c1c1e; --mute: #a1a1a6; }} }}
  body {{ font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg);
         max-width: 760px; margin: 2rem auto; padding: 0 16px; }}
  .head {{ color: var(--mute); white-space: pre-line; }}
  svg {{ max-width: 100%; height: auto; }}
</style>
<h1>{title}</h1>
<p class="head">Статус: ждёт приёмки
Задача: {task}
Проект: {project}; ветка <code>{branch}</code>; worktree <code>{worktree}</code>
PR: {pr}
Сессия: {agent} <code>{session}</code>
Создан: {created}</p>
<!-- Статус: готово, остановлено или ждёт приёмки. -->

<h2>Что сделано</h2>
<!-- Диаграмма: inline SVG здесь или в «Решения». -->

<h2>Что нужно от владельца</h2>

<h2>Проверка</h2>
<h3>Проверено командой</h3>
<ul></ul>
<h3>Проверить владельцу</h3>
<h3>Не проверено</h3>

<h2>Решения</h2>

<h2>Что дальше</h2>
</html>
"""


def new(args: argparse.Namespace) -> int:
    agent, session_id = session_facts(args.agent)
    worktree = Path(args.worktree).expanduser() if args.worktree else Path.cwd()
    top = _run(["git", "-C", str(worktree), "rev-parse", "--show-toplevel"])
    if not top:
        print(f"report: {worktree} не в репозитории git; укажи --worktree", file=sys.stderr)
        return 1
    worktree = Path(top)
    main = main_checkout(worktree) or worktree
    branch = _run(["git", "-C", str(worktree), "branch", "--show-current"]) or "detached"
    pr: list[str] = []
    if branch not in {"detached", "main", "master", "dev"}:
        raw = _run(["gh", "pr", "list", "--state", "all", "--head", branch, "--json", "url", "-q", ".[].url"], cwd=worktree)
        pr = (raw or "").split()
    task, task_slug, title = task_facts(args.task, worktree)
    now = datetime.now().astimezone().replace(microsecond=0)
    suffix = ".html" if args.html else ".md"
    base = main / ".reports" / task_slug
    path = base / f"{now:%Y-%m-%d}-{slug(args.name)}{suffix}"
    number = 2
    while path.exists():
        path = base / f"{now:%Y-%m-%d}-{slug(args.name)}-{number}{suffix}"
        number += 1
    base.mkdir(parents=True, exist_ok=True)
    template = MD
    if args.html:
        template = HTML
        title = html.escape(title)
        task = re.sub(r"\[(.+?)\]\((\S+?)\)(.*)", lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>'
                      + html.escape(m.group(3)), task) if task.startswith("[") else html.escape(task)
    path.write_text(template.format(
        title=title, task=task, project=main.name, branch=branch, worktree=worktree,
        pr=", ".join(pr) or "нет", agent=agent, session=session_id, created=now.isoformat(),
    ), encoding="utf-8")
    if _run(["git", "-C", str(main), "check-ignore", "-q", ".reports/x"]) is None:
        print(f"report: внимание, .reports/ не игнорируется git в {main}; добавь строку .reports/ в .gitignore",
              file=sys.stderr)
    print(path)
    return 0


def check(args: argparse.Namespace) -> int:
    errors = check_file(Path(args.file))
    for error in errors:
        print(f"ошибка: {error}", file=sys.stderr)
    print("FAIL" if errors else "OK")
    return 1 if errors else 0


def finish(args: argparse.Namespace) -> int:
    path = Path(args.file).resolve()
    errors = check_file(path)
    if errors:
        for error in errors:
            print(f"ошибка: {error}", file=sys.stderr)
        print("Отчёт не сдан: исправь ошибки и запусти finish снова.", file=sys.stderr)
        return 1
    # Время отчёта — время сдачи: строка «Сдан:» встаёт после «Создан:» или обновляется.
    text = path.read_text(encoding="utf-8")
    stamp = f"Сдан: {datetime.now().astimezone().replace(microsecond=0).isoformat()}"
    if re.search(r"^Сдан: ", text, re.M):
        text = re.sub(r"^Сдан: [^\n<]*", stamp, text, count=1, flags=re.M)
    elif re.search(r"^Создан: ", text, re.M):
        text = re.sub(r"^(Создан: [^\n<]*)", lambda m: f"{m.group(1)}\n{stamp}", text, count=1, flags=re.M)
    else:
        print("ошибка: в шапке нет строки «Создан: …»", file=sys.stderr)
        print("Отчёт не сдан: исправь ошибки и запусти finish снова.", file=sys.stderr)
        return 1
    path.write_text(text, encoding="utf-8")
    head, found = sections(text, path.suffix == ".html")
    status = re.search(r"^Статус:\s*(.+?)\s*$", head, re.M)
    first = found["Что сделано"].splitlines()[0].lstrip("-* ")
    print(f"Отчёт: {path}")
    print(f"Итог: {status.group(1) if status else ''}. {first}")
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = root.add_subparsers(dest="command", required=True)
    new_parser = commands.add_parser("new", help="создать файл отчёта с фактами")
    new_parser.add_argument("--task", required=True, help="номер задачи, ссылка или строка")
    new_parser.add_argument("--name", required=True, help="короткое имя отчёта")
    new_parser.add_argument("--html", action="store_true", help="отчёт .html: нужна диаграмма")
    new_parser.add_argument("--worktree", help="где шла работа; по умолчанию текущий каталог")
    new_parser.add_argument("--agent", choices=sorted(AGENTS))
    new_parser.set_defaults(handler=new)
    for name, handler in (("check", check), ("finish", finish)):
        sub = commands.add_parser(name)
        sub.add_argument("file")
        sub.set_defaults(handler=handler)
    return root


def main() -> int:
    args = parser().parse_args()
    return int(args.handler(args))


if __name__ == "__main__":
    sys.exit(main())
