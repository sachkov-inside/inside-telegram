#!/usr/bin/env python3
"""Translate a trusted GitHub event into a bounded reconciliation command."""
import json
import os
import subprocess
import sys
from pathlib import Path

from inside_tracker import CONTROLLER, REPOSITORIES, TrackerError, identity


def arguments(event_name, event, repository, enabled, requested_apply=False, requested_issue=''):
    if repository not in {f'sachkov-inside/{r}' for r in REPOSITORIES}:
        raise TrackerError('Repository is not part of Inside')
    args = []
    if event_name == 'workflow_dispatch':
        if requested_issue:
            target_repo, _ = identity(requested_issue)
            if repository != CONTROLLER and target_repo != repository:
                raise TrackerError('Only Workspace can reconcile another repository')
            args += ['--issue', requested_issue, '--allow-add']
        elif repository != CONTROLLER:
            args += ['--repository', repository.split('/')[1]]
        if requested_apply:
            args += ['--apply']
    elif event_name == 'schedule':
        if repository != CONTROLLER:
            raise TrackerError('Only Workspace runs the organization sweep')
        if enabled:
            args += ['--apply']
    elif event_name in {'issues', 'pull_request_target'}:
        item = event['issue' if event_name == 'issues' else 'pull_request']
        args += ['--issue', f"{repository}#{int(item['number'])}"]
        if enabled:
            args += ['--apply']
    else:
        raise TrackerError('Unsupported tracker event')
    if repository == CONTROLLER and event_name in {'schedule', 'workflow_dispatch'}:
        args += ['--close-parents']
    return args


if __name__ == '__main__':
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    args = arguments(os.environ['GITHUB_EVENT_NAME'], event, os.environ['GITHUB_REPOSITORY'],
                     os.environ.get('TRACKER_ENABLED') == 'true',
                     os.environ.get('TRACKER_APPLY') == 'true', os.environ.get('TRACKER_ISSUE', ''))
    raise SystemExit(subprocess.call([sys.executable, str(Path(__file__).with_name('inside_tracker.py')), *args]))
