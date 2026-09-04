#!/usr/bin/env bash
#
# January Token Relay — one-command local setup.
#
#   ./start.sh
#
# Checks Node.js, asks for your January API key, saves it to .env, and starts
# the relay. Run it again any time: with a complete .env it just starts the
# relay, exactly like `npm start`.
#
# A relay token is only needed when other devices can reach the relay
# (HOST=0.0.0.0 for a physical phone); the script generates one then.
#
# Without a terminal (CI, scripts):  JANUARY_API_KEY=sk-… ./start.sh

set -euo pipefail
cd "$(dirname "$0")"

# ——— presentation ————————————————————————————————————————————————————————————

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && command -v tput >/dev/null 2>&1 &&
  [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD="$(tput bold)" GREEN="$(tput setaf 2)" RED="$(tput setaf 1)" RESET="$(tput sgr0)"
  DIM="$(tput dim 2>/dev/null || true)"
else
  BOLD='' GREEN='' RED='' DIM='' RESET=''
fi

heading() { printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
fail() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2; }

# Clickable in terminals that support hyperlinks; the plain URL everywhere else.
link() {
  if [ -t 1 ]; then printf '\033]8;;%s\033\\%s\033]8;;\033\\' "$1" "$1"; else printf '%s' "$1"; fi
}

# sk-abcd…wxyz — enough to recognise a key, never enough to use it.
mask() {
  if [ "${#1}" -lt 12 ]; then
    printf '••••'
  else
    printf '%s…%s' "${1:0:7}" "${1:$((${#1} - 4))}"
  fi
}

# ——— API key checks ——————————————————————————————————————————————————————————

# key_problem KEY — what is wrong with the shape of KEY, or nothing if it looks right.
# A January API key is "sk-" plus 43 URL-safe characters.
key_problem() {
  case "$1" in
    '') printf 'Nothing was entered.' ;;
    sk-*sk-*) printf 'That looks like the key pasted twice (%s characters; a key is 46). Paste it once.' "${#1}" ;;
    sk-*)
      case "${1#sk-}" in
        *[!A-Za-z0-9_-]*) printf 'That has characters a January API key never contains. Copy it again from the dashboard.' ;;
        *)
          if [ "${#1}" -lt 40 ] || [ "${#1}" -gt 64 ]; then
            printf 'That is %s characters; a January API key is 46 (sk- plus 43). Copy it again from the dashboard.' "${#1}"
          fi
          ;;
      esac
      ;;
    *) printf 'That does not look like a January API key — they start with sk-.' ;;
  esac
}

# check_key KEY — asks January (a free balance read): 0 accepted, 1 rejected,
# 2 issued for the other API version, 3 could not check right now.
check_key() {
  KEY_TO_CHECK="$1" node --input-type=module -e '
    import { checkApiKey } from "./lib/relay.js"
    const result = await checkApiKey({
      apiKey: process.env.KEY_TO_CHECK,
      baseUrl: process.env.JANUARY_BASE_URL || undefined,
    })
    process.exit(result.ok ? 0 : ({ rejected: 1, wrong_version: 2 })[result.reason] ?? 3)
  '
}

# ——— .env helpers ————————————————————————————————————————————————————————————

# env_value NAME — the value of the first NAME= line in .env, quotes removed.
env_value() {
  [ -f .env ] || return 0
  local line
  line="$(grep -m 1 "^$1=" .env || true)"
  [ -n "$line" ] || return 0
  line="${line#*=}"
  line="${line%\"}" line="${line#\"}" line="${line%\'}" line="${line#\'}"
  printf '%s' "$line"
}

# set_env_var NAME VALUE — replaces the NAME= line in .env, or appends one.
# Copies line by line so the value can hold any character safely.
set_env_var() {
  local name="$1" value="$2" tmp line replaced=0
  tmp="$(mktemp)"
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$replaced" -eq 0 ] && [[ "$line" == "$name="* ]]; then
      printf '%s=%s\n' "$name" "$value"
      replaced=1
    else
      printf '%s\n' "$line"
    fi
  done <.env >"$tmp"
  [ "$replaced" -eq 1 ] || printf '%s=%s\n' "$name" "$value" >>"$tmp"
  mv "$tmp" .env
}

# ——— 1. Node.js ——————————————————————————————————————————————————————————————

heading 'January Token Relay · local setup'

if ! command -v node >/dev/null 2>&1; then
  fail 'Node.js is not installed. Install Node 20.12 or newer from https://nodejs.org, then run ./start.sh again.'
  exit 1
fi
node_version="$(node -v)"
version="${node_version#v}"
major="${version%%.*}"
rest="${version#*.}"
minor="${rest%%.*}"
case "$major$minor" in
  '' | *[!0-9]*)
    fail "Could not read the Node.js version from \"$node_version\"."
    exit 1
    ;;
esac
if [ "$major" -lt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -lt 12 ]; }; then
  fail "Node.js $node_version is too old. Install Node 20.12 or newer from https://nodejs.org, then run ./start.sh again."
  exit 1
fi
ok "Node.js $node_version"

# ——— 2. API key ——————————————————————————————————————————————————————————————

key="${JANUARY_API_KEY:-}"
saved_key="$(env_value JANUARY_API_KEY)"
source_label=''
if [ -n "$key" ]; then
  source_label='the environment'
elif [ -n "$saved_key" ]; then
  key="$saved_key"
  source_label='.env'
fi

# A key we already have is used only if it still looks right and January still accepts it.
if [ -n "$key" ]; then
  problem="$(key_problem "$key")"
  if [ -n "$problem" ]; then
    fail "The API key in $source_label is not usable. $problem"
    key=''
  elif check_key "$key"; then
    ok "API key from $source_label ($(mask "$key")) — accepted by January"
  else
    case $? in
      1)
        fail "January rejected the API key in $source_label ($(mask "$key")). It may have been rotated or deleted."
        key=''
        ;;
      2)
        fail "The API key in $source_label ($(mask "$key")) is for the other API version; this relay needs a v1.2 key."
        key=''
        ;;
      *) ok "API key from $source_label ($(mask "$key")) — could not be checked with January right now" ;;
    esac
  fi
fi

if [ -z "$key" ]; then
  heading 'Your January API key'
  note "Create one in the Developer Dashboard:  $(link https://dashboard.january.ai)  →  API keys  →  Create key"
  note "Then enable client tokens (one toggle):  $(link https://dashboard.january.ai/dashboard/client-tokens)"
  note 'The key is saved to .env on this machine only. Your app never sees it.'
  printf '\n'
  attempts=0
  while [ -z "$key" ]; do
    printf '  Paste your API key (input is hidden): '
    input=''
    if ! IFS= read -r -s input; then
      printf '\n'
      if [ -z "$input" ]; then
        fail 'No API key was entered, and no terminal is attached to ask on.'
        note 'Pass it in instead: JANUARY_API_KEY=sk-… ./start.sh — or copy .env.example to .env and fill it in.' >&2
        exit 1
      fi
    fi
    printf '\n'
    input="$(printf '%s' "$input" | tr -d '[:space:]')"
    problem="$(key_problem "$input")"
    if [ -n "$problem" ]; then
      attempts=$((attempts + 1))
      fail "$problem (attempt $attempts of 3)"
      [ "$attempts" -lt 3 ] || exit 1
      continue
    fi
    if check_key "$input"; then
      key="$input"
      ok "API key accepted by January ($(mask "$key"))"
    else
      case $? in
        1)
          attempts=$((attempts + 1))
          fail "January rejected that key ($(mask "$input")). Copy it again from the dashboard, or create a new one. (attempt $attempts of 3)"
          [ "$attempts" -lt 3 ] || exit 1
          ;;
        2)
          attempts=$((attempts + 1))
          fail "That key is for the other API version; this relay needs a v1.2 key. (attempt $attempts of 3)"
          [ "$attempts" -lt 3 ] || exit 1
          ;;
        *)
          key="$input"
          ok "API key received ($(mask "$key")) — could not be checked with January right now"
          ;;
      esac
    fi
  done
fi

# ——— 3. Relay token — only when other devices can reach the relay ———————————

host="${HOST:-$(env_value HOST)}"
case "${host:-127.0.0.1}" in
  127.0.0.1 | localhost | ::1) reachable_by_others=0 ;;
  *) reachable_by_others=1 ;;
esac

# On a laptop nothing else can reach the relay, so no token is used or mentioned.
token=''
if [ "$reachable_by_others" -eq 1 ]; then
  saved_token="$(env_value RELAY_TOKEN)"
  token="${RELAY_TOKEN:-$saved_token}"
  if [ -n "$token" ]; then
    ok 'Relay token from .env'
  else
    token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
    ok "Relay token generated: with HOST=$host other devices can reach the relay, and the token keeps it yours"
  fi
fi

# ——— 4. Save ——————————————————————————————————————————————————————————————————

[ -f .env ] || cp .env.example .env
set_env_var JANUARY_API_KEY "$key"
if [ -n "$token" ]; then set_env_var RELAY_TOKEN "$token"; fi
chmod 600 .env
ok 'Saved to .env (readable only by you; git ignores it)'

if [ -n "$token" ]; then
  heading 'Your app’s relay token'
  printf '  %s\n' "$token"
  note 'Your app sends it as   Authorization: Bearer <relay token>   with every request to the relay.'
  note 'It lives in .env as RELAY_TOKEN — change it there any time.'
fi

# ——— 5. Run ——————————————————————————————————————————————————————————————————

printf '\n%sStarting the relay… Ctrl+C stops it; ./start.sh or npm start brings it back.%s\n\n' "$DIM" "$RESET"
exec node server.js
