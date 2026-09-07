#!/usr/bin/env python3
"""Reconcile GitHub facts into Inside Projects. Dry-run unless --apply is explicit."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from tracker_policy import decide, unfinished

ORG = 'sachkov-inside'
REPOSITORIES = ('workspace', 'platform', 'inside-telegram', 'inside-landing', 'inside-content', 'workshop-cases')
CONTROLLER = f'{ORG}/workspace'
WORKFLOW = 'add-to-inside-project.yml'
MARKER = '<!-- inside-tracker-session:v1 -->'


class TrackerError(Exception):
    pass


class GitHub:
    def call(self, endpoint, payload=None, method=None):
        """Retry reads and explicitly idempotent writes, never an unknown POST."""
        command = ['gh', 'api', endpoint]
        if payload is not None:
            command += ['--input', '-']
        if method:
            command += ['--method', method]
        safe = (not payload['query'].lstrip().startswith('mutation') if endpoint == 'graphql'
                else method in (None, 'GET', 'PATCH'))
        for attempt in range(3 if safe else 1):
            result = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                                    text=True, capture_output=True)
            if result.returncode == 0:
                value = json.loads(result.stdout) if result.stdout.strip() else None
                if isinstance(value, dict) and value.get('errors'):
                    raise TrackerError(json.dumps(value['errors']))
                return value
            temporary = bool(re.search(r'HTTP (429|5\d\d)|TLS|timeout|connection reset', result.stderr, re.I))
            if not temporary or not safe or attempt == 2:
                raise TrackerError(result.stderr.strip())
            time.sleep(2 ** attempt)
        raise TrackerError('GitHub request did not complete')

    def graphql(self, query, **variables):
        return self.call('graphql', {'query': query, 'variables': variables})['data']

    def pages(self, endpoint):
        values = []
        for page in range(1, 10001):
            separator = '&' if '?' in endpoint else '?'
            chunk = self.call(f'{endpoint}{separator}per_page=100&page={page}')
            if not isinstance(chunk, list):
                raise TrackerError(f'Expected paginated list: {endpoint}')
            values.extend(chunk)
            if len(chunk) < 100:
                return values
        raise TrackerError('Pagination limit exceeded')


def identity(value):
    match = re.fullmatch(r'(?:sachkov-inside/)?([a-z-]+)#([1-9][0-9]*)', value)
    if not match or match[1] not in REPOSITORIES:
        raise TrackerError('Expected an Inside repository#issue-number')
    return f'{ORG}/{match[1]}', int(match[2])


def connection(api, node_id, kind, field, selection, extra_args=''):
    nodes, cursor = [], None
    while True:
        data = api.graphql('''query($id:ID!, $cursor:String) { node(id:$id) { ... on ''' + kind + ''' {
          ''' + field + '''(first:100, after:$cursor''' + extra_args + ''') { nodes { ''' + selection + ''' }
          pageInfo { hasNextPage endCursor } } } } }''', id=node_id, cursor=cursor)['node'][field.split('(')[0]]
        nodes.extend(data['nodes'])
        if not data['pageInfo']['hasNextPage']:
            return nodes
        cursor = data['pageInfo']['endCursor']


def snapshot(api, repo, number):
    raw = api.call(f'repos/{repo}/issues/{number}')
    kind = 'PullRequest' if 'pull_request' in raw else 'Issue'
    result = dict(id=raw['node_id'], repo=repo, number=number, kind=kind,
                  state=raw['state'].upper(), labels=[x['name'] for x in raw['labels']],
                  assignees=[x['login'] for x in raw['assignees']], url=raw['html_url'],
                  updatedAt=raw['updated_at'], stateReason=(raw.get('state_reason') or '').upper())
    if kind == 'PullRequest':
        pr = api.call(f'repos/{repo}/pulls/{number}')
        result.update(state='MERGED' if pr['merged'] else pr['state'].upper(), draft=pr['draft'])
        return result
    result['children'] = connection(api, result['id'], kind, 'subIssues', 'id state stateReason')
    result['blockers'] = connection(api, result['id'], kind, 'blockedBy', 'id state stateReason')
    result['prs'] = connection(api, result['id'], kind, 'closedByPullRequestsReferences', 'id state isDraft headRefName repository { nameWithOwner }')
    return result


def project_data(api, number):
    data = api.graphql('''query($number:Int!) { organization(login:"sachkov-inside") {
      projectV2(number:$number) { id fields(first:100) { nodes { ... on ProjectV2SingleSelectField {
      id name options { id name } } } } } } }''', number=number)['organization']['projectV2']
    if not data:
        raise TrackerError(f'Cannot access project {number}')
    fields = {f['name']: f for f in data['fields']['nodes'] if f}
    required = {'Todo', 'In Progress', 'Done'} if number == 2 else {'Inbox', 'Ready', 'In progress', 'Review', 'Blocked', 'Done'}
    if 'Status' not in fields or not required <= {x['name'] for x in fields['Status']['options']}:
        raise TrackerError(f'Project {number} Status schema does not match the contract')
    return dict(id=data['id'], fields=fields)


def project_items(api, project_id):
    nodes, cursor = [], None
    while True:
        page = api.graphql('''query($id:ID!, $cursor:String) { node(id:$id) { ... on ProjectV2 {
          items(first:100, after:$cursor) { nodes { id isArchived
            content { __typename ... on Issue { id number state repository { nameWithOwner } }
            ... on PullRequest { id number state repository { nameWithOwner } } }
            fieldValues(first:100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue {
              name field { ... on ProjectV2SingleSelectField { name } } } } }
          } pageInfo { hasNextPage endCursor } } } } }''', id=project_id, cursor=cursor)['node']['items']
        nodes.extend(page['nodes'])
        if not page['pageInfo']['hasNextPage']:
            return nodes
        cursor = page['pageInfo']['endCursor']


def field_values(item):
    return {v['field']['name']: v['name'] for v in item['fieldValues']['nodes'] if v}


def set_field(api, project, item_id, name, value):
    field = project['fields'].get(name)
    option = next((x for x in field['options'] if x['name'] == value), None) if field else None
    if not option:
        raise TrackerError(f'Cannot preserve {name}={value} in target project')
    api.graphql('''mutation($project:ID!,$item:ID!,$field:ID!,$option:String!) {
      updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,
      value:{singleSelectOptionId:$option}}) { projectV2Item { id } } }''',
      project=project['id'], item=item_id, field=field['id'], option=option['id'])


def report(action, item, reason, **details):
    row = dict(action=action, issue=f"{item['repo']}#{item['number']}", reason=reason, **details)
    print(json.dumps(row, ensure_ascii=False), flush=True)
    return row


class Reconciler:
    def __init__(self, api, apply=False, close_parents=False):
        self.api, self.apply, self.close_parents = api, apply, close_parents
        self.projects = {n: project_data(api, n) for n in (1, 2)}
        self.refresh()

    def refresh(self):
        self.cards = {}
        for n, project in self.projects.items():
            for card in project_items(self.api, project['id']):
                content = card.get('content')
                if content and content.get('repository'):
                    key = (content['repository']['nameWithOwner'], content['number'])
                    self.cards.setdefault(key, {})[n] = card

    def item_cards(self, item):
        # Project.items is an eventually consistent discovery index. Read the
        # owning content's connection for decisions and mutation verification.
        values = connection(self.api, item['id'], item['kind'], 'projectItems',
            '''id isArchived project { id }
            fieldValues(first:100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue {
              name field { ... on ProjectV2SingleSelectField { name } } } } }''',
            extra_args=', includeArchived:true')
        numbers = {project['id']: number for number, project in self.projects.items()}
        return {numbers[card['project']['id']]: card for card in values
                if (card.get('project') or {}).get('id') in numbers}

    def one(self, repo, number, allow_add=False):
        item = snapshot(self.api, repo, number)
        cards = self.item_cards(item)
        if any(c['isArchived'] for c in cards.values()):
            return report('skip', item, 'preserve intentional archive')
                # The session module is installed by the session-operations release.
        try:
            from tracker_sessions import read_session
        except ModuleNotFoundError as error:
            if error.name != 'tracker_sessions':
                raise
        else:
            if item['kind'] == 'Issue':
                item['session'] = read_session(self.api, repo, number)[0]
        if 'backlog:human' in item['labels'] and repo != CONTROLLER:
            raise TrackerError('backlog:human is valid only in Workspace')
        if item['state'] == 'CLOSED' and unfinished(item.get('children', [])):
            report('warning', item, 'closed aggregate has unfinished children; owner must reopen or replan')
        desired_project = 2 if 'backlog:human' in item['labels'] else 1
        current_card = cards.get(desired_project)
        current = field_values(current_card).get('Status') if current_card else None
        decision = decide(item, current)
        if not cards and not allow_add and (item['state'] != 'OPEN' or 'needs-info' in item['labels']):
            return report('skip', item, 'untracked terminal/deferred work; no implicit restoration')
        if decision.status is None and not decision.archive:
            return report('skip', item, decision.reason)
        if decision.close and not self.close_parents:
            return report('candidate', item, 'aggregate closure belongs to central sweep')
        changes = []
        if decision.close:
            changes.append('close')
        if decision.archive:
            changes += ['archive'] if cards else []
        else:
            if not current_card:
                changes.append('add')
            if len(cards) > 1 or cards and not current_card:
                changes.append('route')
            if current != decision.status:
                changes.append('status')
        if not changes:
            return report('unchanged', item, decision.reason)
        row = report('apply' if self.apply else 'plan', item, decision.reason,
                     changes=changes, project=decision.project, status=decision.status)
        if not self.apply:
            return row
        # Fresh facts before the mutation; a concurrent edit invalidates this plan.
        fresh = snapshot(self.api, repo, number)
        if self.item_cards(fresh) != cards:
            raise TrackerError(f'{repo}#{number}: Project changed during reconciliation; rerun')
        if 'session' in item:
            fresh['session'] = read_session(self.api, repo, number)[0]
        if fresh != item:
            raise TrackerError(f'{repo}#{number} changed during reconciliation; retry from current state')
        if decision.close:
            self.api.call(f'repos/{repo}/issues/{number}', {'state': 'closed', 'state_reason': 'completed'}, 'PATCH')
        project = self.projects[decision.project]
        # Area describes engineering ownership; Human Backlog has no Area. Keep it
        # in the transition journal instead of inventing a Human field or failing mid-route.
        for p, card in cards.items():
            if p != decision.project:
                report('route-fields', item, 'source fields before classification repair',
                       fields=field_values(card))
        if decision.archive:
            for p, card in cards.items():
                self.api.graphql('''mutation($project:ID!,$item:ID!) {
                  archiveProjectV2Item(input:{projectId:$project,itemId:$item}) { item { id } } }''',
                  project=self.projects[p]['id'], item=card['id'])
        else:
            expected_fields = field_values(current_card) if current_card else {}
            for p, card in cards.items():
                if p != decision.project:
                    for name, value in field_values(card).items():
                        if name in {'Priority', 'Area'} and name in project['fields']:
                            expected_fields.setdefault(name, value)
            if not current_card:
                # addProjectV2ItemById converges on the existing content item on retry.
                value = self.api.graphql('''mutation($project:ID!,$content:ID!) {
                  addProjectV2ItemById(input:{projectId:$project,contentId:$content}) { item { id } } }''',
                  project=project['id'], content=item['id'])
                current_card = {'id': value['addProjectV2ItemById']['item']['id']}
            for name, value in expected_fields.items():
                if name in {'Priority', 'Area'}:
                    set_field(self.api, project, current_card['id'], name, value)
            set_field(self.api, project, current_card['id'], 'Status', decision.status)
            for p, card in cards.items():
                if p != decision.project:
                    self.api.graphql('''mutation($project:ID!,$item:ID!) {
                      deleteProjectV2Item(input:{projectId:$project,itemId:$item}) { deletedItemId } }''',
                      project=self.projects[p]['id'], item=card['id'])
        after = self.item_cards(item)
        if decision.archive:
            verified = set(after) == set(cards) and all(c['isArchived'] for c in after.values())
        else:
            verified = (set(after) == {decision.project} and
                        not after[decision.project]['isArchived'] and
                        field_values(after[decision.project]).get('Status') == decision.status and
                        all(field_values(after[decision.project]).get(k) == v for k, v in expected_fields.items()
                            if k in {'Priority', 'Area'}))
        if decision.close:
            verified = verified and self.api.call(f'repos/{repo}/issues/{number}')['state'] == 'closed'
        if not verified:
            raise TrackerError(f'{repo}#{number}: read-back disagrees with desired state')
        return row

    def sweep(self, repos):
        targets = {key for key, cards in self.cards.items() if key[0] in repos and
                   not any(c['isArchived'] for c in cards.values()) and
                   any(field_values(c).get('Status') != 'Done' or c['content']['state'] == 'OPEN'
                       or (c['content']['__typename'] == 'PullRequest' and c['content']['state'] == 'CLOSED')
                       for c in cards.values())}
        for repo in repos:
            info = self.api.call(f'repos/{repo}')
            endpoint = 'issues' if info['has_issues'] else 'pulls'
            targets.update((repo, x['number']) for x in self.api.pages(f'repos/{repo}/{endpoint}?state=open'))
        failures = []
        for repo, number in sorted(targets):
            try:
                self.one(repo, number)
            except TrackerError as error:
                failures.append(f'{repo}#{number}: {error}')
                print(json.dumps(dict(action='error', issue=f'{repo}#{number}', reason=str(error))), flush=True)
        if failures:
            raise TrackerError(f'{len(failures)} items failed; see per-item report')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--issue', help='repository#number, also accepts a PR number')
    parser.add_argument('--repository', choices=REPOSITORIES)
    parser.add_argument('--allow-add', action='store_true', help='Explicit intake; never inferred from ordinary events')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--close-parents', action='store_true')
    args = parser.parse_args()
    if args.close_parents and args.apply and os.environ.get('GITHUB_REPOSITORY') != CONTROLLER:
        raise TrackerError('Automatic parent closure runs only in the central Workspace workflow')
    runner = Reconciler(GitHub(), args.apply, args.close_parents)
    if args.issue:
        runner.one(*identity(args.issue), allow_add=args.allow_add)
    else:
        repos = [f'{ORG}/{args.repository}'] if args.repository else [f'{ORG}/{r}' for r in REPOSITORIES]
        runner.sweep(repos)


if __name__ == '__main__':
    # Session adapter imports this module; keep one error type when run as a script.
    sys.modules.setdefault('inside_tracker', sys.modules[__name__])
    try:
        main()
    except (TrackerError, KeyError, ValueError) as error:
        print(f'Tracker failed: {error}', file=sys.stderr)
        sys.exit(1)
