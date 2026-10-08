#!/usr/bin/env bash
#
# signing-config.sh: which code signing lanes of release.yml can run?
#
# release.yml builds unsigned installers for Windows and Linux and no macOS
# build at all. Both facts change only when the matching repository secrets
# exist, and this script is the one place that decides whether they do. It
# reads the secrets from its environment, never prints a value, and writes
# four answers to $GITHUB_OUTPUT:
#
#   macos=true|false          the notarized macOS lane (job build-macos) runs
#   macos_notary=api|appleid  which notarization credentials it uses
#   windows=true|false        the Windows lane signs with Azure Artifact Signing
#   signpath=true|false       the Windows lane signs with SignPath
#
# Called with `macos` or `windows` it answers for that lane alone, which is
# how the two jobs of release.yml use it: each hands over only its own secrets.
#
# Windows has two signing routes and a release can take only one of them:
# Azure signs inside `tauri build`, SignPath signs uploaded artifacts after
# it. When both sets are complete the script stops the run with an error
# instead of picking one.
#
# A lane is on only when EVERY value it needs is present. A half-filled set is
# reported as a warning on the run and treated as "off": the build then stays
# exactly what it is today. That keeps a fork, and this repository before the
# accounts exist, on the unsigned path with a green run.
set -euo pipefail

# True when every named variable is non-empty.
have_all() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || return 1
  done
}

# True when at least one named variable is non-empty.
have_any() {
  local name
  for name in "$@"; do
    if [ -n "${!name:-}" ]; then return 0; fi
  done
  return 1
}

# The names of the given variables that are empty, space separated.
missing_of() {
  local name out=""
  for name in "$@"; do
    [ -n "${!name:-}" ] || out="$out $name"
  done
  printf '%s' "${out# }"
}

scope="${1:-all}"
case "$scope" in all | macos | windows) ;; *) echo "usage: $0 [macos|windows]" >&2; exit 2 ;; esac

MAC_CERT=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD)
MAC_NOTARY_API=(APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_P8)
MAC_NOTARY_APPLEID=(APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
WINDOWS=(AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET
  ARTIFACT_SIGNING_ENDPOINT ARTIFACT_SIGNING_ACCOUNT ARTIFACT_SIGNING_PROFILE)
# The API token is a secret. The other three are identifiers, not secrets, and
# are read from repository variables.
SIGNPATH=(SIGNPATH_API_TOKEN SIGNPATH_ORGANIZATION_ID SIGNPATH_PROJECT_SLUG
  SIGNPATH_SIGNING_POLICY_SLUG)

macos=false
macos_notary=""
if [ "$scope" = windows ]; then
  :
elif have_all "${MAC_CERT[@]}"; then
  if have_all "${MAC_NOTARY_API[@]}"; then
    macos=true
    macos_notary=api
  elif have_all "${MAC_NOTARY_APPLEID[@]}"; then
    macos=true
    macos_notary=appleid
  else
    echo "::warning title=macOS signing is off::The Developer ID certificate is set, but neither notarization set is complete. API key set is missing: $(missing_of "${MAC_NOTARY_API[@]}"). Apple ID set is missing: $(missing_of "${MAC_NOTARY_APPLEID[@]}"). No macOS build is made."
  fi
elif have_any "${MAC_CERT[@]}" "${MAC_NOTARY_API[@]}" APPLE_ID APPLE_PASSWORD; then
  echo "::warning title=macOS signing is off::Some Apple secrets are set, but the certificate pair is incomplete. Missing: $(missing_of "${MAC_CERT[@]}"). No macOS build is made."
fi

windows=false
if [ "$scope" = macos ]; then
  :
elif have_all "${WINDOWS[@]}"; then
  windows=true
elif have_any "${WINDOWS[@]}"; then
  echo "::warning title=Azure Artifact Signing is off::Some Azure Artifact Signing secrets are set, but not all six. Missing: $(missing_of "${WINDOWS[@]}"). Azure does not sign this build."
fi

signpath=false
if [ "$scope" = macos ]; then
  :
elif have_all "${SIGNPATH[@]}"; then
  signpath=true
elif have_any "${SIGNPATH[@]}"; then
  echo "::warning title=SignPath signing is off::Some SignPath values are set, but not all four. Missing: $(missing_of "${SIGNPATH[@]}"). SignPath does not sign this build."
fi

if [ "$windows" = true ] && [ "$signpath" = true ]; then
  echo "::error title=Two Windows signing lanes are configured::Both the Azure Artifact Signing secrets and the SignPath values are complete. A release is signed by exactly one of them. Remove the secrets or variables of the lane that should not sign and run again."
  exit 1
fi

out="${GITHUB_OUTPUT:-/dev/stdout}"
if [ "$scope" != windows ]; then
  {
    echo "macos=$macos"
    echo "macos_notary=$macos_notary"
  } >> "$out"
  echo "macOS lane: $macos${macos_notary:+ (notarization via $macos_notary)}"
fi
if [ "$scope" != macos ]; then
  {
    echo "windows=$windows"
    echo "signpath=$signpath"
  } >> "$out"
  echo "Windows signing with Azure Artifact Signing: $windows"
  echo "Windows signing with SignPath: $signpath"
fi
