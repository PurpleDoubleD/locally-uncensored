#!/usr/bin/env bash
#
# ci-tauri-build.sh — the check that asks "is this product still buildable?"
#
# WHY THIS EXISTS
# ---------------
# On 2026-09-01 `npm run tauri build` was measured on Windows and reproduced on
# macOS: it wrote the installers to disk and then exited 1.
#
#     Finished 2 bundles at: … .app … .dmg … .app.tar.gz (updater)
#     Error A public key has been found, but no private key.
#           Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable.
#     TAURI_BUILD_EXIT=1
#
# That defect was already present at 10bfa0d7 (v2.6.7), i.e. in the shipped
# product: `bundle.createUpdaterArtifacts` asked the bundler for signed updater
# artifacts while `plugins.updater.pubkey` sat next to it, so the bundler
# demanded a private key nobody outside the release runner has. Anybody who
# cloned the repo and built it got exit 1 — a fork, a contributor, an AGPL-3.0
# recipient exercising §6.
#
# Nobody noticed for one structural reason: `.github/workflows/ci.yml` never ran
# `tauri build`. It ran `npm run build` (vite), `cargo check`, `cargo test` —
# every one of which passes on a config that cannot be bundled. The only place
# `tauri build` ever ran was release.yml, and there
# `TAURI_SIGNING_PRIVATE_KEY` comes out of GitHub secrets, so the one lane that
# could have seen the failure was the one lane configured not to hit it.
#
# THE KEY, AND WHY THIS SCRIPT REFUSES TO HAVE ONE
# ------------------------------------------------
# This script deliberately builds with NO signing key, and it unsets the two
# signing variables itself rather than merely not setting them:
#
#   * A gate that reads a secret is a gate that can go quietly green in a fork,
#     where the secret does not exist. The usual shapes of that — `if:
#     ${{ secrets.X != '' }}`, `continue-on-error: true`, `|| true` — all end in
#     a check that reports success while having verified nothing. None of them
#     appear here, and none can: there is no secret to be missing.
#   * Keyless is also the configuration the defect lives in. Handing the build a
#     key would have made the broken 10bfa0d7 config build cleanly and the gate
#     would have been green on the exact commit it exists to fail.
#   * A fork is therefore held to precisely the check upstream is held to, with
#     no repository settings and no secrets to configure.
#
# The trade this makes, stated plainly: if `createUpdaterArtifacts` is ever
# switched back on in `src-tauri/tauri.conf.json` (it is legitimately on in the
# real release branch, where the key exists), this gate goes red and says why.
# That is the intended reading — "this tree cannot be built by anyone who is not
# the release runner" is a finding, not a false alarm — but it does mean the
# release branch has to pass the updater-artifact request to the release build
# (`tauri build --config …` in release.yml) instead of baking it into the
# checked-in config. See the report for the human-side task.
#
# WHAT "PASSED" MEANS HERE
# ------------------------
# Three conditions, all required, in this order:
#   1. `tauri build` exited 0. Taken from PIPESTATUS[0], not from `tee`.
#   2. The build left installers behind. An exit 0 that bundles nothing is not
#      a build.
#   3. The log carries no signing complaint. This is the belt to (1)'s braces:
#      the original defect printed its error AFTER "Finished 2 bundles at", so
#      artifact existence proves nothing, and if a future tauri demotes that
#      error to a warning the exit code would stop reporting it.
#
# Usage:
#   scripts/ci-tauri-build.sh                # build the checked-in config
#   scripts/ci-tauri-build.sh -c '<json>'    # extra args go to `tauri build`
#
# Sourceable: `main` only runs when the file is executed, so tests can source it
# and call `build_verdict` directly (see the sibling of this file in
# src/lib/__tests__/).
#
set -uo pipefail

BUNDLE_DIR="${BUNDLE_DIR:-src-tauri/target/release/bundle}"
BUILD_LOG="${BUILD_LOG:-tauri-build.log}"

# Everything the bundlers of the two shipped platforms (and this Mac) emit.
# Matched case-insensitively against file names under the bundle directory.
INSTALLER_SUFFIXES='\.(AppImage|deb|rpm|msi|exe|dmg)$'

# The bundler's own words when a pubkey is configured and no private key is in
# the environment. Both halves are matched: the sentence, and the variable it
# names, so a reworded message still trips the second one.
SIGNING_COMPLAINT='A public key has been found, but no private key|TAURI_SIGNING_PRIVATE_KEY'

log() { printf '%s\n' "$*" >&2; }

# How many installer files a build left behind. Directory may not exist.
count_installers() {
  local dir="$1"
  [ -d "$dir" ] || { printf '0\n'; return 0; }
  # `grep -c` exits 1 on zero matches, which is a legitimate answer here and
  # not an error — `|| true` keeps it from propagating through pipefail.
  find "$dir" -type f 2>/dev/null | grep -Eci "$INSTALLER_SUFFIXES" || true
}

# build_verdict <exit_code> <log_file> <bundle_dir>
#
# The whole judgement, separated from the build so it can be executed by a test
# against real files instead of being read and hoped about. Returns 0 only when
# all three conditions hold; prints the reason for anything else.
build_verdict() {
  local code="$1" logfile="$2" dir="$3"
  local installers
  installers="$(count_installers "$dir")"

  if [ "$code" -ne 0 ]; then
    log "FAIL: tauri build exited $code (it left $installers installer file(s) behind —"
    log "      artifacts on disk are not a passing build)."
    return 1
  fi

  if [ "$installers" -eq 0 ]; then
    log "FAIL: tauri build exited 0 but produced no installer under '$dir'."
    return 1
  fi

  if [ -f "$logfile" ] && grep -qE "$SIGNING_COMPLAINT" "$logfile"; then
    log "FAIL: tauri build exited 0, but the log asks for a signing key."
    log "      A keyless build must not need one. Check bundle.createUpdaterArtifacts."
    return 1
  fi

  log "OK: tauri build exited 0 and bundled $installers installer file(s), unsigned."
  return 0
}

main() {
  # 1. No signing key, on purpose — see the header. Unset rather than assumed
  #    absent, so a runner-level env var cannot quietly turn this green.
  unset TAURI_SIGNING_PRIVATE_KEY
  unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD

  # 2. Start from an empty bundle directory, so "did this build produce
  #    installers" cannot be answered by a previous build's leftovers. That is
  #    the same mistake discord-announce.yml made with release assets on
  #    2026-08-15, counted rather than attributed.
  rm -rf "$BUNDLE_DIR"
  rm -f "$BUILD_LOG"

  log "Building WITHOUT a signing key (deliberate). Bundle dir: $BUNDLE_DIR"

  # 3. `tee` so the log is both visible in the runner and greppable afterwards.
  #    The exit code comes out of PIPESTATUS[0]: `$?` after a pipeline is tee's
  #    status, which is 0 whatever the build did. pipefail is set as well; the
  #    explicit read is what the reader should be able to check at a glance.
  npm run tauri -- build --ci "$@" 2>&1 | tee "$BUILD_LOG"
  local code=${PIPESTATUS[0]}
  log "TAURI_BUILD_EXIT=$code"

  build_verdict "$code" "$BUILD_LOG" "$BUNDLE_DIR"
}

# Only run when executed directly, so tests can source the pure functions.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
