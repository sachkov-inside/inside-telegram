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
    session = item.get('session') or {}
    prs = item.get('prs', [])
    if children and unfinished(children) and (
            current in {'In progress', 'Review', 'Blocked'} or session or prs):
        # An aggregate is active while a child, a session, or a pull request is. A
        # manual active state without any of them is preserved for owner adoption.
        return Decision(1, current if current and current != 'Done' else 'In progress',
                        'aggregate requires acceptance or remaining child work')
    if children and unfinished(children):
        # An aggregate with unfinished children is never itself ready to implement.
        return Decision(1, 'In progress', 'aggregate requires acceptance or remaining child work')
    # Every child is complete, or nothing is active any more: decide this item's own
    # readiness instead of leaving the aggregate in a stale aggregate state.
    if blocked or gate or session.get('phase') == 'blocked':
        return Decision(1, 'Blocked', 'unresolved dependency, owner gate, or session blocker')
    if any(p['state'] == 'OPEN' and not p.get('isDraft') for p in prs):
        return Decision(1, 'Review', 'linked non-draft pull request')
    if session.get('phase') == 'active' or any(p['state'] == 'OPEN' for p in prs):
        return Decision(1, 'In progress', 'active session or linked draft pull request')
    if session.get('phase') == 'review':
        return Decision(1, 'Blocked', 'review handoff has no open non-draft pull request')
    # Existing manual work has no session identity yet. Never take it over by inference.
    # A fully completed aggregate is not such work: its readiness is derived above.
    if not session and current in {'In progress', 'Review', 'Blocked'} and not (
            children and not unfinished(children)):
        return Decision(1, current, 'legacy state needs explicit session adoption')
    if labels & ROLES == {'ready-for-agent'}:
        return Decision(1, 'Ready', 'specified, unblocked, no active session')
    return Decision(1, 'Inbox', 'readiness requires triage')
