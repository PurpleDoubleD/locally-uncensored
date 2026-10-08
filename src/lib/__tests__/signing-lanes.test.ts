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
 *      must count as absent and say so. The notarization hand-over of
 *      scripts/macos-release-signing.sh is executed the same way.
 *
 *   2. Structure. The workflow conditions every signing step on that script's
 *      answer and has no other path to a signature or to a macOS build.
 *
 * VERIFICATION LIMIT, stated on purpose: no GitHub Actions run was permitted
 * and no certificate exists yet. No lane has ever signed anything. What
 * is proven is the decision logic (by execution), the workflow's syntax
 * (actionlint 1.7.12 with shellcheck 0.11.0) and the structural claims below.
 *
 * Run: npx vitest run src/lib/__tests__/signing-lanes.test.ts
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
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

describe('the notarization hand-over, executed', () => {
  // tauri-bundler tests the Apple ID variables for "is set" before it looks at
  // the API key, so an empty APPLE_ID next to a real API key would be used.
  // `prepare` must export one set and leave the other names out entirely.
  function prepare(env: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'notary-env-'))
    const envFile = join(dir, 'env')
    try {
      execFileSync(BASH, [resolve(root, 'scripts/macos-release-signing.sh'), 'prepare'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', GITHUB_ENV: envFile, RUNNER_TEMP: dir, ...env },
      })
      const written = readFileSync(envFile, 'utf8')
      const keyLine = written.split(/\r?\n/).find((l) => l.startsWith('APPLE_API_KEY_PATH='))
      if (keyLine) {
        const keyPath = keyLine.slice('APPLE_API_KEY_PATH='.length)
        expect(existsSync(keyPath)).toBe(true)
        expect(readFileSync(keyPath, 'utf8')).toContain('BEGIN PRIVATE KEY')
      }
      return written
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // Not a key: a marker between the two PEM lines the script looks for.
  const P8 = '-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----'
  const all = {
    NOTARY_API_KEY: 'KEYID', NOTARY_API_ISSUER: 'issuer', NOTARY_API_KEY_P8: P8,
    NOTARY_APPLE_ID: 'someone@example.com', NOTARY_APPLE_PASSWORD: 'placeholder', EXPECTED_TEAM_ID: 'TEAMID',
  }
  const names = (written: string) => written.split(/\r?\n/).filter(Boolean).map((l) => l.slice(0, l.indexOf('='))).sort()

  it('api mode exports the API key set and no Apple ID variable', () => {
    expect(names(prepare({ ...all, NOTARY_MODE: 'api' }))).toEqual(['APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_PATH'])
  })

  it('api mode also takes the key file as base64', () => {
    const encoded = Buffer.from(P8, 'utf8').toString('base64')
    expect(names(prepare({ ...all, NOTARY_API_KEY_P8: encoded, NOTARY_MODE: 'api' }))).toContain('APPLE_API_KEY_PATH')
  })

  it('appleid mode exports the Apple ID set and no API key variable', () => {
    expect(names(prepare({ ...all, NOTARY_MODE: 'appleid' }))).toEqual(['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'])
  })

  it('refuses a mode it was not told', () => {
    expect(() => prepare({ ...all, NOTARY_MODE: '' })).toThrow()
  })
})

// ── 2. Structure ───────────────────────────────────────────────────────────

describe('release.yml signs only where signing-config.sh said yes', () => {
  const build = jobBlock(RELEASE_YML, 'build-tauri')
  const mac = jobBlock(RELEASE_YML, 'build-macos')
  const config = jobBlock(RELEASE_YML, 'signing-config')

  it('the macOS job exists only behind the detected secrets', () => {
    expect(mac, 'no `build-macos` job in release.yml').not.toBe('')
    expect(withoutComments(mac)).toMatch(/^\s{4}if:\s*needs\.signing-config\.outputs\.macos == 'true'\s*$/m)
    expect(withoutComments(mac)).toMatch(/^\s{4}needs:\s*\[gate, signing-config\]\s*$/m)
    expect(config).toContain('bash scripts/signing-config.sh macos')
  })

  it('and has no unsigned fallback: the build step always carries the certificate', () => {
    const step = stepBlock(mac, 'Build, sign, notarize and release the macOS app')
    expect(step).toContain('APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}')
    expect(step).toMatch(/APPLE_SIGNING_IDENTITY: \$\{\{ secrets\.APPLE_SIGNING_IDENTITY \|\| 'Developer ID Application' \}\}/)
    // The notarization variables reach the build through $GITHUB_ENV only.
    for (const name of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH']) {
      expect(withoutComments(step), name).not.toMatch(new RegExp(`^\\s*${name}:`, 'm'))
    }
  })

  it('the macOS job proves its result before it replaces the disk image', () => {
    const finish = mac.indexOf('bash scripts/macos-release-signing.sh finish')
    const upload = mac.indexOf('gh release upload')
    expect(finish).toBeGreaterThan(0)
    expect(upload).toBeGreaterThan(finish)
    expect(withoutComments(mac)).not.toMatch(/continue-on-error/)
    expect(withoutComments(mac)).not.toMatch(/\|\|\s*true/)
  })

  it('the Windows signing steps are skipped without the Azure secrets', () => {
    const condition = "if: matrix.platform == 'windows-latest' && steps.signcfg.outputs.windows == 'true'"
    expect(stepBlock(build, 'Configure Windows code signing (Azure Artifact Signing)')).toContain(condition)
    expect(stepBlock(build, 'Verify the Windows signatures')).toContain(condition)
    expect(stepBlock(build, 'Which Windows signing secrets are present')).toContain('bash scripts/signing-config.sh windows')
  })

  it('the SignPath steps are skipped without the SignPath values', () => {
    const condition = "if: matrix.platform == 'windows-latest' && steps.signcfg.outputs.signpath == 'true'"
    const sign = stepBlock(build, 'Build and sign the Windows installers (SignPath)')
    expect(sign).toContain(condition)
    expect(sign).toContain('uses: ./.github/actions/windows-signpath')
    expect(stepBlock(build, 'Attach the signed Windows installers and update latest.json')).toContain(condition)
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
    // true and the step is the one that always ran.
    const step = stepBlock(build, 'Build and release Tauri app')
    expect(withoutComments(step)).toMatch(
      /^\s*if: matrix\.platform != 'windows-latest' \|\| steps\.signcfg\.outputs\.signpath != 'true'\s*$/m,
    )
  })

  it('a release never accepts the self-signed test certificate', () => {
    const sign = withoutComments(stepBlock(build, 'Build and sign the Windows installers (SignPath)'))
    expect(sign).not.toContain('allow-test-certificate')
    expect(sign).toMatch(/expected-publisher: \$\{\{ vars\.SIGNPATH_EXPECTED_PUBLISHER \|\| 'SignPath Foundation' \}\}/)
    const action = read('.github/actions/windows-signpath/action.yml')
    expect(action).toMatch(/allow-test-certificate:\n(?:.*\n)*?\s+default: 'false'/)
  })

  it('the job keeps its 90 minutes unless the SignPath lane has to wait for an approval', () => {
    expect(withoutComments(build)).toMatch(
      /^\s{4}timeout-minutes: \$\{\{ matrix\.platform == 'windows-latest' && vars\.SIGNPATH_SIGNING_POLICY_SLUG != '' && 360 \|\| 90 \}\}\s*$/m,
    )
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

  it('the SignPath action signs the binary before the installers, and the updater files last', () => {
    const action = read('.github/actions/windows-signpath/action.yml')
    const order = [
      'npx tauri build --no-bundle',
      'windows-signpath.mjs stage-app',
      'id: sign-app',
      'npx tauri bundle --bundles "$kind"',
      'windows-signpath.mjs stage-installers',
      'id: sign-installers',
      'windows-signpath.mjs updater-artifacts',
      'npx tauri signer sign',
      './scripts/windows-signing-verify.ps1',
    ].map((needle) => ({ needle, at: action.indexOf(needle) }))
    for (const { needle, at } of order) expect(at, needle).toBeGreaterThan(0)
    expect(order.map((o) => o.at)).toEqual([...order.map((o) => o.at)].sort((a, b) => a - b))
    // Third party actions by commit, like everywhere else in the workflows.
    for (const uses of action.match(/^\s*uses: .*$/gm) ?? []) {
      expect(uses, uses).toMatch(/@[0-9a-f]{40} # v\d/)
    }
    expect(withoutComments(action)).not.toMatch(/continue-on-error/)
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
    expect(jobBlock(RELEASE_YML, 'enforce-prerelease')).toMatch(/^\s*needs:\s*\[build-tauri, build-macos\]\s*$/m)
  })
})
