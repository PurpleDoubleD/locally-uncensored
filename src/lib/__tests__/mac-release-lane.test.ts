/**
 * The Mac release lane is conditional, and its condition must not rot.
 *
 * `.github/workflows/release.yml` carries a job `build-tauri-macos` that
 * builds, signs (Developer ID), notarizes and attaches the Apple Silicon app.
 * In a release it is skipped unless the repository variable `LU_MAC_RELEASE`
 * is `1`, because an ad hoc signed Mac build that arrives through a browser
 * is refused by Gatekeeper. The one other way in is a dry run: the Mac dry
 * run (`workflow_dispatch` with `mac_dry_run`), which runs this job alone,
 * or a full dry run with the Mac in it (`dry_run` and `dry_run_mac`). Neither
 * touches a release, and the job knows both by one value, MAC_DRY_RUN.
 * release-dry-run.test.ts holds the Windows and Linux half of the full one.
 *
 * The two older guards read the `- platform:` entries of the build-tauri
 * matrix (release-build-gate.test.ts, kein-mac-fix-gilt-als-ausgeliefert
 * .test.ts). The Mac job is deliberately not in that matrix, so neither of
 * them sees it. This file holds what they would otherwise have held:
 *
 *   1. the lane can be skipped as a whole and reads its switch, not a secret,
 *      in the job condition;
 *   2. switched on, it refuses to run with an incomplete set of secrets, so a
 *      half configured repository cannot publish an unsigned or un-notarized
 *      build under a green tick;
 *   3. it waits for the Windows and Linux lanes (latest.json is merged, not
 *      locked) and proves the darwin key afterwards;
 *   4. a Mac release is held to a keyless gate in ci.yml under the same
 *      switch, which reads no secret and has no escape hatch;
 *   5. the minimum macOS version is one number in three places;
 *   6. nothing reaches the release before it was judged: the build is a
 *      plain `tauri build`, the verification steps follow, and tauri-action
 *      comes after them and only uploads;
 *   7. the Mac paragraph of the release text hangs on the same switch, and
 *      with the switch off the text is the one Windows and Linux always had;
 *   8. the keyless gate also asks pip for the engines' pins, runs the image
 *      sidecar's tests and judges the bundle with the release lane's script;
 *   9. the certificate goes into a keychain of the lane's own, together with
 *      Apple's pinned intermediate, and is proven BEFORE the build; the
 *      build is handed the proven identity and an API key for the notary
 *      service, and neither the .p12 nor any Apple ID variable;
 *  10. the disk image gets a ticket of its own before it is uploaded, and the
 *      keychain and the key file are gone before a release token appears;
 *  11. a dry run builds, signs, notarizes and judges the same way and can
 *      reach neither the release nor the Windows and Linux lanes;
 *  12. a dry run never reads the release's updater key: it signs its updater
 *      archive with a key made in the job, and its artifact says so;
 *  13. a full dry run puts the job into that same mode and nothing else does,
 *      and only there the updater of the build is pointed away from the
 *      public channel.
 *
 * VERIFICATION LIMIT: neither job has ever run in GitHub Actions. This file
 * proves structure, nothing about Apple's notary service.
 * signing-lanes.test.ts executes the two parts of the signing script that
 * need no keychain.
 *
 * Run: npx vitest run src/lib/__tests__/mac-release-lane.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const CI_YML = read('.github/workflows/ci.yml')
const RELEASE_YML = read('.github/workflows/release.yml')

/** Same slicing as release-build-gate.test.ts: jobs sit two spaces deep. */
function jobBlock(yaml: string, job: string): string {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((l) => l === `  ${job}:`)
  if (start < 0) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^ {2}[^\s#]/.test(l)) { end = i; break }
    if (/^\S/.test(l) && l.trim() !== '') { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

/** Prose removed, so a note about a rule cannot pass for the rule. */
function withoutComments(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s#.*$/, ''))
    .join('\n')
}

/** The six the owner enters. No Apple ID, no app-specific password. */
const APPLE_SECRETS = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY_P8',
]
/** Names this lane must not read: there are no such secrets. */
const NO_SUCH_SECRETS = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_SIGNING_IDENTITY']

const SIGNING_SH = read('scripts/macos-release-signing.sh')
/** One value for both ways into the dry run, set once in the job's `env`. */
const DRY = "${{ env.MAC_DRY_RUN == 'true' }}"
const NOT_DRY = "${{ env.MAC_DRY_RUN != 'true' }}"
/** What only the full dry run adds to this job. */
const FULL_DRY = '${{ inputs.dry_run }}'
const MAC_ONLY = "${{ env.MAC_ONLY == 'true' && env.MAC_DRY_RUN != 'true' }}"

const lane = withoutComments(jobBlock(RELEASE_YML, 'build-tauri-macos'))
const gate = withoutComments(jobBlock(CI_YML, 'macos-gate'))

/** The steps of a job, split at `      - ` (six spaces: a step entry). */
const steps = (block: string): string[] => block.split(/\n(?= {6}- )/).slice(1)

const laneSteps = steps(lane)
/** The `if:` of a step (ten spaces deep, next to `name:`), or ''. */
const stepIf = (step: string) => step.match(/^ {8}if:\s*(.*?)\s*$/m)?.[1] ?? ''
/** The secrets a step is handed, by name. */
const secretsOf = (step: string) => [...step.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1])
const stepIndex = (list: string[], test: (step: string) => boolean) => list.findIndex(test)
/** The step that builds and signs: a plain `tauri build`, no action. */
const isBuild = (s: string) => /npm run tauri build\b/.test(s)
/** The step that uploads: tauri-action. */
const isUpload = (s: string) => s.includes('tauri-apps/tauri-action@')

describe('release.yml, the Mac lane can be skipped as a whole', () => {
  it('exists as its own job, outside the build-tauri matrix', () => {
    expect(lane, 'no `build-tauri-macos` job in release.yml').not.toBe('')
    // No Mac runner and no Mac target in the Windows and Linux job. The
    // word itself does occur there since the release text can name the Mac
    // (behind the switch, see below), so the runner label and the target
    // triple are what is looked for.
    const others = withoutComments(jobBlock(RELEASE_YML, 'build-tauri'))
    expect(others).not.toMatch(/macos-(\d+|latest)/i)
    expect(others).not.toMatch(/apple-darwin/i)
    expect(others).not.toMatch(/^\s*-?\s*platform:\s*mac/im)
  })

  it('is switched by a repository variable in the job condition', () => {
    // Four ways in, and only four: the Mac dry run, a full dry run that
    // asks for the Mac, a release with the switch on whose Windows and
    // Linux build is green, or, with the switch on, a Mac-only run for a
    // release that has its Windows and Linux files already. `!cancelled()` replaces the implicit `success()`,
    // so the release branch has to ask for the green build-tauri itself, and
    // it has to rule the full dry run out: build-tauri is green there too.
    const condition = lane.match(/^ {4}if:\s*(.*?)\s*$/m)?.[1] ?? ''
    expect(condition).toBe(
      "${{ !cancelled() && (inputs.mac_dry_run || (inputs.dry_run && inputs.dry_run_mac) || (!inputs.dry_run && vars.LU_MAC_RELEASE == '1' && (needs.build-tauri.result == 'success' || (inputs.mac_only && needs.build-tauri.result == 'skipped')))) }}",
    )
    // `secrets` is not available in a job level `if:`; a condition that names
    // one is always false or a syntax error, depending on the day.
    expect(condition).not.toMatch(/secrets\./)
    expect(condition).not.toMatch(/always\(\)/)
  })

  it('runs on a pinned Apple Silicon image', () => {
    expect(lane).toMatch(/^ {4}runs-on:\s*macos-15\s*$/m)
  })

  it('has no escape hatch that could turn a failed signing green', () => {
    expect(lane).not.toMatch(/continue-on-error/)
    // `|| true` does occur in this job, on cleanup (`kill`) and on commands
    // whose OUTPUT is judged on the next line. What must never carry one is
    // the step that builds and signs.
    const build = laneSteps.find(isBuild) ?? ''
    expect(build).not.toBe('')
    expect(build).not.toMatch(/\|\|\s*true/)
  })
})

describe('release.yml, switched on means fully signed or red', () => {
  const first = steps(lane)[0] ?? ''

  it('checks every secret before anything is built', () => {
    expect(first, 'the first step is not the secret check').toMatch(/Require every signing secret/)
    for (const name of APPLE_SECRETS) {
      expect(first, `${name} is not handed to the check`).toContain(`${name}: \${{ secrets.${name} }}`)
    }
    // The updater key: required in a release, not even read in a dry run.
    expect(first).toContain("TAURI_SIGNING_PRIVATE_KEY: ${{ env.MAC_DRY_RUN != 'true' && secrets.TAURI_SIGNING_PRIVATE_KEY || '' }}")
    // $MAC_DRY_RUN comes from the job's `env`; no step sets a value of its own.
    expect(lane.match(/^\s*MAC_DRY_RUN:/gm) ?? []).toHaveLength(1)
    // Exactly one name is let off, and only by the dry run.
    const skips = first.match(/if \[ "\$name" = (\w+) \] && \[ "\$MAC_DRY_RUN" = true \]; then\s+continue/g) ?? []
    expect(skips).toHaveLength(1)
    expect(skips[0]).toContain('"$name" = TAURI_SIGNING_PRIVATE_KEY ]')
    expect(first.match(/\bcontinue\b/g) ?? []).toHaveLength(1)
    // The list the loop walks is exactly the list that was handed over.
    const walked = first.match(/for name in ([A-Z0-9_\s\\]+?); do/)?.[1].split(/[\s\\]+/).filter(Boolean) ?? []
    expect([...walked].sort()).toEqual([...APPLE_SECRETS, 'TAURI_SIGNING_PRIVATE_KEY'].sort())
    expect(first).toMatch(/exit 1/)
    // It runs before the checkout and so before any script of the repository.
    expect(first).not.toMatch(/uses:|scripts\//)
    expect(stepIf(first)).toBe('')
  })

  it('names a missing secret and never prints a value', () => {
    // The only expansions that reach `echo` are the NAME of the variable
    // and the machine's architecture.
    const echoes = first.split('\n').filter((l) => /\becho\b/.test(l))
    expect(echoes.length).toBeGreaterThan(3)
    for (const line of echoes) {
      for (const name of [...APPLE_SECRETS, 'TAURI_SIGNING_PRIVATE_KEY']) {
        expect(line, line).not.toMatch(new RegExp(`\\$\\{?${name}\\b`))
      }
      expect(line).not.toMatch(/\$\{!name/)
    }
    expect(first).toContain('the secret $name is empty or missing')
    expect(first).not.toMatch(/set -[a-z]*x/)
  })

  it('reads the six secrets the owner enters and no Apple ID', () => {
    const read = new Set(secretsOf(lane))
    for (const name of APPLE_SECRETS) expect(read.has(name), name).toBe(true)
    for (const name of NO_SUCH_SECRETS) {
      expect(read.has(name), `${name} is not a secret of this repository`).toBe(false)
    }
    expect([...read].sort()).toEqual(
      [...APPLE_SECRETS, 'GITHUB_TOKEN', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'].sort(),
    )
  })

  it('hands the bundler the proven identity and the API key, and nothing it would misread', () => {
    const build = laneSteps.find(isBuild) ?? ''
    expect(build, 'no `npm run tauri build` step in the Mac lane').not.toBe('')
    // What tauri-bundler 2.10.1 reads for the API key route (sign.rs,
    // notarize_auth): key ID, issuer ID and the path of the .p8.
    expect(build).toContain("TAURI_SIGNING_PRIVATE_KEY: ${{ env.MAC_DRY_RUN == 'true' && steps.dry-run-key.outputs.key || secrets.TAURI_SIGNING_PRIVATE_KEY }}")
    expect(build).toContain('APPLE_SIGNING_IDENTITY: ${{ steps.keychain.outputs.identity }}')
    expect(build).toContain('APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}')
    expect(build).toContain('APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}')
    // The file notary-key wrote, by the same path the script uses.
    expect(build).toMatch(/^\s*APPLE_API_KEY_PATH:\s*\$\{\{ runner\.temp \}\}\/lu-signing\/AuthKey\.p8\s*$/m)
    expect(SIGNING_SH).toContain('printf \'%s\' "$RUNNER_TEMP/lu-signing"')
    expect(SIGNING_SH).toContain('"$(signing_dir)/AuthKey.p8"')
    // With APPLE_CERTIFICATE the bundler imports the .p12 a second time, into
    // a keychain without the intermediate. With the three Apple ID variables
    // set, even empty, it tries an Apple ID login before it looks at the key.
    for (const name of ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY_P8']) {
      expect(build, `${name} reaches the build step`).not.toMatch(new RegExp(`^\\s*${name}:`, 'm'))
    }
    expect(build).toMatch(/^\s*unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID\s*$/m)
    // No identity, no build: the fallback would be the ad hoc signature.
    const guard = build.indexOf('APPLE_SIGNING_IDENTITY:-}" =~ ^[0-9A-F]{40}$')
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(build.indexOf('npm run tauri build'))
    // The updater artefacts come from the same overlay as on the other lanes.
    expect(build).toMatch(/npm run tauri build -- --config src-tauri\/tauri\.release\.conf\.json\s*$/m)
    // What tauri-action set on macOS when it still ran the build: without
    // it the bundler skips the Finder layout of the .dmg under CI=true.
    expect(build).toMatch(/^\s*TAURI_BUNDLER_DMG_IGNORE_CI:\s*'true'\s*$/m)
  })

  it('pins tauri-action to the same commit as the other lanes', () => {
    const pin = (block: string) => block.match(/tauri-apps\/tauri-action@([0-9a-f]{40})/)?.[1]
    expect(pin(lane)).toBeTruthy()
    expect(pin(lane)).toBe(pin(jobBlock(RELEASE_YML, 'build-tauri')))
  })

  it('judges the signature that was built, not the configuration', () => {
    const verify = steps(lane).find((s) => s.includes('stapler validate')) ?? ''
    expect(verify, 'no step validates the stapled notarization ticket').not.toBe('')
    expect(verify).toContain('codesign --verify --deep --strict')
    expect(verify).toContain('Developer ID Application')
    expect(verify).toContain('com.apple.security.device.audio-input')
  })
})

describe('release.yml, the certificate is proven before anything is compiled', () => {
  const keychain = stepIndex(laneSteps, (s) => /macos-release-signing\.sh keychain\s*$/m.test(s))
  const notary = stepIndex(laneSteps, (s) => s.includes('macos-release-signing.sh notary-key'))
  const firstCompile = stepIndex(laneSteps, (s) => /build-llama\.sh|npm ci|npm run tauri build/.test(s))

  it('imports it into a keychain of the lane right after the checkout', () => {
    expect(keychain).toBeGreaterThan(stepIndex(laneSteps, (s) => s.includes('actions/checkout@')))
    expect(keychain).toBeLessThan(firstCompile)
    const step = laneSteps[keychain]
    expect(step).toMatch(/^ {8}id:\s*keychain\s*$/m)
    // The .p12 and its password are seen by this step and by the check at
    // the top, and by no other.
    expect(secretsOf(step).sort()).toEqual(['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_TEAM_ID'])
    const holders = laneSteps.map((s, i) => (secretsOf(s).includes('APPLE_CERTIFICATE_PASSWORD') ? i : -1)).filter((i) => i >= 0)
    expect(holders).toEqual([0, keychain])
  })

  it('checks the notarization key with Apple before the build as well', () => {
    expect(notary).toBeGreaterThan(keychain)
    expect(notary).toBeLessThan(firstCompile)
    expect(laneSteps[notary]).toContain('macos-release-signing.sh notary-check')
    expect(secretsOf(laneSteps[notary]).sort()).toEqual(['APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_P8'])
    // The content of the .p8 is seen by this step and the check at the top.
    const holders = laneSteps.map((s, i) => (secretsOf(s).includes('APPLE_API_KEY_P8') ? i : -1)).filter((i) => i >= 0)
    expect(holders).toEqual([0, notary])
  })

  it('pins Apple\'s intermediate by address and sha256', () => {
    expect(lane).toMatch(/^ {6}DEVELOPER_ID_G2_URL:\s*'https:\/\/www\.apple\.com\/certificateauthority\/DeveloperIDG2CA\.cer'\s*$/m)
    expect(lane).toMatch(/^ {6}DEVELOPER_ID_G2_SHA256:\s*'[0-9a-f]{64}'\s*$/m)
    // The script takes both from the environment and compares before it
    // imports; a mismatch removes the file and stops.
    const fn = SIGNING_SH.slice(SIGNING_SH.indexOf('\nintermediate() {'), SIGNING_SH.indexOf('\n# ── pick-identity'))
    expect(fn).toContain('need DEVELOPER_ID_G2_URL DEVELOPER_ID_G2_SHA256')
    expect(fn).toContain('shasum -a 256')
    expect(fn).toMatch(/if \[ "\$got" != "\$DEVELOPER_ID_G2_SHA256" \]; then\s+rm -f "\$out"\s+die /)
    expect(SIGNING_SH).not.toMatch(/^DEVELOPER_ID_G2_SHA256=/m)
  })

  it('imports certificate and intermediate, then asks for exactly one valid identity', () => {
    const fn = SIGNING_SH.slice(SIGNING_SH.indexOf('\nkeychain() {'), SIGNING_SH.indexOf('\n# ── notary-key'))
    const order = [
      'security create-keychain',
      'security import "$p12"',
      'intermediate "$cer"',
      'security import "$cer"',
      'security set-key-partition-list',
      'security list-keychains -d user -s "$kc"',
      'security find-identity -v -p codesigning "$kc"',
      'pick_identity "$APPLE_TEAM_ID"',
      'echo "identity=$identity"',
    ].map((needle) => [needle, fn.indexOf(needle)] as const)
    for (const [needle, at] of order) expect(at, needle).toBeGreaterThanOrEqual(0)
    expect(order.map(([, at]) => at)).toEqual([...order.map(([, at]) => at)].sort((a, b) => a - b))
    // The decoded .p12 does not stay on disk next to the keychain.
    expect(fn).toMatch(/rm -f "\$p12"/)
  })

  it('writes the .p8 for the runner user only, and the script never traces', () => {
    const fn = SIGNING_SH.slice(SIGNING_SH.indexOf('\nnotary_key() {'), SIGNING_SH.indexOf('\n# The notarytool arguments'))
    expect(fn).toContain('umask 077')
    expect(fn).toContain('chmod 600 "$key"')
    expect(withoutComments(SIGNING_SH)).not.toMatch(/set -[a-z]*x|set -o xtrace/)
    // No line echoes or prints a secret variable to the log.
    for (const line of withoutComments(SIGNING_SH).split('\n')) {
      if (!/^\s*(echo|die)\b/.test(line)) continue
      expect(line, line).not.toMatch(/\$\{?(APPLE_CERTIFICATE|APPLE_CERTIFICATE_PASSWORD|APPLE_API_KEY_P8|APPLE_API_KEY|APPLE_API_ISSUER|kc_pw)\b/)
    }
  })
})

describe('release.yml, nothing is attached before it was judged', () => {
  const build = stepIndex(laneSteps, isBuild)
  const bundle = stepIndex(laneSteps, (s) => s.includes('scripts/verify-mac-bundle.sh'))
  const signature = stepIndex(laneSteps, (s) => s.includes('spctl --assess'))
  const dmg = stepIndex(laneSteps, (s) => s.includes('macos-release-signing.sh notarize-dmg'))
  const archive = stepIndex(laneSteps, (s) => s.includes('LU.app.tar.gz') && s.includes('CDHash'))
  const cleanup = stepIndex(laneSteps, (s) => s.includes('macos-release-signing.sh cleanup'))
  const artifact = stepIndex(laneSteps, (s) => s.includes('actions/upload-artifact@'))
  const upload = stepIndex(laneSteps, isUpload)

  it('builds, then judges, then uploads, in that order', () => {
    for (const [name, at] of Object.entries({ build, bundle, signature, dmg, archive, cleanup, artifact, upload })) {
      expect(at, `no ${name} step`).toBeGreaterThanOrEqual(0)
    }
    expect(build).toBeLessThan(bundle)
    expect(bundle).toBeLessThan(signature)
    expect(signature).toBeLessThan(dmg)
    expect(dmg).toBeLessThan(archive)
    expect(archive).toBeLessThan(cleanup)
    expect(cleanup).toBeLessThan(artifact)
    expect(artifact).toBeLessThan(upload)
  })

  it('judges every Mach-O file and asks the signature itself whether it is notarized', () => {
    const step = laneSteps[signature]
    expect(step).toMatch(/find "\$app" -type f -print0/)
    expect(step).toContain('*Mach-O*executable*) check_signed "$file_path" runtime')
    // Independent of the runner's Gatekeeper setting, unlike spctl.
    expect(step).toContain("codesign --verify --deep --strict -R='notarized' --check-notarization")
  })

  it('gives the disk image its own ticket before the upload', () => {
    const step = laneSteps[dmg]
    expect(secretsOf(step).sort()).toEqual(['APPLE_API_ISSUER', 'APPLE_API_KEY'])
    expect(step).not.toMatch(/\|\|\s*true/)
    const fn = SIGNING_SH.slice(SIGNING_SH.indexOf('\nnotarize_dmg() {'), SIGNING_SH.indexOf('\n# ── cleanup'))
    const order = [
      'xcrun notarytool submit "$dmg" "${auth[@]}" --wait',
      'if [ "$status" != "Accepted" ]; then',
      'stapler_retry staple "$dmg"',
      'stapler_retry validate "$dmg"',
      'spctl -a -t open --context context:primary-signature',
    ].map((needle) => fn.indexOf(needle))
    for (const at of order) expect(at).toBeGreaterThanOrEqual(0)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // The API key, not an Apple ID.
    expect(SIGNING_SH).toContain('--key "$key" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"')
    expect(withoutComments(SIGNING_SH)).not.toMatch(/--apple-id|--password/)
  })

  it('removes keychain and key whatever happened, before a release token appears', () => {
    const step = laneSteps[cleanup]
    expect(stepIf(step)).toBe('always()')
    expect(secretsOf(step)).toEqual([])
    // Nothing after it signs or notarizes.
    for (const later of laneSteps.slice(cleanup + 1)) {
      expect(later).not.toMatch(/macos-release-signing\.sh|codesign -s|notarytool/)
      for (const name of APPLE_SECRETS) expect(later, name).not.toContain(name)
    }
  })

  it('has exactly one step that can upload, and it builds nothing', () => {
    expect(laneSteps.filter(isUpload)).toHaveLength(1)
    const step = laneSteps[upload]
    // tauri-action runs `<tauriScript> build <args>` and then collects the
    // artefacts by name. A command that does nothing leaves it the upload.
    expect(step).toMatch(/^\s*tauriScript:\s*\/usr\/bin\/true\s*$/m)
    expect(step).toMatch(/^\s*args:\s*--config src-tauri\/tauri\.release\.conf\.json\s*$/m)
    // Nothing is signed there, so it is handed nothing to sign with.
    for (const name of [...APPLE_SECRETS, 'TAURI_SIGNING_PRIVATE_KEY']) {
      expect(step, name).not.toContain(name)
    }
  })

  it('gives no step before the upload a token for the release', () => {
    // The first step is the secret check and runs before the checkout. From
    // the checkout to the upload no step may hold what an upload needs.
    for (const step of laneSteps.slice(1, upload)) {
      expect(step).not.toMatch(/GITHUB_TOKEN|GH_TOKEN/)
      expect(step).not.toMatch(/gh release (upload|create|edit)/)
    }
  })

  it('judges the bundle without the placeholder allowance of the keyless gate', () => {
    expect(laneSteps[bundle]).not.toContain('--allow-stub-sidecar')
    expect(laneSteps[bundle]).not.toMatch(/\|\|\s*true/)
  })

  it('asks the updater archive the same questions as the app', () => {
    const step = laneSteps[archive]
    expect(step).toContain('codesign --verify --deep --strict')
    expect(step).toContain('macos-release-signing.sh stapler validate')
    expect(step).toContain('CDHash')
    expect(step).not.toMatch(/\|\|\s*true/)
  })

  it('only reads latest.json back after the upload', () => {
    const after = laneSteps.slice(upload + 1)
    expect(after).toHaveLength(1)
    expect(after[0]).toContain('latest.json')
  })
})

describe('release.yml, a Mac dry run reaches no release and no other platform', () => {
  const dispatch = RELEASE_YML.slice(RELEASE_YML.indexOf('  workflow_dispatch:'), RELEASE_YML.indexOf('\npermissions:'))
  const upload = stepIndex(laneSteps, isUpload)
  const artifact = stepIndex(laneSteps, (s) => s.includes('actions/upload-artifact@'))

  it('is a boolean input that is off unless someone ticks it', () => {
    const input = dispatch.slice(dispatch.indexOf('      mac_dry_run:'))
    expect(input).toMatch(/^ {8}type:\s*boolean\s*$/m)
    expect(input).toMatch(/^ {8}default:\s*false\s*$/m)
    expect(input).toMatch(/^ {8}required:\s*false\s*$/m)
  })

  it('skips the gate, and with it the Windows and Linux build', () => {
    const gateJob = withoutComments(jobBlock(RELEASE_YML, 'gate'))
    expect(gateJob).toMatch(/^ {4}if:\s*\$\{\{ !inputs\.mac_dry_run && !inputs\.dry_run && !inputs\.mac_only \}\}\s*$/m)
    // build-tauri needs the gate and nothing else, and the one condition
    // that lets it build past a skipped gate asks for `dry_run`, which a Mac
    // dry run does not carry. release-dry-run.test.ts holds the whole line.
    const others = withoutComments(jobBlock(RELEASE_YML, 'build-tauri'))
    expect(others).toMatch(/^ {4}needs:\s*gate\s*$/m)
    const condition = others.match(/^ {4}if:\s*(.*?)\s*$/m)?.[1] ?? ''
    expect(condition).toContain("(inputs.dry_run && needs.gate.result == 'skipped')")
    expect(condition).not.toContain('mac_dry_run')
    expect(condition).not.toMatch(/always\(\)/)
  })

  it('leaves the release flags alone', () => {
    expect(withoutComments(jobBlock(RELEASE_YML, 'enforce-prerelease')))
      .toMatch(/^ {4}if:\s*\$\{\{ always\(\) && !inputs\.mac_dry_run && !inputs\.dry_run \}\}\s*$/m)
    expect(withoutComments(jobBlock(RELEASE_YML, 'demote-on-arrival')))
      .toMatch(/^ {4}if:\s*github\.event_name == 'release'\s*$/m)
  })

  it('attaches the SBOMs and checksums only to a real release', () => {
    expect(withoutComments(jobBlock(RELEASE_YML, 'sbom-and-checksums')))
      .toMatch(/^ {4}if:\s*\$\{\{ always\(\) && !inputs\.mac_dry_run && !inputs\.dry_run && \(needs\.build-tauri\.result == 'success' \|\| \(inputs\.mac_only && needs\.build-tauri-macos\.result == 'success'\)\) \}\}\s*$/m)
  })

  it('has no job besides these six, so none is left unaccounted for', () => {
    const jobs = [...RELEASE_YML.slice(RELEASE_YML.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1])
    expect(jobs.sort()).toEqual(['build-tauri', 'build-tauri-macos', 'demote-on-arrival', 'enforce-prerelease', 'gate', 'sbom-and-checksums'])
  })

  it('builds the commit the run was started on, not a tag', () => {
    const checkout = laneSteps.find((s) => s.includes('actions/checkout@')) ?? ''
    expect(checkout).toContain("ref: ${{ env.MAC_DRY_RUN == 'true' && github.sha || github.event.release.tag_name || github.event.inputs.tag }}")
    expect(checkout).toMatch(/^\s*persist-credentials:\s*false\s*$/m)
  })

  it('skips every step that holds a token for the release', () => {
    const holders = laneSteps.filter((s) => /GITHUB_TOKEN|GH_TOKEN|gh release|tauri-apps\/tauri-action@/.test(s))
    expect(holders).toHaveLength(2)
    for (const step of holders) expect(stepIf(step)).toBe(NOT_DRY)
    expect(holders).toEqual(laneSteps.slice(upload))
  })

  it('keeps the judged files as a short lived artifact instead, and only then', () => {
    const step = laneSteps[artifact]
    expect(stepIf(step)).toBe(DRY)
    for (const file of ['bundle/dmg/*.dmg', 'bundle/macos/LU.app.tar.gz', 'bundle/macos/LU.app.tar.gz.sig']) {
      expect(step, file).toMatch(new RegExp(`^\\s*src-tauri/target/release/${file.replace(/[.*]/g, '\\$&')}\\s*$`, 'm'))
    }
    expect(step).toMatch(/^\s*if-no-files-found:\s*error\s*$/m)
    expect(step).toMatch(/^\s*retention-days:\s*[1-7]\s*$/m)
    expect(secretsOf(step)).toEqual([])
    // Same pin as every other upload-artifact in the repository.
    const pin = (text: string) => text.match(/actions\/upload-artifact@([0-9a-f]{40})/)?.[1]
    expect(pin(step)).toBe(pin(read('.github/workflows/sidecar-windows.yml')))
  })

  it('runs every build and judgement step in both modes', () => {
    // The dry run adds its key, its marker and its artifact and leaves out
    // the two release steps. The full dry run adds two more, for the updater
    // of the build, and a Mac-only run one, which checks the release it adds
    // to. Everything else is the same code path in a dry run and in a
    // release, which is the point.
    const conditional = laneSteps.filter((s) => stepIf(s) !== '').map(stepIf)
    expect(conditional.sort()).toEqual(
      ['always()', DRY, DRY, DRY, NOT_DRY, NOT_DRY, FULL_DRY, FULL_DRY, MAC_ONLY].sort(),
    )
  })
})

describe('release.yml, a Mac-only run adds to an existing release and touches nothing else', () => {
  const dispatch = RELEASE_YML.slice(RELEASE_YML.indexOf('  workflow_dispatch:'), RELEASE_YML.indexOf('\npermissions:'))
  const check = stepIndex(laneSteps, (s) => stepIf(s) === MAC_ONLY)
  const checkout = stepIndex(laneSteps, (s) => s.includes('name: Checkout repository'))
  const upload = stepIndex(laneSteps, isUpload)

  it('is a boolean input that is off unless someone ticks it', () => {
    const input = dispatch.slice(dispatch.indexOf('      mac_only:'))
    expect(input).toMatch(/^ {8}type:\s*boolean\s*$/m)
    expect(input).toMatch(/^ {8}default:\s*false\s*$/m)
    expect(input).toMatch(/^ {8}required:\s*false\s*$/m)
  })

  it('runs neither the gate nor the Windows and Linux build', () => {
    // build-tauri builds only past a green gate, or past a skipped one in a
    // full dry run; a Mac-only run is neither, so build-tauri is skipped.
    expect(withoutComments(jobBlock(RELEASE_YML, 'gate'))).toContain('!inputs.mac_only')
    const condition = withoutComments(jobBlock(RELEASE_YML, 'build-tauri')).match(/^ {4}if:\s*(.*?)\s*$/m)?.[1] ?? ''
    expect(condition).toBe(
      "${{ !cancelled() && (needs.gate.result == 'success' || (inputs.dry_run && needs.gate.result == 'skipped')) }}",
    )
  })

  it('first proves the release is there, with its files, and holds no token for it', () => {
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(checkout)
    const step = laneSteps[check]
    expect(step).toContain('releases/tags/$RELEASE_TAG')
    expect(step).toContain('_x64-setup')
    expect(step).toContain('AppImage')
    expect(step).toContain('latest.json')
    expect(step).toMatch(/rel\.draft/)
    expect(step).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|secrets\./)
    expect(step).not.toMatch(/\|\|\s*true/)
  })

  it('attaches through the one upload step, which proves darwin and the other platforms in latest.json', () => {
    // No upload of its own: the Mac-only run uses the release path of the lane.
    expect(laneSteps.filter(isUpload)).toHaveLength(1)
    expect(laneSteps[upload + 1]).toContain('kept the other platforms')
  })

  it('proves after the upload that nothing but the Mac was added', () => {
    const before = laneSteps[check]
    expect(before).toContain('mac-only-before.json')
    expect(before).toContain('mac-only-latest-before.json')
    const after = laneSteps[upload + 1]
    expect(after).toMatch(/if \[ "\$MAC_ONLY" = true \]; then/)
    expect(after).toContain('mac-only-before.json')
    expect(after).toContain("changed: ' + digest")
    expect(after).toContain("latest.json entry ' + key + ' changed")
    expect(after).toContain("!k.startsWith('darwin-')")
  })

  it('changes nothing for a release or a dry run: every Mac-only step and check asks for the input', () => {
    // The input is read in five places only: the gate, the Mac lane's
    // condition and its MAC_ONLY, the checksums job's condition and its
    // MAC_ONLY.
    expect(withoutComments(RELEASE_YML).match(/inputs\.mac_only/g) ?? []).toHaveLength(5)
    expect(withoutComments(lane).match(/^ {6}MAC_ONLY:\s*\$\{\{ inputs\.mac_only && 'true' \|\| 'false' \}\}\s*$/m)).not.toBeNull()
    expect(withoutComments(jobBlock(RELEASE_YML, 'sbom-and-checksums')))
      .toMatch(/^ {6}MAC_ONLY:\s*\$\{\{ inputs\.mac_only && 'true' \|\| 'false' \}\}\s*$/m)
    // Every use of MAC_ONLY in a step is a guard on that value.
    const uses = withoutComments(RELEASE_YML).split('\n').filter((l) => /MAC_ONLY/.test(l) && !/^ {6}MAC_ONLY:/.test(l))
    for (const line of uses) expect(line).toMatch(/env\.MAC_ONLY == 'true'|"\$MAC_ONLY" = true/)
  })

  it('leaves the Latest flag alone and rebuilds the checksums', () => {
    // enforce-prerelease reads PUBLISHED_TAG, which a dispatch does not set.
    expect(withoutComments(jobBlock(RELEASE_YML, 'enforce-prerelease'))).toContain('PUBLISHED_TAG: ${{ github.event.release.tag_name }}')
    const sums = withoutComments(jobBlock(RELEASE_YML, 'sbom-and-checksums'))
    expect(sums).toContain("inputs.mac_only && needs.build-tauri-macos.result == 'success'")
    expect(sums).toContain('SHA256SUMS.txt lists no .dmg')
    expect(sums).toContain('SHA256SUMS.txt lists no updater archive')
  })
})

describe('release.yml, a full dry run puts the Mac lane into the same mode', () => {
  const build = stepIndex(laneSteps, isBuild)
  const key = stepIndex(laneSteps, (s) => s.includes('tauri signer generate'))
  const rewrite = stepIndex(laneSteps, (s) => s.includes('release-dry-run.mjs rewrite-updater'))
  const check = stepIndex(laneSteps, (s) => s.includes('release-dry-run.mjs check-binaries'))
  const cleanup = stepIndex(laneSteps, (s) => s.includes('macos-release-signing.sh cleanup'))

  it('by one value in the job environment, which is false on a release', () => {
    // 'true' or 'false', never empty: `inputs` is empty on the `release`
    // trigger and the expression then ends in 'false'.
    expect(lane).toMatch(
      /^ {6}MAC_DRY_RUN:\s*\$\{\{ \(inputs\.mac_dry_run \|\| \(inputs\.dry_run && inputs\.dry_run_mac\)\) && 'true' \|\| 'false' \}\}\s*$/m,
    )
  })

  it('and no step asks an input which kind of dry run this is', () => {
    // The two inputs that open the lane are read by the job condition and by
    // that one value. A step that read `mac_dry_run` itself would be a step
    // the full dry run runs in release mode.
    expect(lane.match(/inputs\.mac_dry_run/g) ?? []).toHaveLength(2)
    expect(lane.match(/inputs\.dry_run_mac/g) ?? []).toHaveLength(2)
    for (const step of laneSteps) {
      expect(step).not.toMatch(/inputs\.mac_dry_run|inputs\.dry_run_mac/)
    }
  })

  it('moves the updater away before the build, only in a full dry run', () => {
    expect(rewrite).toBeGreaterThan(key)
    expect(rewrite).toBeLessThan(build)
    expect(stepIf(laneSteps[rewrite])).toBe(FULL_DRY)
    // The public half of the throwaway key, never the private one.
    expect(laneSteps[rewrite]).toContain('"$RUNNER_TEMP/dry-run-updater.key.pub"')
    expect(laneSteps[rewrite]).not.toMatch(/dry-run-updater\.key"/)
    expect(secretsOf(laneSteps[rewrite])).toEqual([])
  })

  it('and reads the built programs before anything is kept', () => {
    expect(check).toBeGreaterThan(build)
    expect(check).toBeLessThan(cleanup)
    expect(stepIf(laneSteps[check])).toBe(FULL_DRY)
    expect(laneSteps[check]).toContain('src-tauri/target/release/bundle/macos/LU.app/Contents/MacOS')
    expect(laneSteps[check]).not.toMatch(/\|\|\s*true/)
    expect(secretsOf(laneSteps[check])).toEqual([])
  })
})

describe('release.yml, a dry run signs its updater archive with a key of its own', () => {
  const build = stepIndex(laneSteps, isBuild)
  const key = stepIndex(laneSteps, (s) => s.includes('tauri signer generate'))
  const marker = stepIndex(laneSteps, (s) => s.includes('> src-tauri/target/release/bundle/DRY-RUN-NOT-FOR-RELEASE.txt'))
  const artifact = stepIndex(laneSteps, (s) => s.includes('actions/upload-artifact@'))
  const cleanup = stepIndex(laneSteps, (s) => s.includes('macos-release-signing.sh cleanup'))

  it('makes the key in the job, the way the Windows signing probe does, and masks it', () => {
    expect(key).toBeGreaterThan(stepIndex(laneSteps, (s) => /^\s*run:\s*npm ci\s*$/m.test(s)))
    expect(key).toBeLessThan(build)
    const step = laneSteps[key]
    expect(stepIf(step)).toBe(DRY)
    expect(step).toMatch(/^ {8}id:\s*dry-run-key\s*$/m)
    expect(secretsOf(step)).toEqual([])
    // Same command as the probe, so one way of making such a key exists.
    const probe = read('.github/workflows/signpath-probe.yml')
    const command = /npx tauri signer generate --ci -w "\$RUNNER_TEMP\/[\w./-]+" > \/dev\/null/
    expect(probe).toMatch(command)
    expect(step).toMatch(command)
    // Masked before it is written anywhere a log could show it, and the
    // command's own output (it prints the key) goes nowhere.
    const mask = step.indexOf('echo "::add-mask::$key"')
    const out = step.indexOf('echo "key=$key" >> "$GITHUB_OUTPUT"')
    expect(mask).toBeGreaterThan(0)
    expect(out).toBeGreaterThan(mask)
    expect(step.split('\n').filter((l) => /\becho "[^"]*\$key\b/.test(l))).toHaveLength(2)
    expect(step).not.toMatch(/set -[a-z]*x/)
    // It lives where the cleanup step removes it.
    expect(step).toContain('"$RUNNER_TEMP/lu-signing/dry-run-updater.key"')
    expect(cleanup).toBeGreaterThan(build)
  })

  it('never lets a dry run sign with the release key, whatever the repository holds', () => {
    const step = laneSteps[build]
    // No password for the throwaway key, and the release's is not read.
    expect(step).toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ env.MAC_DRY_RUN != 'true' && secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '' }}")
    // `a && b || c` falls through to c when b is empty. The step itself
    // therefore compares what it got with the key file of this job.
    const guard = step.indexOf('[ "$TAURI_SIGNING_PRIVATE_KEY" = "$(cat "$RUNNER_TEMP/lu-signing/dry-run-updater.key")" ]')
    expect(guard).toBeGreaterThan(0)
    expect(step.lastIndexOf('if [ "$MAC_DRY_RUN" = true ]; then', guard)).toBeGreaterThan(0)
    expect(guard).toBeLessThan(step.indexOf('npm run tauri build'))
    // And the only steps that read the release key at all are the check at
    // the top and the build, both only outside a dry run.
    const readers = laneSteps.map((s, i) => (secretsOf(s).includes('TAURI_SIGNING_PRIVATE_KEY') ? i : -1)).filter((i) => i >= 0)
    expect(readers).toEqual([0, build])
  })

  it('a release still requires the real key and signs with it', () => {
    const first = laneSteps[0]
    // Outside a dry run the loop walks the updater key like the other six.
    expect(first).toMatch(/APPLE_API_KEY_P8 TAURI_SIGNING_PRIVATE_KEY; do/)
    expect(laneSteps[build]).toContain('|| secrets.TAURI_SIGNING_PRIVATE_KEY }}')
  })

  it('puts a file into the artifact that says the .sig is not a release signature', () => {
    expect(marker).toBeGreaterThan(cleanup)
    expect(marker).toBeLessThan(artifact)
    const step = laneSteps[marker]
    expect(stepIf(step)).toBe(DRY)
    expect(step).toContain('NOT FOR RELEASE')
    expect(step).toMatch(/THROWAWAY updater key/)
    expect(step).toContain('LU.app.tar.gz.sig')
    expect(step).toContain('latest.json')
    // The public half may be shown, the private one is gone by then.
    expect(step).toContain('dry-run-updater.key.pub')
    expect(step).not.toMatch(/dry-run-updater\.key"/)
    expect(laneSteps[artifact]).toMatch(/^\s*src-tauri\/target\/release\/bundle\/DRY-RUN-NOT-FOR-RELEASE\.txt\s*$/m)
  })
})

describe('release.yml, the release text names the Mac only behind the switch', () => {
  /** The text Windows and Linux releases carried before the Mac lane. */
  const BEFORE = [
    '## Download',
    '',
    '**Windows:** Download the `.exe` installer. During setup, choose "Install for current user only" for a portable/no-install experience. Or use the `.msi` for system-wide installation.',
    '',
    '**Linux:** Download the `.AppImage`, make it executable (`chmod +x`), and run. No installation needed.',
    '',
    '> All versions are portable-friendly, no admin rights required. LU by LU Labs.',
  ].join('\n')

  /** The block scalar under `releaseBody: |`, indentation removed. */
  const body = (() => {
    const lines = RELEASE_YML.split(/\r?\n/)
    const start = lines.findIndex((l) => /^ {10}releaseBody: \|$/.test(l))
    const out: string[] = []
    for (let i = start + 1; start >= 0 && i < lines.length; i++) {
      if (lines[i] !== '' && !lines[i].startsWith(' '.repeat(12))) break
      out.push(lines[i].slice(12))
    }
    return out.join('\n').replace(/\n+$/, '')
  })()

  const SWITCHED =
    /\$\{\{ vars\.LU_MAC_RELEASE == '1' && format\('\{0\}\{0\}([^']+)', fromJSON\('"\\n"'\)\) \|\| '' \}\}/

  it('has one expression, and it is the switch', () => {
    expect(body.match(/\$\{\{/g) ?? []).toHaveLength(1)
    expect(body).toMatch(SWITCHED)
  })

  it('with the switch off the text is byte for byte the old one', () => {
    expect(body.replace(SWITCHED, '')).toBe(BEFORE)
  })

  it('with the switch on it adds one paragraph that names what is shipped', () => {
    const on = body.replace(SWITCHED, (_all, text: string) => `\n\n${text}`)
    const paragraphs = on.split('\n\n')
    expect(paragraphs).toHaveLength(BEFORE.split('\n\n').length + 1)
    const mac = paragraphs.find((p) => p.startsWith('**macOS')) ?? ''
    expect(mac).toContain('Apple Silicon')
    expect(mac).toContain('.dmg')
    expect(mac).toMatch(/notarized/)
    expect(mac).toMatch(/Intel Macs are not supported/)
    // Same number as the bundle and both workflows.
    const conf = JSON.parse(read('src-tauri/tauri.macos.conf.json'))
    expect(mac).toContain(`macOS ${String(conf.bundle.macOS.minimumSystemVersion).split('.')[0]} or newer`)
  })

  it('is the only place outside the Mac job that reads the switch', () => {
    const outside = withoutComments(RELEASE_YML.replace(jobBlock(RELEASE_YML, 'build-tauri-macos'), ''))
    expect(outside.match(/LU_MAC_RELEASE/g) ?? []).toHaveLength(1)
  })
})

describe('release.yml, the Mac lane does not race the other platforms', () => {
  it('waits for build-tauri', () => {
    expect(lane).toMatch(/^ {4}needs:\s*build-tauri\s*$/m)
  })

  it('proves darwin-aarch64 landed and every attached platform kept its key', () => {
    // The marker file of a dry run names latest.json too; the check is the
    // step that downloads it. With the SignPath lane the Windows key arrives
    // later (stage 3), so a platform is asked for once its signed updater
    // files hang on the release, not by a fixed list.
    const check = steps(lane).find((s) => s.includes('--pattern latest.json')) ?? ''
    expect(check, 'no step reads latest.json back from the release').not.toBe('')
    for (const key of ['darwin-aarch64', 'windows-x86_64', 'linux-x86_64']) {
      expect(check, key).toContain(`'${key}'`)
    }
    expect(check).toContain('is gone from latest.json')
    expect(check).toMatch(/if \(!assets\.some\(\(n\) => files\.test\(n\)\)\)/)
  })

})

describe('ci.yml, a Mac release is held to a keyless gate', () => {
  it('has a macOS job that tests and bundles', () => {
    expect(gate, 'no `macos-gate` job in ci.yml').not.toBe('')
    expect(gate).toMatch(/^ {4}runs-on:\s*macos-15\s*$/m)
    expect(gate).toMatch(/^\s*run:\s*cargo test\s*$/m)
    expect(gate).toContain('bash scripts/ci-tauri-build.sh')
  })

  it('is on whenever the release lane is on', () => {
    const condition = gate.match(/^ {4}if:.*$/m)?.[0] ?? ''
    expect(condition).toContain("vars.LU_MAC_RELEASE == '1'")
    expect(condition).toContain("vars.LU_MAC_CI == '1'")
    expect(condition).toContain('||')
  })

  it('reads no secret and has no escape hatch', () => {
    expect(gate).not.toMatch(/secrets\./)
    expect(gate).not.toMatch(/continue-on-error/)
    expect(gate).not.toMatch(/\|\|\s*true/)
  })

  it('asks pip for the pins of the four engines, on the Python line of the app', () => {
    expect(gate).toMatch(/^\s*run:\s*bash scripts\/mac-engine-pins-dry-run\.sh\s*$/m)
    const python = JSON.parse(read('src-tauri/resources/voice_loop/python.json')).version as string
    const line = python.split('.').slice(0, 2).join('.')
    expect(gate).toMatch(new RegExp(`^\\s*python-version:\\s*'${line.replace('.', '\\.')}'\\s*$`, 'm'))
  })

  it('runs the image sidecar tests', () => {
    expect(gate).toMatch(/unittest discover .*-s src-tauri\/resources\/mlx\/tests\s*$/m)
  })

  it('bundles the .dmg on the path the release takes, and judges the bundle', () => {
    const gateSteps = steps(gate)
    const build = gateSteps.findIndex((s) => s.includes('bash scripts/ci-tauri-build.sh'))
    const verify = gateSteps.findIndex((s) => s.includes('scripts/verify-mac-bundle.sh'))
    expect(build).toBeGreaterThanOrEqual(0)
    expect(verify).toBeGreaterThan(build)
    expect(gateSteps[build]).toMatch(/^\s*TAURI_BUNDLER_DMG_IGNORE_CI:\s*'true'\s*$/m)
    // The gate bundles with an empty sidecar placeholder and has to say so.
    expect(gateSteps[verify]).toContain('--allow-stub-sidecar')
  })
})

describe('the bundle check and the plist agree on what macOS asks the user', () => {
  const plist = read('src-tauri/Info.plist')
  const script = read('scripts/verify-mac-bundle.sh')
  const required = script.match(/^REQUIRED_PLIST_KEYS="([^"]+)"$/m)?.[1].split(/\s+/) ?? []

  it('requires the microphone and the local network sentence', () => {
    expect(required).toEqual(['NSMicrophoneUsageDescription', 'NSLocalNetworkUsageDescription'])
  })

  it('finds each of them in Info.plist with a sentence', () => {
    for (const key of required) {
      const text = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1] ?? ''
      expect(text.trim().length, key).toBeGreaterThan(20)
    }
  })
})

describe('the bundle check judges every sidecar the Mac bundles', () => {
  // 3.0.8: lu-llama-quantize (A14) joined lu-llama-server. The check read only
  // the first, so a release with an empty quantizer passed it.
  const script = read('scripts/verify-mac-bundle.sh')
  const conf = JSON.parse(read('src-tauri/tauri.macos.conf.json'))

  it('reads the list from tauri.macos.conf.json instead of naming one file', () => {
    expect(script).toContain('conf tauri.macos.conf.json bundle.externalBin')
    expect(script).toMatch(/done <<< "\$sidecars"/)
  })

  it('the list it reads holds both programs', () => {
    expect(conf.bundle.externalBin).toEqual(expect.arrayContaining(['bin/lu-llama-server', 'bin/lu-llama-quantize']))
  })
})

describe('the oldest supported macOS is one number', () => {
  const target = (block: string) => block.match(/^\s*MACOSX_DEPLOYMENT_TARGET:\s*'([\d.]+)'\s*$/m)?.[1]

  it('in both workflows and in the bundle configuration', () => {
    const conf = JSON.parse(read('src-tauri/tauri.macos.conf.json'))
    const minimum = conf.bundle?.macOS?.minimumSystemVersion
    expect(minimum, 'tauri.macos.conf.json names no minimumSystemVersion').toBeTruthy()
    expect(target(lane)).toBe(minimum)
    expect(target(gate)).toBe(minimum)
  })
})

describe('negative controls', () => {
  it('a secret in the job condition is recognised as one', () => {
    const wrong = "    if: secrets.APPLE_CERTIFICATE != ''"
    expect(wrong).toMatch(/secrets\./)
    expect(wrong).not.toMatch(/^ {4}if:\s*vars\.LU_MAC_RELEASE == '1'\s*$/m)
  })

  it('a job without the switch is not found to have it', () => {
    const always = '  build-tauri-macos:\n    needs: build-tauri\n    runs-on: macos-15\n  next:\n'
    expect(withoutComments(jobBlock(always, 'build-tauri-macos'))).not.toMatch(/^ {4}if:/m)
  })

  it('a step condition is read from the step, not from its script', () => {
    const step = "      - name: x\n        if: ${{ env.MAC_DRY_RUN == 'true' }}\n        run: |\n          if: nothing\n"
    expect(stepIf(step)).toBe(DRY)
    expect(stepIf('      - name: x\n        run: |\n          if: nothing\n')).toBe('')
  })

  it('a secret is found wherever a step names it', () => {
    expect(secretsOf('env:\n  A: ${{ secrets.APPLE_ID }}\n  B: ${{ secrets.APPLE_TEAM_ID }}')).toEqual(['APPLE_ID', 'APPLE_TEAM_ID'])
  })
})
