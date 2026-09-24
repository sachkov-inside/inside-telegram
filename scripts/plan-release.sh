#!/usr/bin/env bash
# Plans one ordinal release: immutable releases enabled, next vN, captured SHA is current main.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${RELEASE_SETTINGS_READ_TOKEN:?RELEASE_SETTINGS_READ_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${REQUESTED_VERSION:?REQUESTED_VERSION is required}"
: "${SOURCE_SHA:?SOURCE_SHA is required}"

# Reading this setting needs Administration: read, which GITHUB_TOKEN cannot request.
# The settings credential is not inherited by the remaining commands.
settings_token="$RELEASE_SETTINGS_READ_TOKEN"
unset RELEASE_SETTINGS_READ_TOKEN
immutable_enabled="$(
  GH_TOKEN="$settings_token" gh api \
    "repos/${GITHUB_REPOSITORY}/immutable-releases" --jq .enabled
)"
unset settings_token
if [[ "$immutable_enabled" != "true" ]]; then
  echo "Enable immutable releases in the repository settings before publishing." >&2
  exit 1
fi

current_main_sha="$(
  gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq .object.sha
)"
existing_tags="$(
  gh api --paginate --slurp "repos/${GITHUB_REPOSITORY}/tags?per_page=100" |
    jq '[.[][] | .name]'
)"
existing_releases="$(
  gh api --paginate --slurp "repos/${GITHUB_REPOSITORY}/releases?per_page=100" |
    jq '[.[][] | select(.draft == false) | {
      version: .tag_name,
      immutable,
      assets: [.assets[].name]
    }]'
)"

jq --null-input \
  --arg requestedVersion "$REQUESTED_VERSION" \
  --arg sourceSha "$SOURCE_SHA" \
  --arg currentMainSha "$current_main_sha" \
  --argjson existingTags "$existing_tags" \
  --argjson existingReleases "$existing_releases" \
  '{
    requestedVersion: $requestedVersion,
    sourceSha: $sourceSha,
    currentMainSha: $currentMainSha,
    existingTags: $existingTags,
    existingReleases: $existingReleases
  }' |
  node scripts/release-contract.mjs plan
