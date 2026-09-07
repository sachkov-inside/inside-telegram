#!/usr/bin/env python3
"""Session commands through a single Workspace Actions writer. No automatic lease expiry."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from inside_tracker import CONTROLLER, GitHub, MARKER, Reconciler, TrackerError, identity, snapshot
from tracker_policy import ROLES, unfinished

SESSION_WORKFLOW = 'inside-agent-sessions.yml'
# Existing automation credential owner; changing the writer is an explicit migration.
WRITER = 'KirillSachkov'
PHASES = {'start': 'active', 'block': 'blocked', 'handoff': 'review', 'release': 'released'}


def read_session(api, repo, number):
    comments = api.pages(f'repos/{repo}/issues/{number}/comments')
    matches = [c for c in comments if c['user']['login'] == WRITER and c['body'].startswith(MARKER)]
    if not matches:
        return None, None
    if len(matches) != 1:
        raise TrackerError('Multiple controller state comments; resolve before writing')
    comment = matches[0]
    try:
        state = json.loads(comment['body'][len(MARKER):].strip())
        validate_state(state)
    except (ValueError, KeyError, TypeError) as error:
        raise TrackerError('Malformed trusted session state; owner repair required') from error
    return state, comment['id']


def validate_state(state):
    required = {'session', 'request', 'command', 'phase', 'branch', 'reason', 'updated_at'}
    if not isinstance(state, dict) or set(state) != required or not all(isinstance(v, str) for v in state.values()):
        raise ValueError('invalid session shape')
    if state['command'] not in PHASES or PHASES[state['command']] != state['phase']:
        raise ValueError('command/phase mismatch')
    if not all(re.fullmatch(r'[A-Za-z0-9_-]{8,100}', state[k]) for k in ('session', 'request')):
        raise ValueError('invalid session identifiers')
    if not re.fullmatch(r'(feat|fix|docs|chore|research|prototype)/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}', state['branch']):
        raise ValueError('invalid task branch')
    timestamp = datetime.fromisoformat(state['updated_at'])
    if timestamp.tzinfo is None or state['command'] != 'start' and not state['reason'].strip():
        raise ValueError('timestamp/reason missing')


def fingerprint(values):
    return hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def transition(item, state, command, session, branch, reason, request):
    if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', session):
        raise TrackerError('session must be a stable unique identifier (8–100 safe characters)')
    if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', request):
        raise TrackerError('invalid request identifier')
    if state and state['request'] == request:
        if (state['session'] != session or state.get('command') != command or
                state['reason'] != reason.strip() or command == 'start' and state['branch'] != branch):
            raise TrackerError('request identifier was already used for another operation')
        return state
    held = state and state['phase'] != 'released'
    if held and state['session'] != session:
        raise TrackerError(f"Task is occupied by session {state['session']}")
    if command == 'start':
        if item['kind'] != 'Issue' or item['state'] != 'OPEN':
            raise TrackerError('Start requires an open issue')
        labels = set(item['labels'])
        if labels & ROLES != {'ready-for-agent'} or labels & {'backlog:human', 'tracker:gate', 'tracker:paused'}:
            raise TrackerError('Task is not ready for autonomous delivery')
        if item.get('children') or unfinished(item.get('blockers', [])):
            raise TrackerError('Task has children or unresolved blockers')
        if not state and (item['assignees'] or any(p['state'] == 'OPEN' for p in item['prs'])):
            raise TrackerError('Legacy assigned/PR work needs owner adoption; it is not free')
        if state and state['phase'] == 'released' and any(p['state'] == 'OPEN' for p in item['prs']):
            raise TrackerError('Existing PR requires an explicit owner handoff before another writer')
        if not re.fullmatch(r'(feat|fix|docs|chore|research|prototype)/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}', branch):
            raise TrackerError('Provide the task branch, without local paths or credentials')
        if held and branch != state['branch']:
            raise TrackerError('Active session branch cannot be changed implicitly')
        phase = 'active'
    else:
        if not held or state['session'] != session:
            raise TrackerError('Command requires ownership of the active session')
        if not reason.strip():
            raise TrackerError('block, handoff and release require a reason or verification summary')
        branch = state['branch']
        phase = {'block': 'blocked', 'handoff': 'review', 'release': 'released'}[command]
        if command == 'handoff' and not any(p['state'] == 'OPEN' and not p['isDraft']
                and p.get('headRefName') == branch and p.get('repository', {}).get('nameWithOwner') == item['repo']
                for p in item['prs']):
            raise TrackerError('Review handoff requires a linked open non-draft PR')
    return dict(session=session, request=request, command=command, phase=phase, branch=branch, reason=reason.strip(),
                updated_at=datetime.now(timezone.utc).isoformat())


def operate(api, repo, number, command, session, branch, reason, request):
    item = snapshot(api, repo, number)
    state, comment_id = read_session(api, repo, number)
    desired = transition(item, state, command, session, branch, reason, request)
    if desired != state:
        if snapshot(api, repo, number) != item or read_session(api, repo, number)[0] != state:
            raise TrackerError('Task or claim changed before command; retry from current facts')
        payload = {'body': MARKER + '\n' + json.dumps(desired, ensure_ascii=False, sort_keys=True)}
        try:
            if comment_id:
                api.call(f'repos/{repo}/issues/comments/{comment_id}', payload, 'PATCH')
            else:
                api.call(f'repos/{repo}/issues/{number}/comments', payload, 'POST')
        except TrackerError:
            # A timeout may follow a successful remote write. Read the request receipt first.
            actual, _ = read_session(api, repo, number)
            if actual != desired:
                raise
        actual, _ = read_session(api, repo, number)
        if actual != desired:
            raise TrackerError('Session read-back does not match; do not start work')
    if command == 'start' and WRITER not in item['assignees']:
        api.call(f'repos/{repo}/issues/{number}', {'assignees': item['assignees'] + [WRITER]}, 'PATCH')
        if WRITER not in [u['login'] for u in api.call(f'repos/{repo}/issues/{number}')['assignees']]:
            raise TrackerError('Assignee read-back failed; session retained for recovery')
    return dict(ok=True, issue=f'{repo}#{number}', **desired)


def worker():
    if (os.environ.get('GITHUB_REPOSITORY') != CONTROLLER or
            os.environ.get('GITHUB_WORKFLOW') != 'Inside agent sessions' or
            os.environ.get('GITHUB_REF') != 'refs/heads/main'):
        raise TrackerError('Session writes require the serialized default-branch Workspace workflow')
    api = GitHub()
    if api.call('user')['login'] != WRITER:
        raise TrackerError('Unexpected credential owner; migrate trusted state writer explicitly')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    value = event['inputs']
    original = {k: v for k, v in value.items() if k != 'fingerprint'}
    if value.get('fingerprint') != fingerprint(original):
        raise TrackerError('Dispatch operation fingerprint does not match')
    repo, number = identity(value['issue'])
    result = operate(api, repo, number, value['command'], value['session'], value.get('branch', ''),
                     value.get('reason', ''), value['request'])
    # A successful command includes its projection; failed projection retains the claim for retry.
    Reconciler(api, apply=True).one(repo, number, allow_add=True)
    Path('tracker-session-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


def request_command(args):
    api = GitHub()
    repo, number = identity(args.issue)
    request_id = args.request or uuid.uuid4().hex
    values = dict(command=args.command, issue=f'{repo}#{number}', session=args.session,
                  branch=args.branch, reason=args.reason.strip(), request=request_id)
    if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', request_id):
        raise TrackerError('invalid request identifier')
    operation_hash = fingerprint(values)
    expected_title = f'session {request_id} {operation_hash}'
    endpoint = f'repos/{CONTROLLER}/actions/workflows/{SESSION_WORKFLOW}/runs?per_page=100'

    def find_run():
        matches, scanned, total = [], 0, None
        for page in range(1, 10001):
            response = api.call(f'{endpoint}&page={page}')
            runs = response['workflow_runs']
            if total is None:
                total = response['total_count']
            scanned += len(runs)
            matches.extend(x for x in runs if x['display_title'].startswith(f'session {request_id} '))
            if len(runs) < 100:
                if scanned < total:
                    raise TrackerError('Incomplete request history; refusing a duplicate dispatch')
                break
        else:
            raise TrackerError('Incomplete request history; refusing a duplicate dispatch')
        if len(matches) > 1:
            raise TrackerError('Duplicate dispatch runs; inspect central state before retrying')
        run = matches[0] if matches else None
        if run and run['display_title'] != expected_title:
            raise TrackerError('Request ID already belongs to another operation')
        return run

    run, minimum_attempt = find_run(), 1
    if run and run['status'] == 'completed' and run['conclusion'] != 'success':
        # --request is an explicit retry of these exact inputs, including a partial prior write.
        minimum_attempt = run['run_attempt'] + 1
        api.call(f"repos/{CONTROLLER}/actions/runs/{run['id']}/rerun", {}, 'POST')
    elif not run:
        try:
            api.call(f'repos/{CONTROLLER}/actions/workflows/{SESSION_WORKFLOW}/dispatches',
                     {'ref': 'main', 'inputs': values | {'fingerprint': operation_hash}}, 'POST')
        except TrackerError as error:
            print(f'Dispatch response unavailable ({error}); checking request {request_id}.', flush=True)
    print(f'Request {request_id}: waiting for central confirmation. Do not start work yet.', flush=True)
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        run = find_run()
        if run and run['run_attempt'] >= minimum_attempt and run['status'] == 'completed':
            if run['conclusion'] != 'success':
                raise TrackerError(f"Command {run['conclusion']}: {run['html_url']}; no grant to start work")
            break
        time.sleep(3)
    else:
        raise TrackerError(f'Request {request_id} timed out; it may still execute. Do not start or steal the task.')
    with tempfile.TemporaryDirectory(prefix='inside-session-receipt-') as temp:
        subprocess.run(['gh', 'run', 'download', str(run['id']), '-R', CONTROLLER,
                        '--name', 'tracker-session-result', '--dir', temp], check=True)
        result = json.loads((Path(temp) / 'tracker-session-result.json').read_text())
    state = {k: v for k, v in result.items() if k not in {'ok', 'issue'}}
    try:
        validate_state(state)
    except (ValueError, TypeError, KeyError) as error:
        raise TrackerError('Invalid receipt state') from error
    if (result.get('ok') is not True or result.get('issue') != values['issue'] or
            any(state[k] != values[k] for k in ('command', 'session', 'request', 'reason')) or
            args.command == 'start' and state['branch'] != args.branch):
        raise TrackerError('Receipt does not match this operation')
    actual, _ = read_session(api, repo, number)
    if actual != state:
        raise TrackerError('Receipt has been superseded; reread state before starting')
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['start', 'block', 'handoff', 'release', 'worker'])
    parser.add_argument('--issue')
    parser.add_argument('--session')
    parser.add_argument('--branch', default='')
    parser.add_argument('--reason', default='')
    parser.add_argument('--request', help='Reuse the identifier only when recovering the same operation')
    parser.add_argument('--timeout', type=int, default=600)
    args = parser.parse_args()
    if args.command == 'worker':
        worker()
    elif not args.issue or not args.session:
        parser.error('--issue and --session are required')
    else:
        request_command(args)


if __name__ == '__main__':
    try:
        main()
    except (TrackerError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f'Session command failed: {error}', file=sys.stderr)
        sys.exit(1)
