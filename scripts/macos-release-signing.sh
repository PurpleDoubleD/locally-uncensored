#!/usr/bin/env bash
#
# macos-release-signing.sh: everything in the Mac release lane that touches an
# Apple credential. Called by release.yml's build-tauri-macos job, step by step:
#
#   keychain            A keychain of our own for the run: the Developer ID
#                       certificate, Apple's Developer ID G2 intermediate, and
#                       the proof that the pair forms exactly one valid
#                       identity of the expected team. Writes the identity to
#                       $GITHUB_OUTPUT for the build step.
#   notary-key          Writes the App Store Connect API key (.p8) to a file
#                       only the runner user can read.
#   notary-check        Asks Apple's notary service for the submission history
#                       with that key. Proves the key, the key ID and the
#                       issuer BEFORE the build, in seconds.
#   notarize-dmg FILE   Submits the disk image, waits, staples the ticket,
#                       validates it and asks Gatekeeper.
#   stapler ACTION PATH `xcrun stapler staple|validate PATH`, tried up to
#                       STAPLER_TRIES times (default 5) with STAPLER_PAUSE
#                       seconds (default 60) in between. See stapler_retry.
#   cleanup             Deletes the keychain and the key file. Never fails.
#
#   intermediate FILE   Only the download and hash check of the intermediate
#                       (used by `keychain`; callable alone to re-derive the
#                       pin on a desk).
#   pick-identity TEAM  Only the judgement of a `security find-identity`
#                       listing on stdin (used by `keychain`; callable alone
#                       so signing-lanes.test.ts can execute it).
#
# WHY A KEYCHAIN OF OUR OWN, AND NOT TAURI'S
# ------------------------------------------
# Read at tauri-cli 2.10.1 (package-lock.json), crates tauri-macos-sign and
# tauri-bundler. Given APPLE_CERTIFICATE the bundler imports the .p12 into a
# keychain with a random name, in the middle of `tauri build`, and deletes it
# when the build ends. Three things follow:
#
#   1. That keychain cannot be prepared. The .p12 holds the leaf certificate
#      and its key, not the intermediate that issued it, and whether a hosted
#      runner image carries "Developer ID Certification Authority (G2)" is
#      the image's business. Without it codesign cannot build the chain.
#   2. The bundler picks the identity with `security find-certificate`, by
#      name. That finds a certificate whose chain does not validate just as
#      well as one whose chain does, so a broken chain shows up as a codesign
#      error after twenty minutes of compiling.
#   3. The build step would have to carry the .p12 and its password, next to
#      every build script of every npm and cargo dependency.
#
# So the import happens here, before the build, and the build is given only
# APPLE_SIGNING_IDENTITY. The bundler then takes its other branch
# (Keychain::with_signing_identity): plain `codesign -s <identity>` against
# the user's keychain search list, which this script has extended. The
# identity is handed over as the SHA-1 of the certificate, which codesign
# takes in place of a name and which cannot match a second certificate.
#
# WHY THE NOTARIZATION KEY IS A FILE
# ----------------------------------
# The bundler notarizes the .app with `notarytool submit --key <path>
# --key-id --issuer` when APPLE_API_KEY, APPLE_API_ISSUER and
# APPLE_API_KEY_PATH are set, and it looks at APPLE_ID, APPLE_PASSWORD and
# APPLE_TEAM_ID FIRST, testing "is set", not "is non-empty". The build step
# therefore gets the three API variables and none of the Apple ID ones.
#
# Nothing here prints a secret. No `set -x`, ever.
set -euo pipefail

die() { echo "::error::$*" >&2; exit 1; }

need() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || die "$name is empty or missing"
  done
}

# One directory for everything that must not outlive the job.
signing_dir() {
  : "${RUNNER_TEMP:?runs inside GitHub Actions}"
  printf '%s' "$RUNNER_TEMP/lu-signing"
}
make_signing_dir() {
  local dir
  dir="$(signing_dir)"
  mkdir -p "$dir"
  chmod 700 "$dir"
  printf '%s' "$dir"
}

# ── intermediate ───────────────────────────────────────────────────────────
#
# Apple's own address, and a pinned SHA-256 from the workflow file: the file
# is public, but what goes into a keychain as an issuer is not taken on the
# word of one HTTPS response.
intermediate() {
  local out="${1:?usage: intermediate <out-file>}" got
  need DEVELOPER_ID_G2_URL DEVELOPER_ID_G2_SHA256
  case "$DEVELOPER_ID_G2_URL" in
    https://www.apple.com/certificateauthority/*) ;;
    *) die "DEVELOPER_ID_G2_URL is not under https://www.apple.com/certificateauthority/" ;;
  esac
  curl -fsSL --retry 3 --retry-delay 5 --max-time 60 -o "$out" "$DEVELOPER_ID_G2_URL" \
    || die "could not download the Developer ID G2 intermediate from $DEVELOPER_ID_G2_URL"
  got="$(shasum -a 256 "$out" | awk '{print $1}')"
  if [ "$got" != "$DEVELOPER_ID_G2_SHA256" ]; then
    rm -f "$out"
    die "the Developer ID G2 intermediate has sha256 $got, the workflow pins $DEVELOPER_ID_G2_SHA256. Apple replaced the file, or it was tampered with on the way. Check it by hand (openssl x509 -inform DER -noout -subject -issuer -dates) and move the pin in release.yml."
  fi
  echo "OK: Developer ID G2 intermediate, sha256 $got"
}

# ── pick-identity ──────────────────────────────────────────────────────────
#
# Reads the output of `security find-identity -v -p codesigning <keychain>`
# on stdin and prints the SHA-1 of the one identity it accepts. `-v` lists
# only identities whose chain validates, so "exactly one line, a Developer ID
# Application of our team" is the whole requirement:
#   none        the chain does not validate, or the .p12 holds no private key
#   another     an "Apple Development" or "Mac App Distribution" certificate
#               signs fine and is then refused by the notary service
#   two         codesign would have to guess
pick_identity() {
  local team="${1:?usage: pick-identity <team id>}" listing valid count line
  [[ "$team" =~ ^[A-Z0-9]{10}$ ]] || die "the team ID is not ten characters of A-Z and 0-9"
  listing="$(cat)"
  valid="$(printf '%s\n' "$listing" | grep -E '^[[:space:]]*[0-9]+\) [0-9A-F]{40} "' || true)"
  count="$(printf '%s\n' "$valid" | grep -c . || true)"
  if [ "$count" -eq 0 ]; then
    die "the keychain holds no valid code signing identity. Either the .p12 carries no private key, or the chain to Apple's root does not validate."
  fi
  if [ "$count" -ne 1 ]; then
    die "the keychain holds $count valid code signing identities, expected exactly one. Export only the Developer ID Application certificate with its key."
  fi
  line="$valid"
  case "$line" in
    *'"Developer ID Application: '*) ;;
    *) die "the certificate is not a Developer ID Application certificate. An Apple Development or Mac App Distribution certificate cannot sign a build for download." ;;
  esac
  case "$line" in
    *" ($team)\"") ;;
    *) die "the Developer ID Application certificate belongs to another team than APPLE_TEAM_ID" ;;
  esac
  printf '%s\n' "$line" | sed -E 's/^[[:space:]]*[0-9]+\) ([0-9A-F]{40}) .*$/\1/'
}

# ── keychain ───────────────────────────────────────────────────────────────
keychain() {
  need APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_TEAM_ID GITHUB_OUTPUT
  umask 077
  local dir kc kc_pw p12 cer existing=() line listing identity
  dir="$(make_signing_dir)"
  kc="$dir/signing.keychain-db"
  p12="$dir/certificate.p12"
  cer="$dir/DeveloperIDG2CA.cer"
  kc_pw="$(openssl rand -hex 24)"

  printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$p12" 2>/dev/null \
    || die "APPLE_CERTIFICATE is not valid base64. It must be the output of: base64 -i developer-id.p12"
  [ -s "$p12" ] || die "APPLE_CERTIFICATE decodes to an empty file"

  security create-keychain -p "$kc_pw" "$kc"
  # No auto-lock: the default locks after five minutes, in the middle of the build.
  security set-keychain-settings "$kc"
  security unlock-keychain -p "$kc_pw" "$kc"

  # A .p12 written by OpenSSL 3 with its defaults (AES-256, SHA-256 MAC) is
  # refused here with exactly the message of a wrong password; one written by
  # Keychain Access or by LibreSSL (/usr/bin/openssl on a Mac) is read.
  if ! security import "$p12" -f pkcs12 -P "$APPLE_CERTIFICATE_PASSWORD" -k "$kc" \
        -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>"$dir/import.err"; then
    sed 's/^/security import: /' "$dir/import.err" >&2 || true
    rm -f "$p12"
    die "the .p12 could not be imported. Either APPLE_CERTIFICATE_PASSWORD is wrong, or the .p12 was written by OpenSSL 3 without -legacy (macOS cannot read that format)."
  fi
  rm -f "$p12" "$dir/import.err"

  intermediate "$cer"
  # A hosted runner already carries this intermediate, and security then
  # refuses the import with "already exists". That is the state this step
  # wants; whether the chain holds is judged below by find-identity.
  if ! security import "$cer" -k "$kc" >/dev/null 2>"$dir/intermediate.err"; then
    if grep -q "already exists" "$dir/intermediate.err"; then
      echo "OK: the Developer ID G2 intermediate is already known to this Mac"
    else
      sed 's/^/security import: /' "$dir/intermediate.err" >&2 || true
      die "the Developer ID G2 intermediate could not be imported into the keychain"
    fi
  fi

  # Lets codesign use the key without a dialog nobody can click on a runner.
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kc_pw" "$kc" >/dev/null \
    || die "could not open the signing key to codesign (set-key-partition-list)"

  # Ours first, the runner's own after it. codesign builds the chain from the
  # search list, and the bundler signs without naming a keychain.
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#\"}"; line="${line%\"}"
    [ -n "$line" ] && existing+=("$line")
  done < <(security list-keychains -d user)
  security list-keychains -d user -s "$kc" ${existing[@]+"${existing[@]}"}

  listing="$(security find-identity -v -p codesigning "$kc" 2>&1 || true)"
  if ! identity="$(printf '%s\n' "$listing" | pick_identity "$APPLE_TEAM_ID")"; then
    echo "What the keychain holds, valid or not (certificate names are public):" >&2
    security find-identity -p codesigning "$kc" >&2 || true
    exit 1
  fi
  printf '%s\n' "$listing" | grep -E '^[[:space:]]*[0-9]+\) ' || true

  {
    echo "identity=$identity"
    echo "keychain=$kc"
  } >> "$GITHUB_OUTPUT"
  echo "OK: one valid Developer ID Application identity of the expected team, chain complete."
}

# ── notary-key ─────────────────────────────────────────────────────────────
#
# The path is fixed and is the one release.yml hands to the build as
# APPLE_API_KEY_PATH. notarytool does not care about the file name.
notary_key_path() { printf '%s' "$(signing_dir)/AuthKey.p8"; }

notary_key() {
  need APPLE_API_KEY_P8
  umask 077
  local dir key
  dir="$(make_signing_dir)"
  key="$(notary_key_path)"
  # The secret may hold the .p8 file as it was downloaded, or its base64.
  case "$APPLE_API_KEY_P8" in
    *'BEGIN PRIVATE KEY'*) printf '%s\n' "$APPLE_API_KEY_P8" > "$key" ;;
    *) printf '%s' "$APPLE_API_KEY_P8" | base64 --decode > "$key" 2>/dev/null || true ;;
  esac
  chmod 600 "$key"
  if ! grep -q 'BEGIN PRIVATE KEY' "$key" || ! grep -q 'END PRIVATE KEY' "$key"; then
    rm -f "$key"
    die "APPLE_API_KEY_P8 is neither the .p8 file as downloaded from App Store Connect nor its base64"
  fi
  # Parses as a private key at all: a .p8 pasted without its line breaks
  # fails here and not as an opaque notarytool error after the build.
  if ! openssl pkey -in "$key" -noout >/dev/null 2>&1; then
    rm -f "$key"
    die "APPLE_API_KEY_P8 has the PEM markers but does not parse as a private key. Set it from the file: gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8"
  fi
  echo "OK: the notarization key is written (mode 600) and parses as a private key."
}

# The notarytool arguments for the API key, one per line.
notary_auth() {
  need APPLE_API_KEY APPLE_API_ISSUER
  local key
  key="$(notary_key_path)"
  [ -s "$key" ] || die "the notarization key file is missing; notary-key has to run first"
  printf '%s\n' --key "$key" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"
}

# ── notary-check ───────────────────────────────────────────────────────────
notary_check() {
  local auth=() line dir
  while IFS= read -r line; do auth+=("$line"); done < <(notary_auth)
  [ "${#auth[@]}" -eq 6 ] || exit 1
  dir="$(make_signing_dir)"
  # The history itself is of no interest and is not printed.
  if ! xcrun notarytool history "${auth[@]}" --output-format json >/dev/null 2>"$dir/notary-check.err"; then
    sed 's/^/notarytool: /' "$dir/notary-check.err" >&2 || true
    die "Apple's notary service refused the API key. Check APPLE_API_KEY (the key ID), APPLE_API_ISSUER (the issuer ID from the same page) and APPLE_API_KEY_P8 (that key's .p8), and that no agreement is waiting in the developer account."
  fi
  rm -f "$dir/notary-check.err"
  echo "OK: Apple's notary service accepts the API key."
}

# ── stapler ────────────────────────────────────────────────────────────────
#
# stapler fetches the ticket from Apple's CloudKit (api.apple-cloudkit.com),
# for validate as well as for staple. On 2026-11-05 the 3.0.10 Mac job lost
# that connection five times in a row ("The network connection was lost.",
# Error 68), each time at a different stapler call, while the notarization
# itself had been accepted. A dropped connection is retried; an answer that
# cannot change with another try is not: a file with no ticket stapled to it
# stays without one however often it is validated.
stapler_retry() {
  local action="${1:?usage: stapler staple|validate <path>}" path="${2:?usage: stapler staple|validate <path>}"
  local tries="${STAPLER_TRIES:-5}" pause="${STAPLER_PAUSE:-60}" n out
  case "$action" in staple|validate) ;; *) die "stapler: unknown action $action" ;; esac
  local args=("$action")
  [ "$action" = staple ] && args+=(-v)
  for ((n = 1; n <= tries; n++)); do
    if out="$(xcrun stapler "${args[@]}" "$path" 2>&1)"; then
      printf '%s\n' "$out"
      echo "stapler $action: OK on try $n of $tries ($(basename "$path"))"
      return 0
    fi
    printf '%s\n' "$out" >&2
    if [[ "$out" == *'does not have a ticket stapled'* ]]; then
      die "stapler $action: $(basename "$path") has no ticket stapled to it; another try cannot change that"
    fi
    if [ "$n" -lt "$tries" ]; then
      echo "::warning::stapler $action failed on try $n of $tries ($(basename "$path")); trying again in ${pause}s"
      sleep "$pause"
    fi
  done
  die "stapler $action failed $tries times for $(basename "$path")"
}

# ── notarize-dmg ───────────────────────────────────────────────────────────
#
# The bundler notarizes and staples the .app and only signs the .dmg. The
# disk image is the file a customer downloads, so it gets a ticket of its own:
# Gatekeeper then accepts it on first open, without a network round trip.
notarize_dmg() {
  local dmg="${1:?usage: notarize-dmg <file.dmg>}"
  [ -s "$dmg" ] || die "no disk image at $dmg"
  local auth=() line dir result status id verdict
  while IFS= read -r line; do auth+=("$line"); done < <(notary_auth)
  [ "${#auth[@]}" -eq 6 ] || exit 1
  dir="$(make_signing_dir)"
  result="$dir/notary-dmg.json"

  echo "== the signature the bundler put on the disk image"
  codesign --verify --verbose=2 "$dmg"
  local info
  info="$(codesign -dvv "$dmg" 2>&1)" || die "the disk image carries no signature"
  printf '%s\n' "$info" | grep -E '^(Authority|TeamIdentifier|Timestamp)' || true
  case "$info" in
    *'Authority=Developer ID Application: '*) ;;
    *) die "the disk image is not signed with a Developer ID Application certificate" ;;
  esac

  echo "== submit and wait"
  # notarytool exits 0 for a submission Apple answered with "Invalid", so the
  # status is read from its JSON, not from the exit code.
  xcrun notarytool submit "$dmg" "${auth[@]}" --wait --timeout 30m --output-format json > "$result" \
    || echo "notarytool submit exited with an error; judging its answer below" >&2
  cat "$result" || true
  echo
  status="$(plutil -extract status raw -o - "$result" 2>/dev/null || true)"
  id="$(plutil -extract id raw -o - "$result" 2>/dev/null || true)"
  if [ "$status" != "Accepted" ]; then
    if [ -n "$id" ]; then
      xcrun notarytool log "$id" "${auth[@]}" || true
    fi
    die "Apple did not accept the disk image (status: ${status:-none})"
  fi

  echo "== staple and validate"
  stapler_retry staple "$dmg"
  stapler_retry validate "$dmg"
  # Stapling rewrites the file; the signature has to have survived it.
  codesign --verify --verbose=2 "$dmg"

  echo "== Gatekeeper"
  # With assessments switched off on the runner spctl accepts everything and
  # proves nothing, so it is then reported and not judged.
  local gatekeeper
  gatekeeper="$(spctl --status 2>&1 || true)"
  if [[ "$gatekeeper" == *'assessments enabled'* ]]; then
    verdict="$(spctl -a -t open --context context:primary-signature -vv "$dmg" 2>&1)" \
      || { echo "$verdict"; die "Gatekeeper rejects the disk image"; }
    echo "$verdict"
    [[ "$verdict" == *'source=Notarized Developer ID'* ]] \
      || die "Gatekeeper accepts the disk image, but not as Notarized Developer ID"
  else
    echo "::warning::Gatekeeper assessments are disabled on this runner; spctl was not judged for the disk image. stapler validate above is the notarization proof."
  fi
  echo "OK: the disk image is signed, notarized and stapled."
}

# ── cleanup ────────────────────────────────────────────────────────────────
cleanup() {
  local dir kc
  dir="$(signing_dir)"
  kc="$dir/signing.keychain-db"
  if [ -e "$kc" ]; then
    # Also takes it out of the search list.
    security delete-keychain "$kc" 2>/dev/null || true
  fi
  rm -rf "$dir" || true
  echo "The signing keychain and the notarization key are gone."
}

case "${1:-}" in
  keychain) keychain ;;
  notary-key) notary_key ;;
  notary-check) notary_check ;;
  notarize-dmg) shift; notarize_dmg "$@" ;;
  stapler) shift; stapler_retry "$@" ;;
  cleanup) cleanup ;;
  intermediate) shift; intermediate "$@" ;;
  pick-identity) shift; pick_identity "$@" ;;
  *) echo "usage: $0 keychain | notary-key | notary-check | notarize-dmg <file.dmg> | cleanup | intermediate <out-file> | pick-identity <team id>" >&2; exit 2 ;;
esac
