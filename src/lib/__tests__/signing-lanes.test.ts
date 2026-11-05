/**
 * Code signing switches on by secrets, and without them nothing changes.
 *
 * release.yml carries three signing lanes that are prepared but dormant: two
 * for the Windows installers, Azure Artifact Signing and SignPath, of which a
 * release can take only one, and a Developer ID signed, notarized macOS
 * build. The promise this file holds is the one that makes it safe to merge
 * them before any account exists: with no signing secret in the repository, a
 * release run builds what it built before, unsigned Windows and Linux
 * installers and no macOS asset, and stays green. A fork is in that state
 * permanently.
 *
 * Two halves, like release-build-gate.test.ts:
 *
 *   1. Behaviour. scripts/signing-config.sh is the one place that decides
 *      whether a lane is on. It is EXECUTED here in a real bash with the
 *      secret combinations that matter, including the half-filled ones, which
 *      must count as absent and say so. Of scripts/macos-release-signing.sh
 *      the two parts that need neither a keychain nor Apple are executed the
 *      same way: writing the notarization key, and judging the listing of
 *      `security find-identity`.
 *
 *   2. Structure. The workflow conditions every Windows signing step on that
 *      script's answer. The macOS build is not switched by detected secrets:
 *      since the merge of the Mac branch for 3.0.6 it has one lane,
 *      build-tauri-macos, behind the repository variable LU_MAC_RELEASE, and
 *      mac-release-lane.test.ts holds that lane. That lane calls
 *      macos-release-signing.sh for everything that touches an Apple
 *      credential. The macOS half of signing-config.sh stays in the
 *      repository and stays tested here by execution, but release.yml does
 *      not call it.
 *
 * VERIFICATION LIMIT, stated on purpose: no GitHub Actions run was permitted.
 * No lane has ever signed anything. What
 * is proven is the decision logic (by execution), the workflow's syntax
 * (actionlint 1.7.12 with shellcheck 0.11.0) and the structural claims below.
 *
 * Run: npx vitest run src/lib/__tests__/signing-lanes.test.ts
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync, existsSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { bashInterpreter } from '../../api/__tests__/bash-interpreter'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const RELEASE_YML = read('.github/workflows/release.yml')
const BASH = bashInterpreter()

/** The lines of one job, by indentation: jobs sit at two spaces under `jobs:`. */
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

/** Prose removed, so a rule cannot be satisfied by a comment about the rule. */
function withoutComments(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s#.*$/, ''))
    .join('\n')
}

/** One step of a job: from its `- name:` line to the next step. */
function stepBlock(job: string, name: string): string {
  const lines = job.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`)
  if (start < 0) return ''
  const indent = lines[start].indexOf('-')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith(`${' '.repeat(indent)}- `)) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

type Answer = { macos: string; macos_notary: string; windows: string; signpath: string; log: string }

/** Runs signing-config.sh with exactly the given secrets and nothing inherited. */
function decide(secrets: Record<string, string>, scope: 'macos' | 'windows' | null = null): Answer {
  const dir = mkdtempSync(join(tmpdir(), 'signing-config-'))
  const outFile = join(dir, 'out')
  try {
    const log = execFileSync(BASH, [resolve(root, 'scripts/signing-config.sh'), ...(scope ? [scope] : [])], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: outFile, ...secrets },
    })
    const out = Object.fromEntries(
      readFileSync(outFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
        const at = l.indexOf('=')
        return [l.slice(0, at), l.slice(at + 1)]
      }),
    )
    return { macos: out.macos, macos_notary: out.macos_notary, windows: out.windows, signpath: out.signpath, log }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CERT = { APPLE_CERTIFICATE: 'cGxhY2Vob2xkZXI=', APPLE_CERTIFICATE_PASSWORD: 'placeholder' }
const API = { APPLE_API_KEY: 'KEYID', APPLE_API_ISSUER: 'issuer', APPLE_API_KEY_P8: 'placeholder' }
const APPLE_ID = { APPLE_ID: 'someone@example.com', APPLE_PASSWORD: 'placeholder', APPLE_TEAM_ID: 'TEAMID' }
const AZURE = {
  AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 'placeholder',
  ARTIFACT_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
  ARTIFACT_SIGNING_ACCOUNT: 'account', ARTIFACT_SIGNING_PROFILE: 'profile',
}
const SIGNPATH = {
  SIGNPATH_API_TOKEN: 'placeholder', SIGNPATH_ORGANIZATION_ID: '00000000-0000-0000-0000-000000000000',
  SIGNPATH_PROJECT_SLUG: 'project', SIGNPATH_SIGNING_POLICY_SLUG: 'test-signing',
}

// ── 1. Behaviour ───────────────────────────────────────────────────────────

describe('signing-config.sh, executed', () => {
  it('with no secret at all, every lane is off and nothing is warned about', () => {
    const answer = decide({})
    expect(answer).toMatchObject({ macos: 'false', macos_notary: '', windows: 'false', signpath: 'false' })
    expect(answer.log).not.toContain('::warning')
    expect(answer.log).not.toContain('::error')
  })

  it('an empty secret is an absent secret, which is how GitHub hands over a missing one', () => {
    const blank = Object.fromEntries(Object.keys({ ...CERT, ...API, ...APPLE_ID, ...AZURE, ...SIGNPATH }).map((k) => [k, '']))
    expect(decide(blank)).toMatchObject({ macos: 'false', windows: 'false', signpath: 'false' })
  })

  it('macOS switches on with the certificate and an API key', () => {
    expect(decide({ ...CERT, ...API })).toMatchObject({ macos: 'true', macos_notary: 'api', windows: 'false' })
  })

  it('or with the certificate and an Apple ID', () => {
    expect(decide({ ...CERT, ...APPLE_ID })).toMatchObject({ macos: 'true', macos_notary: 'appleid' })
  })

  it('and prefers the API key when both are complete', () => {
    expect(decide({ ...CERT, ...API, ...APPLE_ID }).macos_notary).toBe('api')
  })

  it('a certificate without notarization credentials stays off, with a warning that names what is missing', () => {
    const answer = decide({ ...CERT, APPLE_ID: 'someone@example.com' })
    expect(answer.macos).toBe('false')
    expect(answer.log).toContain('::warning title=macOS signing is off::')
    expect(answer.log).toContain('APPLE_PASSWORD APPLE_TEAM_ID')
  })

  it('notarization credentials without the certificate stay off, with a warning', () => {
    const answer = decide({ ...API })
    expect(answer.macos).toBe('false')
    expect(answer.log).toContain('::warning title=macOS signing is off::')
    expect(answer.log).toContain('APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD')
  })

  it('Azure switches on only with all six values', () => {
    expect(decide({ ...AZURE })).toMatchObject({ windows: 'true', signpath: 'false', macos: 'false' })
    for (const leftOut of Object.keys(AZURE)) {
      const partial: Record<string, string> = { ...AZURE }
      delete partial[leftOut]
      const answer = decide(partial)
      expect(answer.windows, leftOut).toBe('false')
      expect(answer.log, leftOut).toContain('::warning title=Azure Artifact Signing is off::')
      expect(answer.log, leftOut).toContain(leftOut)
    }
  })

  it('SignPath switches on only with the token and all three identifiers', () => {
    expect(decide({ ...SIGNPATH })).toMatchObject({ signpath: 'true', windows: 'false', macos: 'false' })
    for (const leftOut of Object.keys(SIGNPATH)) {
      const partial: Record<string, string> = { ...SIGNPATH }
      delete partial[leftOut]
      const answer = decide(partial)
      expect(answer.signpath, leftOut).toBe('false')
      expect(answer.log, leftOut).toContain('::warning title=SignPath signing is off::')
      expect(answer.log, leftOut).toContain(leftOut)
    }
  })

  it('with both Windows lanes complete the run stops, and says why in English', () => {
    // execFileSync throws on a non-zero exit; stdout carries the annotation.
    let stopped: { status?: number; stdout?: string } = {}
    try {
      decide({ ...AZURE, ...SIGNPATH }, 'windows')
    } catch (error) {
      stopped = error as typeof stopped
    }
    expect(stopped.status).toBe(1)
    expect(stopped.stdout).toContain('::error title=Two Windows signing lanes are configured::')
    expect(stopped.stdout).toContain('signed by exactly one of them')
  })

  it('a half-filled second lane does not stop the complete one', () => {
    const azure = decide({ ...AZURE, SIGNPATH_ORGANIZATION_ID: 'o' }, 'windows')
    expect(azure).toMatchObject({ windows: 'true', signpath: 'false' })
    expect(azure.log).toContain('::warning title=SignPath signing is off::')
    const signpath = decide({ ...SIGNPATH, AZURE_TENANT_ID: 't' }, 'windows')
    expect(signpath).toMatchObject({ windows: 'false', signpath: 'true' })
    expect(signpath.log).toContain('::warning title=Azure Artifact Signing is off::')
  })

  it('asked for one lane, it answers and warns for that lane alone', () => {
    // release.yml hands each job only its own secrets. The macOS job must not
    // report on Windows, and a half-filled Azure set is not its business.
    const everything = { ...CERT, ...API, AZURE_TENANT_ID: 't' }
    const mac = decide(everything, 'macos')
    expect(mac).toMatchObject({ macos: 'true', macos_notary: 'api' })
    expect(mac.windows).toBeUndefined()
    expect(mac.signpath).toBeUndefined()
    expect(mac.log).not.toContain('Windows')
    const win = decide({ ...AZURE, APPLE_ID: 'someone@example.com' }, 'windows')
    expect(win.windows).toBe('true')
    expect(win.macos).toBeUndefined()
    expect(win.log).not.toContain('macOS')
  })

  it('never prints a value it was given', () => {
    const marked = Object.fromEntries(
      Object.keys({ ...CERT, ...API, ...APPLE_ID, ...AZURE }).map((k) => [k, `SECRET-VALUE-OF-${k}`]),
    )
    const answer = decide(marked)
    expect(answer.log).not.toContain('SECRET-VALUE-OF-')
    const signpath = Object.fromEntries(Object.keys(SIGNPATH).map((k) => [k, `SECRET-VALUE-OF-${k}`]))
    expect(decide(signpath).log).not.toContain('SECRET-VALUE-OF-')
  })
})

describe('the notarization key, written by execution', () => {
  const SCRIPT = resolve(root, 'scripts/macos-release-signing.sh')
  // A real P-256 key made for this run, the kind App Store Connect hands out
  // as a .p8. It signs nothing and exists nowhere else.
  const P8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim()

  /** Runs `notary-key` in an empty RUNNER_TEMP; returns what it left there. */
  function notaryKey(secret: string): { log: string; key: string | null; mode: number | null } {
    const dir = mkdtempSync(join(tmpdir(), 'notary-key-'))
    const keyPath = join(dir, 'lu-signing', 'AuthKey.p8')
    try {
      let log: string
      try {
        log = execFileSync(BASH, [SCRIPT, 'notary-key'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH ?? '', RUNNER_TEMP: dir, APPLE_API_KEY_P8: secret },
        })
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string }
        log = `FAILED\n${e.stdout ?? ''}${e.stderr ?? ''}`
      }
      const there = existsSync(keyPath)
      return {
        log,
        key: there ? readFileSync(keyPath, 'utf8') : null,
        mode: there ? statSync(keyPath).mode & 0o777 : null,
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('writes the .p8 as it was downloaded, readable by the runner user only', () => {
    const { log, key, mode } = notaryKey(P8)
    expect(log).not.toContain('FAILED')
    expect(key?.trim()).toBe(P8)
    // Windows has no such mode bits; the lane only ever runs on macOS.
    if (process.platform !== 'win32') expect(mode).toBe(0o600)
  })

  it('also takes the key file as base64', () => {
    const { log, key } = notaryKey(Buffer.from(`${P8}\n`, 'utf8').toString('base64'))
    expect(log).not.toContain('FAILED')
    expect(key?.trim()).toBe(P8)
  })

  it('refuses what is not a key, leaves no file behind and prints no value', () => {
    for (const wrong of ['SECRET-VALUE-NOT-A-KEY', Buffer.from('SECRET-VALUE-NOT-A-KEY').toString('base64')]) {
      const { log, key } = notaryKey(wrong)
      expect(log).toContain('FAILED')
      expect(log).toContain('APPLE_API_KEY_P8')
      expect(log).not.toContain('SECRET-VALUE')
      expect(key).toBeNull()
    }
  })

  it('refuses a key that lost its line breaks on the way into the secret', () => {
    // The classic paste accident: markers present, body on one line with them.
    const { log, key } = notaryKey(P8.replace(/\n/g, ' '))
    expect(log).toContain('FAILED')
    expect(log).toContain('does not parse as a private key')
    expect(key).toBeNull()
  })

  it('never prints the key', () => {
    const body = P8.split('\n')[1]
    expect(notaryKey(P8).log).not.toContain(body)
  })
})

describe('the signing identity, judged by execution', () => {
  const SCRIPT = resolve(root, 'scripts/macos-release-signing.sh')
  const TEAM = 'ABCDE12345'
  const SHA = '0123456789ABCDEF0123456789ABCDEF01234567'
  const OTHER = 'FEDCBA9876543210FEDCBA9876543210FEDCBA98'
  /** A line as `security find-identity -v -p codesigning` prints it. */
  const row = (n: number, sha: string, name: string) => `  ${n}) ${sha} "${name}"`
  const footer = (n: number) => `     ${n} valid identities found`

  function pick(listing: string, team = TEAM): { ok: boolean; out: string } {
    try {
      const out = execFileSync(BASH, [SCRIPT, 'pick-identity', team], {
        encoding: 'utf8',
        input: listing,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '' },
      })
      return { ok: true, out: out.trim() }
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string }
      return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  }

  it('one valid Developer ID Application of the team: its SHA-1, and nothing else', () => {
    const got = pick([row(1, SHA, `Developer ID Application: Jane Doe (${TEAM})`), footer(1)].join('\n'))
    expect(got).toEqual({ ok: true, out: SHA })
  })

  it('no valid identity (a chain that does not validate lists none) is refused', () => {
    const got = pick(footer(0))
    expect(got.ok).toBe(false)
    expect(got.out).toContain('no valid code signing identity')
  })

  it('two valid identities are refused: codesign would have to guess', () => {
    const got = pick([
      row(1, SHA, `Developer ID Application: Jane Doe (${TEAM})`),
      row(2, OTHER, `Developer ID Application: Jane Doe (${TEAM})`),
      footer(2),
    ].join('\n'))
    expect(got.ok).toBe(false)
    expect(got.out).toContain('expected exactly one')
  })

  it('another kind of certificate is refused, whatever its team', () => {
    for (const name of [`Apple Development: Jane Doe (${TEAM})`, `Developer ID Installer: Jane Doe (${TEAM})`, `Mac App Distribution: Jane Doe (${TEAM})`]) {
      const got = pick([row(1, SHA, name), footer(1)].join('\n'))
      expect(got.ok, name).toBe(false)
      expect(got.out, name).toContain('not a Developer ID Application certificate')
    }
  })

  it('a Developer ID Application of another team is refused', () => {
    const got = pick([row(1, SHA, 'Developer ID Application: Jane Doe (ZZZZZ99999)'), footer(1)].join('\n'))
    expect(got.ok).toBe(false)
    expect(got.out).toContain('another team')
  })

  it('a team ID that is no team ID is refused before it is used as a pattern', () => {
    const got = pick([row(1, SHA, `Developer ID Application: Jane Doe (${TEAM})`), footer(1)].join('\n'), '.*')
    expect(got.ok).toBe(false)
  })
})

describe('stapler, retried by execution', () => {
  // stapler fetches the ticket from Apple's CloudKit. The 3.0.10 Mac job lost
  // that connection five times in a row; a stand-in xcrun plays it here.
  const SCRIPT = resolve(root, 'scripts/macos-release-signing.sh')
  function run(failures: number, message: string, tries = 3): { ok: boolean; out: string; calls: number } {
    const dir = mkdtempSync(join(tmpdir(), 'lu-stapler-'))
    try {
      writeFileSync(
        join(dir, 'xcrun'),
        [
          '#!/bin/bash',
          'n=$(cat "$(dirname "$0")/calls" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$(dirname "$0")/calls"',
          `if [ $n -le ${failures} ]; then echo '${message}'; exit 68; fi`,
          'echo "The $2 action worked!"',
        ].join('\n'),
      )
      chmodSync(join(dir, 'xcrun'), 0o755)
      const env = { PATH: `${dir}:${process.env.PATH ?? ''}`, STAPLER_TRIES: String(tries), STAPLER_PAUSE: '0' }
      const calls = () => Number(existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : 0)
      try {
        const out = execFileSync(BASH, [SCRIPT, 'stapler', 'staple', join(dir, 'LU.dmg')], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        })
        return { ok: true, out, calls: calls() }
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string }
        return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, calls: calls() }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const LOST = 'The network connection was lost. The staple and validate action failed! Error 68.'

  it('a lost connection is tried again, and every try is in the log', () => {
    const got = run(2, LOST)
    expect(got.ok).toBe(true)
    expect(got.calls).toBe(3)
    expect(got.out).toContain('failed on try 1 of 3')
    expect(got.out).toContain('OK on try 3 of 3')
  })

  it('gives up after the last try', () => {
    const got = run(5, LOST)
    expect(got.ok).toBe(false)
    expect(got.calls).toBe(3)
    expect(got.out).toContain('failed 3 times')
  })

  it('a file without a ticket is not tried again', () => {
    const got = run(5, 'LU.dmg does not have a ticket stapled to it.')
    expect(got.ok).toBe(false)
    expect(got.calls).toBe(1)
  })
})

// ── 2. Structure ───────────────────────────────────────────────────────────

describe('release.yml signs only where signing-config.sh said yes', () => {
  const build = jobBlock(RELEASE_YML, 'build-tauri')
  const mac = jobBlock(RELEASE_YML, 'build-tauri-macos')

  it('there is one macOS lane, and it is the one behind the switch', () => {
    // Two lanes that both attach Mac assets to one release would race on
    // latest.json and could ship the unjudged build next to the judged one.
    expect(jobBlock(RELEASE_YML, 'build-macos'), 'a second macOS job is back in release.yml').toBe('')
    expect(jobBlock(RELEASE_YML, 'signing-config'), 'the secrets probe that only served the second macOS job is back').toBe('')
    expect(mac, 'no `build-tauri-macos` job in release.yml').not.toBe('')
    // The switch for a release; a dry run is the one other way in
    // (mac-release-lane.test.ts holds the whole condition).
    const condition = withoutComments(mac).match(/^ {4}if:.*$/m)?.[0] ?? ''
    expect(condition).toContain("vars.LU_MAC_RELEASE == '1'")
    expect(condition).not.toMatch(/secrets\./)
    expect(withoutComments(RELEASE_YML)).not.toContain('signing-config.sh macos')
  })

  it('and has no unsigned fallback: the build step refuses to run without the proven identity', () => {
    const step = stepBlock(mac, 'Build, sign and notarize the Mac app (no upload)')
    // The identity is the one the keychain step proved, not a secret a
    // person typed, and the step stops when it did not arrive: the bundler
    // would otherwise fall back to the ad hoc identity of tauri.conf.json.
    expect(step).toContain('APPLE_SIGNING_IDENTITY: ${{ steps.keychain.outputs.identity }}')
    expect(step).toMatch(/\[\[ "\$\{APPLE_SIGNING_IDENTITY:-\}" =~ \^\[0-9A-F\]\{40\}\$ \]\]/)
    expect(withoutComments(mac)).not.toMatch(/continue-on-error/)
  })

  it('the Windows signing steps are skipped without the Azure secrets', () => {
    const condition = "if: matrix.platform == 'windows-latest' && steps.signcfg.outputs.windows == 'true'"
    expect(stepBlock(build, 'Configure Windows code signing (Azure Artifact Signing)')).toContain(condition)
    expect(stepBlock(build, 'Verify the Windows signatures')).toContain(condition)
    expect(stepBlock(build, 'Which Windows signing secrets are present')).toContain('bash scripts/signing-config.sh windows')
  })

  it('the SignPath steps are skipped without the SignPath values', () => {
    const condition = "if: matrix.platform == 'windows-latest' && steps.signcfg.outputs.signpath == 'true'"
    const sign = stepBlock(build, 'Build the app and submit it to SignPath (stage 1)')
    expect(sign).toContain(condition)
    expect(sign).toContain('uses: ./.github/actions/windows-signpath')
    // Stage 1 publishes nothing; attaching is stage 3, in windows-signpath.yml.
    expect(stepBlock(build, 'Attach the signed Windows installers and update latest.json')).toBe('')
    expect(read('.github/workflows/windows-signpath.yml')).toContain('- name: Attach the signed Windows installers and update latest.json')
    // The token is handed to that one step and to the detection, nowhere else.
    const tokenLines = withoutComments(RELEASE_YML).split(/\r?\n/).filter((l) => l.includes('secrets.SIGNPATH_API_TOKEN'))
    expect(tokenLines.map((l) => l.trim()).sort()).toEqual([
      'SIGNPATH_API_TOKEN: ${{ secrets.SIGNPATH_API_TOKEN }}',
      'api-token: ${{ secrets.SIGNPATH_API_TOKEN }}',
    ])
  })

  it('the ordinary build step runs on every leg unless SignPath signs the Windows one', () => {
    // SignPath signs after the build, so on that lane tauri-action must not
    // publish the unsigned installers and the updater signatures over them.
    // With the detection skipped (Linux) or answering false, the condition is
    // true and the step is the one that always ran. A dry run is the one
    // other run it stays out of: this is the step that publishes.
    const step = stepBlock(build, 'Build and release Tauri app')
    expect(withoutComments(step)).toMatch(
      /^\s*if: \$\{\{ !inputs\.dry_run && \(matrix\.platform != 'windows-latest' \|\| steps\.signcfg\.outputs\.signpath != 'true'\) \}\}\s*$/m,
    )
  })

  it('a dry run signs nothing for Windows, whatever the repository holds', () => {
    // The detection does not even run, so no signing secret is read and both
    // answers stay empty. Each signing step says it once more itself.
    expect(stepBlock(build, 'Which Windows signing secrets are present'))
      .toContain("if: matrix.platform == 'windows-latest' && !inputs.dry_run")
    for (const name of [
      'Configure Windows code signing (Azure Artifact Signing)',
      'Verify the Windows signatures',
      'Build the app and submit it to SignPath (stage 1)',
    ]) {
      expect(stepBlock(build, name), name).toMatch(/^\s*if: .* && !inputs\.dry_run\s*$/m)
    }
  })

  it('a release never accepts the self-signed test certificate', () => {
    // The certificate is checked where the signed installers come back:
    // stage 3, the publish job of windows-signpath.yml.
    const stages = read('.github/workflows/windows-signpath.yml')
    const publish = withoutComments(jobBlock(stages, 'publish'))
    const finish = stepBlock(publish, 'Fetch the signed installers and write their updater files')
    expect(finish).toContain('uses: ./.github/actions/windows-signpath-finish')
    expect(finish).not.toContain('allow-test-certificate')
    expect(finish).toMatch(/expected-publisher: \$\{\{ vars\.SIGNPATH_EXPECTED_PUBLISHER \|\| 'SignPath Foundation' \}\}/)
    expect(withoutComments(stages)).not.toContain('allow-test-certificate')
    const action = read('.github/actions/windows-signpath-finish/action.yml')
    expect(action).toMatch(/allow-test-certificate:\n(?:.*\n)*?\s+default: 'false'/)
  })

  it('the job keeps its 90 minutes, the SignPath leg 120 because it builds llama.cpp from source, and nothing waits for an approval', () => {
    expect(withoutComments(build)).toMatch(
      /^\s{4}timeout-minutes: \$\{\{ matrix\.platform == 'windows-latest' && vars\.SIGNPATH_SIGNING_POLICY_SLUG != '' && 120 \|\| 90 \}\}\s*$/m,
    )
    for (const action of ['windows-signpath', 'windows-signpath-installers']) {
      const text = withoutComments(read(`.github/actions/${action}/action.yml`))
      expect(text, action).toMatch(/^\s+wait-for-completion: false$/m)
      expect(text, action).not.toMatch(/wait-for-completion: true/)
    }
  })

  it('and then the build gets the arguments it always got', () => {
    // A skipped step has no outputs, so the trailing expression is empty and
    // the only --config left is the updater overlay.
    const step = stepBlock(build, 'Build and release Tauri app')
    expect(withoutComments(step)).toMatch(
      /^\s*args: --config src-tauri\/tauri\.release\.conf\.json \$\{\{ matrix\.args \}\} \$\{\{ steps\.winsign\.outputs\.config_args \}\}\s*$/m,
    )
    expect(read('scripts/windows-signing-setup.ps1')).toContain('"config_args=--config $overlayRel"')
  })

  it('no checked-in config carries a sign command or a certificate', () => {
    for (const f of ['tauri.conf.json', 'tauri.windows.conf.json', 'tauri.release.conf.json']) {
      const windows = JSON.parse(read(`src-tauri/${f}`)).bundle?.windows ?? {}
      expect(windows.signCommand, f).toBeUndefined()
      expect(windows.certificateThumbprint, f).toBeUndefined()
    }
    // The overlay is written at build time and must never be committed.
    expect(read('.gitignore')).toMatch(/^src-tauri\/tauri\.signing\.conf\.json$/m)
  })

  it('the checked-in macOS identity stays ad hoc, the real one comes from the environment', () => {
    // "-" is what makes a local build carry a verifiable signature so macOS
    // keeps its permission answers (2e125131). A team's identity in this file
    // would break every build that does not own that certificate.
    // APPLE_SIGNING_IDENTITY overrides it in the release job.
    expect(JSON.parse(read('src-tauri/tauri.conf.json')).bundle.macOS.signingIdentity).toBe('-')
  })

  it('the SignPath stages sign the binary before the installers, and the updater files last', () => {
    // One stage per action, in this order; each ends with a submitted
    // request or, the last, with the verified files.
    const text = ['windows-signpath', 'windows-signpath-installers', 'windows-signpath-finish']
      .map((a) => read(`.github/actions/${a}/action.yml`)).join('\n')
    const order = [
      'npx tauri build --no-bundle',
      'windows-signpath.mjs stage-app',
      'id: sign-app',
      'signpath-stages.mjs download-signed "$REQUEST_ID" "$RUNNER_TEMP/signpath/app-signed"',
      'npx tauri bundle --bundles "$kind"',
      'windows-signpath.mjs stage-installers',
      'id: sign-installers',
      'signpath-stages.mjs download-signed "$REQUEST_ID" "$RUNNER_TEMP/signpath/installers-signed"',
      'windows-signpath.mjs updater-artifacts',
      'npx tauri signer sign',
      './scripts/windows-signing-verify.ps1',
    ].map((needle) => ({ needle, at: text.indexOf(needle) }))
    for (const { needle, at } of order) expect(at, needle).toBeGreaterThan(0)
    expect(order.map((o) => o.at)).toEqual([...order.map((o) => o.at)].sort((a, b) => a - b))
    // Third party actions by commit, like everywhere else in the workflows.
    for (const uses of text.match(/^\s*uses: .*$/gm) ?? []) {
      expect(uses, uses).toMatch(/@[0-9a-f]{40} # v\d/)
    }
    expect(withoutComments(text)).not.toMatch(/continue-on-error/)
  })

  it('the artifact configurations sign this project\'s own files and nothing else', () => {
    const app = read('.signpath/artifact-configurations/windows-app.xml')
    const installers = read('.signpath/artifact-configurations/windows-installers.xml')
    // The binary name is the cargo package name, which is what the script stages.
    const cargoName = /^name = "([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))?.[1]
    expect(app.match(/<pe-file path="([^"]+)"/g)).toEqual([`<pe-file path="${cargoName}.exe"`, `<pe-file path="${cargoName}.exe"`])
    // The product name Windows builds carry, enforced as SignPath asks.
    const productName = JSON.parse(read('src-tauri/tauri.windows.conf.json')).productName
    for (const xml of [app, installers]) {
      expect(xml).toContain(`product-name="${productName}" product-version="\${version}"`)
      expect(xml).not.toMatch(/path="[^"]*(\*\*|llama|ggml)/)
    }
    expect(installers).toContain(`path="${productName}_\${version}_x64-setup.exe"`)
    expect(installers).toContain(`path="${productName}_\${version}_x64_en-US.msi"`)
  })

  it('the probe workflow publishes nothing and never uses the release updater key', () => {
    const probe = withoutComments(read('.github/workflows/signpath-probe.yml'))
    expect(probe).toMatch(/^on:\n\s+workflow_dispatch:/m)
    expect(probe).not.toMatch(/^\s+(release|push|pull_request|schedule):/m)
    expect(probe).toMatch(/^permissions:\n\s+contents: read\n\s+actions: read$/m)
    for (const forbidden of ['TAURI_SIGNING_PRIVATE_KEY', 'gh release', 'tauri-action', 'latest.json', 'GITHUB_TOKEN']) {
      expect(probe, forbidden).not.toContain(forbidden)
    }
    expect(probe).toContain('uses: ./.github/actions/windows-signpath')
  })

  it('the release stays out of Latest until every build job is through', () => {
    expect(jobBlock(RELEASE_YML, 'enforce-prerelease')).toMatch(/^\s*needs:\s*\[build-tauri, build-tauri-macos\]\s*$/m)
  })
})
