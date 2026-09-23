#!/usr/bin/env bash
#
# The one command. Run it before claiming anything is done.
#
#     ./scripts/verify.sh            everything
#     ./scripts/verify.sh --fast     skip the layout check (slow) for a tight TDD loop
#
# Steps whose tooling does not exist yet are SKIPPED rather than failed, so this
# is useful from the first commit of M0 and tightens as the build lands. A SKIP
# is not a pass; the summary counts them separately and says so.
#
# On a clean checkout this exits non-zero, because the traceability gate has
# nothing claiming M0's requirements. That red list is the starting to-do list.
# See docs/plan/BUILD-PROTOCOL.md section 1.

set -u -o pipefail

cd "$(dirname "$0")/.."

FAST=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[1m'; X=$'\033[0m'
else
  R=""; G=""; Y=""; B=""; X=""
fi

PASSED=0; SKIPPED=0; FAILED=0
FAILED_NAMES=()
SKIPPED_NAMES=()

# run <name> <command...>
run() {
  local name="$1"; shift
  printf '%s\n' "${B}── ${name}${X}"
  if "$@"; then
    PASSED=$((PASSED + 1))
    printf '%s\n\n' "   ${G}PASS${X}  ${name}"
  else
    FAILED=$((FAILED + 1)); FAILED_NAMES+=("$name")
    printf '%s\n\n' "   ${R}FAIL${X}  ${name}"
  fi
}

skip() {
  SKIPPED=$((SKIPPED + 1)); SKIPPED_NAMES+=("$1 — $2")
  printf '%s\n\n' "${B}── $1${X}
   ${Y}SKIP${X}  $2"
}

have() { command -v "$1" >/dev/null 2>&1; }

# True when package.json defines the named npm script.
npm_script() {
  [ -f package.json ] || return 1
  node -e "process.exit((require('./package.json').scripts||{})['$1']?0:1)" 2>/dev/null
}

# node_step <label> <npm script name> <reason if absent>
node_step() {
  local label="$1" script="$2"
  if ! have node; then skip "$label" "Node is not installed"; return; fi
  if [ ! -f package.json ]; then skip "$label" "no package.json yet; M0 creates it"; return; fi
  # Without this the step fails with "eslint: not found", which reads as a lint
  # error rather than as an uninstalled tree.
  if [ ! -d node_modules ]; then skip "$label" "dependencies are not installed; run npm ci"; return; fi
  if ! npm_script "$script"; then skip "$label" "package.json defines no \"$script\" script"; return; fi
  run "$label" npm run --silent "$script"
}

printf '%s\n\n' "${B}PractixOS verification${X}"

# --------------------------------------------------------------------------- #
# Production code — skipped until M0 creates it
# --------------------------------------------------------------------------- #
node_step "Lint"       lint
node_step "Typecheck"  typecheck
node_step "Unit tests" test

# The four verification gates of specification section 10.1. These run against a
# real PostgreSQL container; a mocked database here is worse than no gate.
if ! have docker; then
  skip "Verification gates (spec 10.1)" "Docker is not installed; the gates need real PostgreSQL"
else
  node_step "Verification gates (spec 10.1)" test:gates
fi

# --------------------------------------------------------------------------- #
# The prototype — reference behaviour, already built
# --------------------------------------------------------------------------- #
if have node; then
  run "Prototype logic harness" node prototype/harness.js
else
  skip "Prototype logic harness" "Node is not installed"
fi

if [ "$FAST" -eq 1 ]; then
  skip "Layout integrity, prototype (spec 8.2)" "--fast was passed"
  skip "Layout integrity, client (spec 8.2, 6.6)" "--fast was passed"
elif ! have python3; then
  skip "Layout integrity, prototype (spec 8.2)" "Python 3 is not installed"
  skip "Layout integrity, client (spec 8.2, 6.6)" "Python 3 is not installed"
else
  # Both checks exit 0 with a notice of their own when Chrome is absent.
  run "Layout integrity, prototype (spec 8.2)" python3 prototype/check-layout.py
  # The prototype check reads a file the build never touches, so on its own it
  # is green regardless of what the product looks like. This is the one that
  # measures the product.
  if [ -d web ] && [ ! -d web/dist ]; then
    skip "Layout integrity, client (spec 8.2, 6.6)" "no web/dist; run: npm --prefix web run build"
  else
    run "Layout integrity, client (spec 8.2, 6.6)" python3 scripts/check-client-layout.py
  fi
fi

# --------------------------------------------------------------------------- #
# Spec-driven development gate — always last, so its list is what you read
# --------------------------------------------------------------------------- #
if have python3; then
  run "Requirement traceability" python3 scripts/trace.py
else
  skip "Requirement traceability" "Python 3 is not installed"
fi

# --------------------------------------------------------------------------- #
printf '%s\n' "${B}────────────────────────────────────────${X}"
printf '%s\n' "  ${G}${PASSED} passed${X}   ${Y}${SKIPPED} skipped${X}   ${R}${FAILED} failed${X}"

if [ "$SKIPPED" -gt 0 ]; then
  printf '\n%s\n' "  Skipped is not passed:"
  for s in "${SKIPPED_NAMES[@]}"; do printf '%s\n' "    ${Y}·${X} $s"; done
fi

if [ "$FAILED" -gt 0 ]; then
  printf '\n%s\n' "  ${R}Failed:${X}"
  for f in "${FAILED_NAMES[@]}"; do printf '%s\n' "    ${R}·${X} $f"; done
  printf '\n%s\n' "  Not done. Do not weaken a check to clear this — see AGENTS.md section 6."
  exit 1
fi

printf '\n%s\n' "  All executed checks green."
exit 0
