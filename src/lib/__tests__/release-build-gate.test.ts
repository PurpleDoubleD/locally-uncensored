/**
 * CI has to try building the product, and it has to believe the exit code.
 *
 * THE GAP THIS NAILS SHUT
 * -----------------------
 * At 10bfa0d7 (v2.6.7 — the shipped product, not an experiment artefact)
 * `npm run tauri build` wrote its installers to disk and then exited 1:
 *
 *     Finished 2 bundles at: … .app … .dmg … .app.tar.gz (updater)
 *     Error A public key has been found, but no private key.
 *           Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable.
 *     TAURI_BUILD_EXIT=1
 *
 * `bundle.createUpdaterArtifacts` asked the bundler for signed updater
 * artefacts while `plugins.updater.pubkey` sat next to it, so the bundler
 * demanded a private key that only the release runner has. Anybody else —
 * contributor, fork, AGPL-3.0 §6 recipient — got exit 1. Fixed in a0030ad2 by
 * removing that one field. The release lane asks for the updater artefacts
 * itself (`--config src-tauri/tauri.release.conf.json`, see the last describe
 * below); `die-app-heisst-wie-die-app.test.ts` keeps the config half honest.
 *
 * This file keeps the OTHER half from coming back: the reason nobody noticed
 * for a whole release. `.github/workflows/ci.yml` ran `npm run build` (vite),
 * `cargo check` and `cargo test` — all three pass on a config that cannot be
 * bundled — and never ran `tauri build` once. The only lane that did was
 * release.yml, where TAURI_SIGNING_PRIVATE_KEY comes out of GitHub secrets, so
 * the single job able to see the failure was the one job configured never to
 * meet it. A build that produces artefacts and still exits non-zero was
 * structurally invisible to this project.
 *
 * WHAT IS ASSERTED, AND HOW
 * -------------------------
 * Two halves, deliberately:
 *
 *   1. Structure — the gate exists in ci.yml, covers exactly the platforms
 *      release.yml ships, reads no secret, and carries no escape hatch. Read
 *      out of the YAML text by job block, because this repo has no YAML parser
 *      as a declared dependency and adding one for a test is not worth a new
 *      supply-chain edge. The slicing relies on one documented property of a
 *      GitHub workflow file: jobs sit at exactly two spaces under `jobs:`.
 *
 *   2. Behaviour — `build_verdict` from scripts/ci-tauri-build.sh is EXECUTED
 *      in a real bash against real files on disk, including the precise
 *      "artefacts present, exit 1" shape above. Nothing here is mocked; the
 *      function that decides red-or-green is the function that runs in CI.
 *
 * VERIFICATION LIMIT, stated on purpose: no GitHub Actions run was permitted
 * for any of this. The workflow file has never executed. What is proven is the
 * script's judgement (locally, by execution), the file's syntax and schema
 * (actionlint 1.7.12 + shellcheck 0.11.0), and the structural claims below.
 *
 * Run: npx vitest run src/lib/__tests__/release-build-gate.test.ts
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { bashInterpreter } from '../../api/__tests__/bash-interpreter'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const CI_YML = read('.github/workflows/ci.yml')
const RELEASE_YML = read('.github/workflows/release.yml')
const GATE_SCRIPT_REL = 'scripts/ci-tauri-build.sh'
const GATE_SCRIPT = resolve(root, GATE_SCRIPT_REL)

/**
 * The lines belonging to one job, by indentation.
 *
 * A workflow's jobs are the keys at exactly two spaces under `jobs:`, so the
 * block runs from `  <name>:` to the next line that starts a sibling key at
 * that same depth. Comment lines at two spaces (`  # …`) are part of the block
 * they precede, not a new key, so they must not end it.
 */
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

/**
 * The same block with prose removed.
 *
 * These workflows are heavily commented, and the comments name the very things
 * that must not appear as settings ("no `continue-on-error`, no `|| true`").
 * A check that cannot tell a rule from a note about the rule is not a check —
 * it just punishes documentation.
 */
function withoutComments(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s#.*$/, ''))
    .join('\n')
}

/** `platform: [a, b]` — the flat matrix form ci.yml uses. */
function flatMatrixPlatforms(block: string): string[] {
  const m = block.match(/^\s*platform:\s*\[([^\]]*)\]\s*$/m)
  if (!m) return []
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

/** `- platform: xyz` — the include-list form release.yml uses. */
function includeMatrixPlatforms(block: string): string[] {
  return [...block.matchAll(/^\s*-\s*platform:\s*(\S+)\s*$/gm)]
    .map((m) => m[1].replace(/^['"]|['"]$/g, ''))
}

// ── 1. Structure ───────────────────────────────────────────────────────────

describe('ci.yml actually tries to build the product', () => {
  const gate = jobBlock(CI_YML, 'tauri-build')

  it('has a job that runs tauri build — the step that did not exist', () => {
    expect(gate, 'no `tauri-build` job in .github/workflows/ci.yml').not.toBe('')
    expect(gate).toContain(`bash ${GATE_SCRIPT_REL}`)
  })

  it('covers exactly the platforms release.yml ships — no silent narrowing', () => {
    const shipped = includeMatrixPlatforms(jobBlock(RELEASE_YML, 'build-tauri'))
    const gated = flatMatrixPlatforms(gate)

    // Guard the guard: if the extraction ever stops finding anything, this
    // test must fail loudly instead of comparing two empty lists.
    expect(shipped.length, 'could not read release.yml build-tauri platforms').toBeGreaterThan(0)
    expect([...gated].sort()).toEqual([...shipped].sort())
  })

  it('reads no secret, so a fork is held to the same check', () => {
    // The whole point of building unsigned. A gate that consumes a secret is
    // green-by-absence everywhere the secret is not configured — and, measured
    // locally on 2026-09-01, handing the broken 10bfa0d7 config a signing key
    // makes `tauri build` exit 0, so a key-carrying gate would have passed on
    // the exact commit it exists to fail.
    expect(withoutComments(gate)).not.toMatch(/secrets\./)
    expect(withoutComments(gate)).not.toMatch(/TAURI_SIGNING_PRIVATE_KEY/)
  })

  it('has no escape hatch that could report success without building', () => {
    expect(withoutComments(gate)).not.toMatch(/continue-on-error/)
    expect(withoutComments(gate)).not.toMatch(/\|\|\s*true/)
  })

  it('is part of what a release must pass, not a lane beside it', () => {
    // release.yml reuses this whole workflow as its gate. If it ever stops
    // doing so, the build check silently leaves the release path — which is
    // the drift M6 was about in the first place.
    expect(CI_YML).toMatch(/^\s{2}workflow_call:/m)
    expect(jobBlock(RELEASE_YML, 'gate')).toContain('uses: ./.github/workflows/ci.yml')
    expect(jobBlock(RELEASE_YML, 'build-tauri')).toMatch(/^\s*needs:\s*gate\s*$/m)
  })
})

describe('the keyless gate and the signed release ask for different things', () => {
  // Measured 2026-09-06 on a fresh Ubuntu 22.04 box, at 16b2b0f6: with
  // `bundle.createUpdaterArtifacts` back in the checked-in config (127e73bc),
  // the gate script bundled deb, rpm and AppImage and then exited 1 on the
  // signing complaint — the 10bfa0d7 shape exactly. release.yml's build-tauri
  // sits behind `needs: gate`, so that red would have meant no release assets
  // at all. The updater artefacts are therefore requested by the release lane
  // alone, through an overlay the gate never sees.
  const conf = (rel: string) => JSON.parse(read(rel))

  it('the checked-in configs can be built without a key', () => {
    for (const f of ['tauri.conf.json', 'tauri.windows.conf.json', 'tauri.linux.conf.json', 'tauri.macos.conf.json']) {
      expect(conf(`src-tauri/${f}`).bundle?.createUpdaterArtifacts, f).toBeUndefined()
    }
  })

  it('the release lane requests the updater artefacts through the overlay', () => {
    expect(conf('src-tauri/tauri.release.conf.json').bundle?.createUpdaterArtifacts).toBe('v1Compatible')
    const build = withoutComments(jobBlock(RELEASE_YML, 'build-tauri'))
    expect(build).toMatch(/^\s*args:\s*--config src-tauri\/tauri\.release\.conf\.json(\s|$)/m)
  })

  it('and the gate never sees that overlay', () => {
    expect(withoutComments(jobBlock(CI_YML, 'tauri-build'))).not.toMatch(/tauri\.release\.conf\.json/)
  })
})

describe('a longer gate must not mean a longer window at Latest', () => {
  // The cost of the job above: `gate` now compiles and bundles on two
  // platforms, so the stretch between "Publish release" and "enforce-prerelease
  // finally runs" grew by the length of a full build. GitHub points
  // releases/latest at a published full release by itself, immediately, and
  // both the lu-labs.ai download routes and every installed updater follow that
  // pointer — so that stretch is exposure, and this job is what keeps the build
  // gate from paying for itself with it.
  const early = jobBlock(RELEASE_YML, 'demote-on-arrival')
  const late = jobBlock(RELEASE_YML, 'enforce-prerelease')

  it('demotes on arrival, sequenced behind nothing', () => {
    expect(early, 'no `demote-on-arrival` job in release.yml').not.toBe('')
    expect(early).toContain('node scripts/enforce-prerelease.mjs')
    // A `needs:` here would put it back behind the build and undo the point.
    expect(withoutComments(early)).not.toMatch(/^\s*needs:/m)
  })

  it('still keeps the final word after the build', () => {
    // The early job is an addition, not a replacement: the late one also has to
    // run when the build FAILED, which is when leaving the flag on would be
    // worst, and it is what holds the promise on a manual re-run.
    expect(late).not.toBe('')
    expect(late).toMatch(/^\s*needs:\s*build-tauri\s*$/m)
    expect(late).toMatch(/^\s*if:\s*always\(\)\s*$/m)
    expect(late).toContain('node scripts/enforce-prerelease.mjs')
  })
})

describe('the gate script is shaped so the exit code survives', () => {
  // Prose stripped, for the reason `withoutComments` exists — and because the
  // mutation probe caught this exact hole: with the raw text, replacing
  // `${PIPESTATUS[0]}` with `$?` in the code left the assertion green, because
  // the comment above that line also says "PIPESTATUS[0]". The check has to
  // read the script, not the explanation of the script.
  const script = withoutComments(read(GATE_SCRIPT_REL))

  it('exists and is executable', () => {
    expect(existsSync(GATE_SCRIPT)).toBe(true)
    if (process.platform === 'win32') {
      const mode = execFileSync('git', ['ls-files', '-s', GATE_SCRIPT_REL], { cwd: root, encoding: 'utf8' })
        .split(' ')[0]
      expect(mode).toBe('100755')
    } else {
      expect(statSync(GATE_SCRIPT).mode & 0o100).toBeTruthy()
    }
  })

  it('takes the build status from PIPESTATUS, not from tee', () => {
    // `npm run … | tee log` followed by `$?` reads tee's status, which is 0
    // whatever the build did. That single mistake would rebuild the exact
    // blind spot this job exists to close.
    expect(script).toContain('PIPESTATUS[0]')
    // `set -uo pipefail` or `set -o pipefail`; deliberately NOT a bare search
    // for the word, which a comment would satisfy.
    expect(script).toMatch(/^set\s+-[a-z]*o\s+pipefail\s*$/m)
  })

  it('unsets the signing variables instead of assuming they are absent', () => {
    expect(script).toMatch(/unset TAURI_SIGNING_PRIVATE_KEY\b/)
    expect(script).toMatch(/unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD\b/)
  })
})

// ── 2. Behaviour — real bash, real files, no mocks ─────────────────────────

describe('build_verdict, executed', () => {
  const BASH = bashInterpreter()

  /** Source the script (main is guarded) and run the verdict for real. */
  function verdict(code: number, logfile: string, bundleDir: string): number {
    try {
      execFileSync(BASH, ['-c', `source '${GATE_SCRIPT}'; build_verdict ${code} '${logfile}' '${bundleDir}'`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      })
      return 0
    } catch (e) {
      const status = (e as { status?: number }).status
      return typeof status === 'number' ? status : 1
    }
  }

  /** A throwaway tree: a bundle dir with one installer, plus two build logs. */
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'lu-build-gate-'))
    const bundle = join(dir, 'bundle', 'dmg')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'LU Experiment_2.6.7_aarch64.dmg'), 'not really a dmg')
    const failing = join(dir, 'failing.log')
    // The literal tail of the 2026-09-01 measurement.
    writeFileSync(
      failing,
      'Finished 2 bundles at:\n' +
        '    /x/LU Experiment.app\n' +
        '    /x/LU Experiment_2.6.7_aarch64.dmg\n' +
        '    /x/LU Experiment.app.tar.gz (updater)\n' +
        'Error A public key has been found, but no private key. ' +
        'Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable.\n',
    )
    const clean = join(dir, 'clean.log')
    writeFileSync(clean, 'Finished 2 bundles at:\n    /x/LU Experiment.app\n')
    return { dir, bundleRoot: join(dir, 'bundle'), empty: join(dir, 'nothing-here'), failing, clean }
  }

  it('THE case: installers on disk and exit 1 is still a failure', () => {
    const f = fixture()
    try {
      // Exactly a0030ad2: the bundler finished its two bundles, wrote them
      // out, and then exited 1. "The artefacts are there" is not a verdict.
      expect(verdict(1, f.failing, f.bundleRoot)).not.toBe(0)
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  it('a clean keyless build passes', () => {
    const f = fixture()
    try {
      expect(verdict(0, f.clean, f.bundleRoot)).toBe(0)
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  it('exit 0 with nothing bundled is a failure too', () => {
    const f = fixture()
    try {
      expect(verdict(0, f.clean, f.empty)).not.toBe(0)
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  it('exit 0 while the log begs for a signing key is a failure', () => {
    const f = fixture()
    try {
      // Belt to the exit code's braces. Should a future tauri demote that
      // error to a warning, the exit code stops carrying the news and this is
      // the only thing left that notices.
      expect(verdict(0, f.failing, f.bundleRoot)).not.toBe(0)
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })
})
