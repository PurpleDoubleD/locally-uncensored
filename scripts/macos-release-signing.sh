#!/usr/bin/env bash
#
# macos-release-signing.sh: the two halves of the macOS release lane that
# `tauri build` does not do by itself. Runs only in release.yml's build-macos
# job, which exists only when scripts/signing-config.sh found the Apple secrets.
#
#   prepare   Hands exactly ONE set of notarization credentials to the build.
#   finish    Proves what the build signed, notarizes and staples the disk
#             image, and asks Gatekeeper for its verdict.
#
# What `tauri build` does in between, read at tauri-cli 2.10.1 (the version in
# package-lock.json): with APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD set
# it imports the .p12 into a keychain of its own and deletes it afterwards. It
# signs the frameworks, every externalBin (lu-llama-server) and the main binary
# with the Hardened Runtime and bundle.macOS.entitlements, then the .app. With
# notarization credentials in the environment it submits the .app through
# notarytool, waits, and staples it. It signs the .dmg but neither notarizes
# nor staples it. The updater archive is packed from the stapled .app.
#
# Nothing here touches a keychain.
set -euo pipefail

die() { echo "::error::$*" >&2; exit 1; }

# ── prepare ────────────────────────────────────────────────────────────────
#
# tauri-bundler reads APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID first and the API
# key variables second, and it tests for "is set", not "is non-empty". A
# workflow step that maps every secret into its env would hand it empty Apple
# ID variables next to a real API key, and it would try to notarize with the
# empty ones. So the build step gets none of them from the workflow file: this
# function writes the one complete set to $GITHUB_ENV and leaves the other
# names unset.
prepare() {
  : "${GITHUB_ENV:?prepare runs inside GitHub Actions}"
  : "${RUNNER_TEMP:?prepare runs inside GitHub Actions}"
  case "${NOTARY_MODE:-}" in
    api)
      [ -n "${NOTARY_API_KEY:-}" ] && [ -n "${NOTARY_API_ISSUER:-}" ] && [ -n "${NOTARY_API_KEY_P8:-}" ] \
        || die "NOTARY_MODE=api but the API key secrets are incomplete"
      umask 077
      local dir="$RUNNER_TEMP/private_keys"
      local key="$dir/AuthKey_${NOTARY_API_KEY}.p8"
      mkdir -p "$dir"
      # The secret may hold the .p8 file as it was downloaded, or its base64.
      if printf '%s' "$NOTARY_API_KEY_P8" | grep -q 'BEGIN PRIVATE KEY'; then
        printf '%s\n' "$NOTARY_API_KEY_P8" > "$key"
      else
        printf '%s' "$NOTARY_API_KEY_P8" | base64 --decode > "$key"
      fi
      grep -q 'BEGIN PRIVATE KEY' "$key" || die "APPLE_API_KEY_P8 is neither the .p8 file nor its base64"
      {
        echo "APPLE_API_KEY=$NOTARY_API_KEY"
        echo "APPLE_API_ISSUER=$NOTARY_API_ISSUER"
        echo "APPLE_API_KEY_PATH=$key"
      } >> "$GITHUB_ENV"
      echo "notarization: App Store Connect API key"
      ;;
    appleid)
      [ -n "${NOTARY_APPLE_ID:-}" ] && [ -n "${NOTARY_APPLE_PASSWORD:-}" ] && [ -n "${EXPECTED_TEAM_ID:-}" ] \
        || die "NOTARY_MODE=appleid but the Apple ID secrets are incomplete"
      {
        echo "APPLE_ID=$NOTARY_APPLE_ID"
        echo "APPLE_PASSWORD=$NOTARY_APPLE_PASSWORD"
        echo "APPLE_TEAM_ID=$EXPECTED_TEAM_ID"
      } >> "$GITHUB_ENV"
      echo "notarization: Apple ID with an app-specific password"
      ;;
    *) die "NOTARY_MODE must be api or appleid, got '${NOTARY_MODE:-}'" ;;
  esac
}

# The notarytool arguments for the set `prepare` exported.
notary_auth() {
  if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
    printf '%s\n' --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"
  else
    printf '%s\n' --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
  fi
}

# One signed Mach-O file: Developer ID, our team, a secure timestamp, and the
# Hardened Runtime if it is an executable. Notarization demands all four, and a
# file that misses one is named here instead of in Apple's log.
check_macho() {
  local path="$1" kind info
  kind="$(file -b "$path")"
  case "$kind" in *Mach-O*) ;; *) return 0 ;; esac
  info="$(codesign -dvv "$path" 2>&1)" || die "not signed: $path"
  echo "$info" | grep -q '^Authority=Developer ID Application' \
    || die "not signed with a Developer ID Application certificate: $path"
  if [ -n "${EXPECTED_TEAM_ID:-}" ]; then
    echo "$info" | grep -q "^TeamIdentifier=${EXPECTED_TEAM_ID}\$" \
      || die "signed by a different team than APPLE_TEAM_ID: $path"
  fi
  echo "$info" | grep -q '^Timestamp=' || die "no secure timestamp: $path"
  case "$kind" in
    *executable*)
      echo "$info" | grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\(.*runtime.*\)' \
        || die "executable without the Hardened Runtime: $path"
      ;;
  esac
  echo "ok  $path"
}

# ── finish ─────────────────────────────────────────────────────────────────
finish() {
  local bundle_root="${1:-src-tauri/target}"
  local app dmg
  app="$(find "$bundle_root" -type d -path '*/bundle/macos/*.app' -print -quit)"
  dmg="$(find "$bundle_root" -type f -path '*/bundle/dmg/*.dmg' -print -quit)"
  [ -n "$app" ] || die "no .app under $bundle_root/**/bundle/macos"
  [ -n "$dmg" ] || die "no .dmg under $bundle_root/**/bundle/dmg"
  echo "app: $app"
  echo "dmg: $dmg"

  echo "== 1. the seal of the app bundle"
  codesign --verify --deep --strict --verbose=2 "$app"

  echo "== 2. every Mach-O file inside it"
  local file_path
  while IFS= read -r -d '' file_path; do
    check_macho "$file_path"
  done < <(find "$app" -type f -print0)

  echo "== 3. entitlements of the main binary"
  local entitlements
  entitlements="$(codesign -d --entitlements - --xml "$app" 2>/dev/null || true)"
  echo "$entitlements"
  if echo "$entitlements" | grep -q 'get-task-allow'; then
    die "the app carries com.apple.security.get-task-allow, notarization rejects that"
  fi

  echo "== 4. the notarization ticket tauri build stapled to the app"
  xcrun stapler validate "$app"
  local verdict
  verdict="$(spctl --assess --type execute -vv "$app" 2>&1)" || { echo "$verdict"; die "Gatekeeper rejects the app"; }
  echo "$verdict"
  echo "$verdict" | grep -q 'source=Notarized Developer ID' \
    || die "Gatekeeper accepts the app, but not as Notarized Developer ID"

  echo "== 5. notarize and staple the disk image"
  codesign --verify --verbose=2 "$dmg"
  local auth=() line
  while IFS= read -r line; do auth+=("$line"); done < <(notary_auth)
  local result="${RUNNER_TEMP:-/tmp}/notary-dmg.json"
  # notarytool exits 0 for a submission Apple answered with "Invalid", so the
  # status is read from its JSON, not from the exit code.
  xcrun notarytool submit "$dmg" "${auth[@]}" --wait --output-format json > "$result" || true
  cat "$result"
  local status id
  status="$(plutil -extract status raw -o - "$result" 2>/dev/null || true)"
  id="$(plutil -extract id raw -o - "$result" 2>/dev/null || true)"
  if [ "$status" != "Accepted" ]; then
    [ -n "$id" ] && xcrun notarytool log "$id" "${auth[@]}" || true
    die "Apple did not accept the disk image (status: ${status:-none})"
  fi
  xcrun stapler staple -v "$dmg"
  xcrun stapler validate "$dmg"
  verdict="$(spctl --assess --type open --context context:primary-signature -vv "$dmg" 2>&1)" \
    || { echo "$verdict"; die "Gatekeeper rejects the disk image"; }
  echo "$verdict"
  echo "$verdict" | grep -q 'source=Notarized Developer ID' \
    || die "Gatekeeper accepts the disk image, but not as Notarized Developer ID"

  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "dmg=$dmg" >> "$GITHUB_OUTPUT"
  fi
  echo "OK: app and disk image are signed, notarized and stapled, and Gatekeeper accepts both"
}

case "${1:-}" in
  prepare) prepare ;;
  finish) shift; finish "$@" ;;
  *) echo "usage: $0 prepare | finish [bundle-root]" >&2; exit 2 ;;
esac
