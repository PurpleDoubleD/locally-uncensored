#!/usr/bin/env bash
# TEST-LOGIN (3.1.3): sign a running-from-scratch TEST BUILD in to LU Cloud
# with the fixed test account. Only a build made with the Cargo feature
# test-login (and VITE_LU_TEST_LOGIN=1) listens; a shipped build has no way
# in at all (src-tauri/src/test_login.rs, scripts/check-no-test-login.sh).
#
#   scripts/testbau/test-login.sh "/path/to/LU test.app"
#
# What it does: fetch a one-time magic link token for the test account from
# the Supabase admin API (POST /auth/v1/admin/generate_link, type magiclink)
# and pipe its hashed token straight into the app, started with
# --test-login-stdin. The service key and the token only ever travel through
# pipes: never on a command line (ps), never printed, never in a file.
#
# Inputs (none of them live in the repo):
#   LU_TEST_LOGIN_EMAIL        the test account's e-mail (must also be in the
#                              build's LU_TEST_LOGIN_ALLOW, or the app refuses)
#   LU_SUPABASE_URL            the project URL, https://<ref>.supabase.co
#   LU_SUPABASE_KEYCHAIN_ITEM  macOS keychain item (generic password, service
#                              name) that holds the service role key;
#                              default: lu-supabase-service-role
#   LU_TEST_LOGIN_KEY_FD3=1    take the key from file descriptor 3 instead of
#                              the keychain (another machine, the self test)
#
# A local address (http://127.0.0.1:<port>) is accepted too, for the self
# test (src/lib/__tests__/test-login-script.test.ts).
set -euo pipefail

app="${1:-}"
[ -n "$app" ] || { echo "usage: $0 <test app (.app or program)>" >&2; exit 2; }
if [ -d "$app" ]; then
  bin="$(find "$app/Contents/MacOS" -maxdepth 1 -type f -perm -u+x | head -n 1)"
else
  bin="$app"
fi
[ -x "${bin:-}" ] || { echo "test-login: no program found in $app" >&2; exit 2; }
email="${LU_TEST_LOGIN_EMAIL:?set LU_TEST_LOGIN_EMAIL to the test account e-mail}"
url="${LU_SUPABASE_URL:?set LU_SUPABASE_URL to https://<ref>.supabase.co}"
item="${LU_SUPABASE_KEYCHAIN_ITEM:-lu-supabase-service-role}"
case "$url" in https://*.supabase.co|http://127.0.0.1:*) ;; *) echo "test-login: LU_SUPABASE_URL must be https://<ref>.supabase.co" >&2; exit 2 ;; esac
key_source() {
  if [ "${LU_TEST_LOGIN_KEY_FD3:-}" = 1 ]; then cat <&3; else security find-generic-password -s "$item" -w; fi
}
if [ "${LU_TEST_LOGIN_KEY_FD3:-}" != 1 ]; then
  security find-generic-password -s "$item" >/dev/null 2>&1 \
    || { echo "test-login: keychain item '$item' not found" >&2; exit 2; }
fi

# Request headers from the keychain, into curl's stdin (-H @-), so the key is
# never an argument. The body names only the e-mail.
body="$(python3 -I -c 'import json,sys; print(json.dumps({"type": "magiclink", "email": sys.argv[1]}))' "$email")"

key_source \
  | python3 -I -c 'import sys; k=sys.stdin.readline().strip(); sys.stdout.write("apikey: %s\nAuthorization: Bearer %s\nContent-Type: application/json\n" % (k, k))' \
  | curl -sS --max-time 30 -H @- -X POST --data "$body" "$url/auth/v1/admin/generate_link" \
  | python3 -I -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    sys.stderr.write("test-login: the admin API did not answer with JSON\n"); sys.exit(1)
tok = (d.get("properties") or {}).get("hashed_token") or d.get("hashed_token")
if not tok:
    msg = d.get("msg") or d.get("message") or d.get("error_description") or d.get("error") or "no token in the answer"
    sys.stderr.write("test-login: %s\n" % str(msg)[:200]); sys.exit(1)
sys.stdout.write(tok + "\n")
' \
  | "$bin" --test-login-stdin >/dev/null 2>&1 &

echo "test-login: started $(basename "$bin") with the test account's one-time token (pid $!)."
