"""Pure Inside tracker decisions. GitHub adapters supply complete snapshots."""
from dataclasses import dataclass


ROLES = {'needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'}


@dataclass(frozen=True)
class Decision:
    project: int
    status: str | None
    reason: str
    archive: bool = False
    close: bool = False


def unfinished(items):
    return any(i['state'] != 'CLOSED' or i.get('stateReason') != 'COMPLETED' for i in items)


def decide(item, current=None):
    labels = set(item.get('labels', []))
    human = 'backlog:human' in labels
    project = 2 if human else 1
    if item.get('archived') or 'tracker:paused' in labels:
        return Decision(project, None, 'preserve archived or explicitly paused work')
    if item['kind'] == 'PullRequest':
        if item['state'] == 'MERGED':
            return Decision(1, 'Done', 'pull request merged')
        if item['state'] == 'CLOSED':
            return Decision(1, None, 'pull request closed without merge', archive=True)
        return Decision(1, 'In progress' if item['draft'] else 'Review', 'pull request draft/review state')
    if item['state'] == 'CLOSED':
        return Decision(project, 'Done', 'issue closed; preserve completion reason')
    if human:
        status = current if current in {'Todo', 'In Progress'} else 'Todo'
        return Decision(2, status, 'preserve owner product decision')
    children = item.get('children', [])
    blocked = unfinished(item.get('blockers', []))
    gate = bool(labels & {'needs-info', 'ready-for-human', 'tracker:gate'})
    if (children and 'tracker:auto-complete' in labels and not unfinished(children)
            and not blocked and not gate):
        return Decision(1, 'Done', 'explicit aggregate policy; children and gates complete', close=True)
    if children:
        return Decision(1, current if current and current != 'Done' else 'Inbox',
                        'aggregate requires acceptance or remaining child work')
    session = item.get('session') or {}
    if blocked or gate or session.get('phase') == 'blocked':
        return Decision(1, 'Blocked', 'unresolved dependency, owner gate, or session blocker')
    prs = item.get('prs', [])
    if any(p['state'] == 'OPEN' and not p.get('isDraft') for p in prs):
        return Decision(1, 'Review', 'linked non-draft pull request')
    if session.get('phase') == 'active' or any(p['state'] == 'OPEN' for p in prs):
        return Decision(1, 'In progress', 'active session or linked draft pull request')
    if session.get('phase') == 'review':
        return Decision(1, 'Blocked', 'review handoff has no open non-draft pull request')
    # Existing manual work has no session identity yet. Never take it over by inference.
    if not session and current in {'In progress', 'Review', 'Blocked'}:
        return Decision(1, current, 'legacy state needs explicit session adoption')
    if labels & ROLES == {'ready-for-agent'}:
        return Decision(1, 'Ready', 'specified, unblocked, no active session')
    return Decision(1, 'Inbox', 'readiness requires triage')
