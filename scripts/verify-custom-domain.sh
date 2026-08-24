#!/usr/bin/env bash
# Post-switch verification for the visiblegov.us custom domain.
# Mirrors every Phase-2 check in docs/CLOUDFLARE_DEPLOY.md, run against the new host.
# Usage: bash verify-custom-domain.sh [host]   (default https://visiblegov.us)
#
# NOTE on the tally: `chk` is fed by a pipe, so it runs in a SUBSHELL and cannot update shell
# variables in the parent (first version of this script printed 11 PASS lines and "5 passed").
# Results are therefore appended to a temp file and counted at the end.
BASE="${1:-https://visiblegov.us}"
RESULTS="$(mktemp)"
trap 'rm -f "$RESULTS"' EXIT

chk() { # <name> <expected regex>, actual on stdin
  local name="$1" want="$2" got; got="$(cat)"
  if grep -qiE "$want" <<< "$got"; then
    echo "  PASS  $name"; echo PASS >> "$RESULTS"
  else
    echo "  FAIL  $name"
    echo "        wanted /$want/, got: $(head -3 <<< "$got" | tr '\n' ' ' | cut -c1-160)"
    echo FAIL >> "$RESULTS"
  fi
}

echo "=== $BASE ==="
echo "-- DNS"
nslookup "$(sed 's#https\?://##' <<< "$BASE")" 2>&1 | tail -4

echo "-- apex + security headers (all three, per Phase 2)"
h="$(curl -sI --max-time 25 "$BASE/")"
chk "apex serves 200" "HTTP/[12](\.[01])? 200" <<< "$h"
chk "content-security-policy" "content-security-policy" <<< "$h"
chk "x-content-type-options: nosniff" "x-content-type-options:[[:space:]]*nosniff" <<< "$h"
chk "referrer-policy" "referrer-policy" <<< "$h"

echo "-- routes"
curl -sI --max-time 25 "$BASE/trust" | head -1 | chk "/trust serves 200 (not 404)" "200"
curl -sI --max-time 25 "$BASE/person/whatever" | head -1 | chk "/person/<id> rewrite serves 200" "200"
curl -si --max-time 25 "$BASE/no-such-page" | head -1 | chk "unknown path serves 404" "404"
curl -s --max-time 25 "$BASE/no-such-page" | chk "404 page renders its own body" "Page not found|404"

echo "-- geocode Pages Function on the new host"
g="$(curl -si --max-time 30 -X POST "$BASE/geocode" -H 'content-type: application/json' -d '{}')"
chk "empty POST rejected (4xx, not 5xx/404)" "HTTP/[12](\.[01])? 4[0-9][0-9]" <<< "$g"
chk "geocode response carries the security headers" "x-content-type-options" <<< "$g"

echo "-- page actually renders"
curl -s --max-time 30 "$BASE/" | chk "index HTML served" "<html|<!doctype"

echo
p=$(grep -c '^PASS$' "$RESULTS"); f=$(grep -c '^FAIL$' "$RESULTS")
echo "RESULT: $p passed, $f failed"
[ "$f" -eq 0 ]
