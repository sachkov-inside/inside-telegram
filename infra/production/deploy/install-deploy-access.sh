#!/usr/bin/env bash
# One-time (repeatable) installation of the restricted Telegram deployment access on the VPS.
# Usage, as root from a checkout of the merged commit:
#   bash infra/production/deploy/install-deploy-access.sh <ed25519-public-key-file>
set -euo pipefail

if [[ $# -ne 1 || ! -r "$1" ]]; then
  echo "usage: install-deploy-access.sh <ed25519-public-key-file>" >&2
  exit 1
fi

if [[ -n "${INSIDE_TELEGRAM_DEPLOY_TEST_ROOT:-}" ]]; then
  if [[ "$EUID" -eq 0 ]]; then
    echo "Test root is forbidden for a root process" >&2
    exit 1
  fi
  host_root="${INSIDE_TELEGRAM_DEPLOY_TEST_ROOT%/}"
else
  if [[ "$EUID" -ne 0 ]]; then
    echo "Run this script as root" >&2
    exit 1
  fi
  host_root=""
fi

readonly user=inside-telegram-deploy
readonly gateway_path=/usr/local/libexec/inside/inside-telegram-deploy
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
public_key_file="$1"

if [[ "$(wc -l <"$public_key_file" | tr -d ' ')" -ne 1 ]] ||
   ! ssh-keygen -l -f "$public_key_file" >/dev/null 2>&1 ||
   [[ "$(awk '{print $1}' "$public_key_file")" != ssh-ed25519 ]]; then
  echo "Expected exactly one valid ssh-ed25519 public key" >&2
  exit 1
fi
key_body="$(awk '{print $2}' "$public_key_file")"

for tool in curl docker flock gzip jq sudo tar visudo; do
  if [[ -z "${INSIDE_TELEGRAM_DEPLOY_TEST_ROOT:-}" ]] && ! command -v "$tool" >/dev/null; then
    echo "Required tool is missing: $tool" >&2
    exit 1
  fi
done
if [[ -z "${INSIDE_TELEGRAM_DEPLOY_TEST_ROOT:-}" ]] && ! docker compose version >/dev/null; then
  echo "Docker Compose v2 is required" >&2
  exit 1
fi

if [[ -z "${INSIDE_TELEGRAM_DEPLOY_TEST_ROOT:-}" ]] && ! id "$user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --user-group "$user"
fi
if [[ -z "${INSIDE_TELEGRAM_DEPLOY_TEST_ROOT:-}" ]]; then
  passwd --lock "$user" >/dev/null
fi

install -d -m 755 "$host_root/usr/local/libexec/inside"
install -m 755 "$script_dir/inside-telegram-deploy" "$host_root$gateway_path"
install -d -m 755 "$host_root/srv/inside/telegram/releases"
install -d -m 700 "$host_root/var/lib/inside/telegram-deployments"

sudoers="$host_root/etc/sudoers.d/inside-telegram-deploy"
install -d -m 755 "$(dirname "$sudoers")"
sudoers_temp="$(mktemp)"
printf '%s\n' \
  "Defaults:$user env_keep += \"SSH_ORIGINAL_COMMAND\"" \
  "$user ALL=(root) NOPASSWD: $gateway_path" \
  >"$sudoers_temp"
chmod 440 "$sudoers_temp"
if [[ -z "${INSIDE_TELEGRAM_DEPLOY_TEST_ROOT:-}" ]]; then
  visudo --check --file "$sudoers_temp" >/dev/null
fi
install -m 440 "$sudoers_temp" "$sudoers"
rm "$sudoers_temp"

ssh_dir="$host_root/home/$user/.ssh"
install -d -m 700 "$ssh_dir"
authorized_keys="$ssh_dir/authorized_keys"
temporary="$authorized_keys.tmp.$$"
printf 'restrict,command="sudo -n %s" ssh-ed25519 %s\n' "$gateway_path" "$key_body" >"$temporary"
chmod 600 "$temporary"
mv "$temporary" "$authorized_keys"
if [[ -z "${INSIDE_TELEGRAM_DEPLOY_TEST_ROOT:-}" ]]; then
  chown -R "$user:$user" "$ssh_dir"
fi

echo "Restricted $user access installed: $gateway_path"
