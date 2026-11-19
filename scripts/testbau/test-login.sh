#!/usr/bin/env bash
# TEST-LOGIN (3.1.3): sign a TEST BUILD in to LU Cloud with the fixed test
# account. Only a build made with the Cargo feature test-login (and
# VITE_LU_TEST_LOGIN=1) listens; a shipped build has no way in at all
# (src-tauri/src/test_login.rs, scripts/check-no-test-login.sh).
#
#   scripts/testbau/test-login.sh "/path/to/LU test.app"
#
# What it does:
#  1. the service role key: by default the Supabase access token (PAT) comes
#     from the keychain (item "lu/SUPABASE_PAT", the Cloud-Pflege's item) and
#     the key is asked from the management API at run time,
#     GET /v1/projects/<ref>/api-keys?reveal=true. Nothing of it is kept.
#  2. POST <project>/auth/v1/admin/generate_link, type magiclink, for the
#     test account; of the answer only properties.hashed_token is used.
#  3. that token goes through a pipe straight into the app, started with
#     --test-login-stdin.
# PAT, key and token only ever live in pipes and in the memory of one python
# process: never on a command line (ps), never printed, never in a file.
#
# Inputs (none of them live in the repo):
#   LU_TEST_LOGIN_EMAIL     the test account's e-mail (must also be in the
#                           build's LU_TEST_LOGIN_ALLOW, or the app refuses)
#   LU_SUPABASE_URL         the project, https://<ref>.supabase.co
#   LU_SUPABASE_PAT_ITEM    keychain item of the PAT, default lu/SUPABASE_PAT
#   LU_TEST_LOGIN_KEY_FD3=1 take the service role key itself from file
#                           descriptor 3 instead (another machine, self test)
#   LU_TEST_LOGIN_PAT_FD3=1 take the PAT from file descriptor 3 instead of
#                           the keychain (self test)
# For the self test (src/lib/__tests__/test-login-script.test.ts) a local
# address http://127.0.0.1:<port> is accepted for LU_SUPABASE_URL and
# LU_SUPABASE_MGMT_URL, with LU_SUPABASE_REF naming the project.
set -euo pipefail

app="${1:-}"
[ -n "$app" ] || { echo "usage: $0 <test app (.app or program)>" >&2; exit 2; }
if [ -d "$app" ]; then
  bin="$(find "$app/Contents/MacOS" -maxdepth 1 -type f -perm -u+x | head -n 1)"
else
  bin="$app"
fi
[ -x "${bin:-}" ] || { echo "test-login: no program found in $app" >&2; exit 2; }
export LU_TEST_LOGIN_EMAIL="${LU_TEST_LOGIN_EMAIL:?set LU_TEST_LOGIN_EMAIL to the test account e-mail}"
export LU_SUPABASE_URL="${LU_SUPABASE_URL:?set LU_SUPABASE_URL to https://<ref>.supabase.co}"
export LU_SUPABASE_MGMT_URL="${LU_SUPABASE_MGMT_URL:-https://api.supabase.com}"
pat_item="${LU_SUPABASE_PAT_ITEM:-lu/SUPABASE_PAT}"
local_ok() { case "$1" in http://127.0.0.1:*) return 0 ;; *) return 1 ;; esac; }
case "$LU_SUPABASE_URL" in
  https://*.supabase.co) ref="${LU_SUPABASE_URL#https://}"; ref="${ref%%.supabase.co*}" ;;
  *) local_ok "$LU_SUPABASE_URL" || { echo "test-login: LU_SUPABASE_URL must be https://<ref>.supabase.co" >&2; exit 2; }
     ref="${LU_SUPABASE_REF:?a local address needs LU_SUPABASE_REF}" ;;
esac
[ "$LU_SUPABASE_MGMT_URL" = "https://api.supabase.com" ] || local_ok "$LU_SUPABASE_MGMT_URL" \
  || { echo "test-login: LU_SUPABASE_MGMT_URL must be https://api.supabase.com" >&2; exit 2; }
export LU_SUPABASE_REF="$ref"

# What goes into the python step on its stdin: "key <service key>" or
# "pat <access token>". Read here, never echoed.
if [ "${LU_TEST_LOGIN_KEY_FD3:-}" = 1 ]; then
  credential() { printf 'key '; head -n 1 <&3; }
elif [ "${LU_TEST_LOGIN_PAT_FD3:-}" = 1 ]; then
  credential() { printf 'pat '; head -n 1 <&3; }
else
  security find-generic-password -s "$pat_item" >/dev/null 2>&1 \
    || { echo "test-login: keychain item '$pat_item' not found" >&2; exit 2; }
  credential() { printf 'pat '; security find-generic-password -s "$pat_item" -w; }
fi

credential | python3 -I -c '
import json, os, sys, urllib.request, urllib.error

def fail(msg):
    sys.stderr.write("test-login: %s\n" % str(msg)[:200]); sys.exit(1)

def call(method, url, headers, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        try:
            d = json.loads(e.read().decode() or "{}")
            msg = d.get("msg") or d.get("message") or d.get("error_description") or d.get("error")
        except Exception:
            msg = None
        fail("%s answered HTTP %s%s" % (url.split("?")[0], e.code, (": " + str(msg)) if msg else ""))
    except Exception as e:
        fail("%s could not be reached (%s)" % (url.split("?")[0], type(e).__name__))

kind, _, secret = sys.stdin.readline().strip().partition(" ")
if not secret:
    fail("no credential came in")
ref = os.environ["LU_SUPABASE_REF"]
if kind == "pat":
    keys = call("GET", "%s/v1/projects/%s/api-keys?reveal=true" % (os.environ["LU_SUPABASE_MGMT_URL"], ref),
                {"Authorization": "Bearer " + secret, "Accept": "application/json"})
    service = None
    for k in keys if isinstance(keys, list) else []:
        if k.get("name") == "service_role" and k.get("api_key"):
            service = k["api_key"]; break
    if not service:
        for k in keys if isinstance(keys, list) else []:
            if k.get("type") == "secret" and k.get("api_key"):
                service = k["api_key"]; break
    if not service:
        fail("the management API listed no service role key for this project")
else:
    service = secret

d = call("POST", os.environ["LU_SUPABASE_URL"].rstrip("/") + "/auth/v1/admin/generate_link",
         {"apikey": service, "Authorization": "Bearer " + service, "Content-Type": "application/json"},
         {"type": "magiclink", "email": os.environ["LU_TEST_LOGIN_EMAIL"]})
tok = ((d or {}).get("properties") or {}).get("hashed_token") or (d or {}).get("hashed_token")
if not tok:
    fail((d or {}).get("msg") or (d or {}).get("message") or "no token in the answer")
sys.stdout.write(tok + "\n")
' \
  | "$bin" --test-login-stdin >/dev/null 2>&1 &

echo "test-login: started $(basename "$bin") with the test account's one-time token (pid $!)."
