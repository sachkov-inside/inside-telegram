#!/usr/bin/env bash
set -euo pipefail

: "${REPOSITORY:?REPOSITORY must be owner/repository}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER must be the closed issue number}"

current_repository="$REPOSITORY"
current_issue="$ISSUE_NUMBER"

while true; do
  owner="${current_repository%%/*}"
  repository_name="${current_repository#*/}"

  parent_json="$(
    # GraphQL variables must reach GitHub unchanged.
    # shellcheck disable=SC2016
    gh api graphql \
      -f query='query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            parent {
              number
              state
              repository { nameWithOwner }
            }
          }
        }
      }' \
      -F owner="$owner" \
      -F repo="$repository_name" \
      -F number="$current_issue"
  )"

  parent_repository="$(
    jq -r '.data.repository.issue.parent.repository.nameWithOwner // empty' <<<"$parent_json"
  )"
  if [[ -z "$parent_repository" ]]; then
    exit 0
  fi

  parent_issue="$(jq -r '.data.repository.issue.parent.number' <<<"$parent_json")"
  parent_state="$(jq -r '.data.repository.issue.parent.state' <<<"$parent_json")"
  children_json="$(
    gh api --paginate --slurp \
      "repos/$parent_repository/issues/$parent_issue/sub_issues?per_page=100"
  )"

  child_count="$(jq '[.[][]] | length' <<<"$children_json")"
  incomplete_count="$(
    jq '[.[][] | select(.state != "closed" or .state_reason != "completed")] | length' \
      <<<"$children_json"
  )"

  if [[ "$child_count" -eq 0 || "$incomplete_count" -ne 0 ]]; then
    exit 0
  fi

  if [[ "$parent_state" == "OPEN" ]]; then
    gh api --method PATCH \
      "repos/$parent_repository/issues/$parent_issue" \
      -f state=closed \
      -f state_reason=completed \
      --silent
  fi

  current_repository="$parent_repository"
  current_issue="$parent_issue"
done
