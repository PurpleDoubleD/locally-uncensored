#!/usr/bin/env bash
# TEST-LOGIN release guard (3.1.3). A shipped build must not carry the test
# build's way in (src-tauri/src/test_login.rs, src/lib/test-login.ts). Pass
# the web bundle and the built program(s); any trace of it fails the run.
#
#   scripts/check-no-test-login.sh dist src-tauri/target/release/locally-uncensored
#
# The three traces: the marker both halves carry, the command name and the
# start argument. Binary files are searched as text (grep -a).
set -euo pipefail
[ "$#" -gt 0 ] || { echo "usage: $0 <file or dir>..." >&2; exit 2; }
traces=(-e 'LU-TEST-LOGIN-ENTRANCE' -e 'test_login_take' -e '--test-login-stdin')
found=0
for p in "$@"; do
  if [ ! -e "$p" ]; then echo "check-no-test-login: $p does not exist" >&2; exit 2; fi
  if hits="$(grep -a -r -l "${traces[@]}" -- "$p" 2>/dev/null)"; then
    echo "check-no-test-login: the test login is in this build:" >&2
    echo "$hits" >&2
    found=1
  fi
done
[ "$found" -eq 0 ] || exit 1
echo "check-no-test-login: no trace of the test login in: $*"
