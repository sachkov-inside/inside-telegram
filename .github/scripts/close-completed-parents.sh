#!/usr/bin/env bash
set -euo pipefail
: "${REPOSITORY:?REPOSITORY must be owner/repository}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER must be the closed issue number}"
# Compatibility entry point: aggregate closure is now an explicit, central policy.
# Existing callers may request a report, but must not bypass the controller's gates.
python3 "$(dirname "$0")/inside_tracker.py" --issue "$REPOSITORY#$ISSUE_NUMBER"
