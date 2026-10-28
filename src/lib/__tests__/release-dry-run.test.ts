/**
 * A full dry run of the release builds everything and publishes nothing.
 *
 * `.github/workflows/release.yml` takes a `dry_run` input: the Windows and
 * Linux installers are built from the branch the run was started on and kept
 * as workflow artifacts, and with `dry_run_mac` the Mac app as well. The
 * promise this file holds has two sides:
 *
 *   - a dry run cannot reach a release, a signing service for Windows or the
 *     release's updater key, and what it builds cannot join the public update
 *     channel once somebody installs it;
 *   - a release is what it was: it builds only after a green gate, and no
 *     step of it depends on the new inputs being present, since `inputs` is
 *     empty on the `release` trigger.
 *
 * Two halves, like release-build-gate.test.ts:
 *
 *   1. Structure, read out of the workflow text by job and by step.
 *   2. Behaviour. scripts/release-dry-run.mjs is EXECUTED with node against a
 *      copy of the real tauri.conf.json and against files made for the test.
 *
 * mac-release-lane.test.ts holds the Mac job, including its part in a full
 * dry run; signing-lanes.test.ts holds the conditions of the signing steps.
 *
 * VERIFICATION LIMIT, stated on purpose: no GitHub Actions run was permitted.
 * That a job runs past a skipped `needs`, and what the bundlers name their
 * files on a runner, is only shown by the first dry run itself.
 *
 * Run: npx vitest run src/lib/__tests__/release-dry-run.test.ts
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const RELEASE_YML = read('.github/workflows/release.yml')
const DRY_RUN_ENDPOINT = 'https://dry-run.invalid/latest.json'

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

const DRY = '${{ inputs.dry_run }}'
const build = withoutComments(jobBlock(RELEASE_YML, 'build-tauri'))
/** The steps of a job, split at `      - ` (six spaces: a step entry). */
const buildSteps = build.split(/\n(?= {6}- )/).slice(1)
const stepIf = (step: string) => step.match(/^ {8}if:\s*(.*?)\s*$/m)?.[1] ?? ''
const jobIf = (job: string) => withoutComments(jobBlock(RELEASE_YML, job)).match(/^ {4}if:\s*(.*?)\s*$/m)?.[1] ?? ''
const at = (test: (step: string) => boolean) => buildSteps.findIndex(test)

/** What only a release may touch: a token, a secret, the release, a signer. */
const REACHES_OUT = /secrets\.|GITHUB_TOKEN|GH_TOKEN|gh release|tauri-apps\/tauri-action@|windows-signpath|signing-config\.sh|windows-signing-/

// ── 1. Structure ───────────────────────────────────────────────────────────

describe('release.yml, the dry run inputs', () => {
  const dispatch = RELEASE_YML.slice(RELEASE_YML.indexOf('  workflow_dispatch:'), RELEASE_YML.indexOf('\npermissions:'))

  it('are booleans that are off unless someone ticks them', () => {
    for (const name of ['mac_dry_run', 'dry_run', 'dry_run_mac']) {
      const from = dispatch.indexOf(`      ${name}:`)
      expect(from, name).toBeGreaterThan(0)
      const input = dispatch.slice(from).split(/\n(?= {6}\S)/)[0]
      expect(input, name).toMatch(/^ {8}type:\s*boolean\s*$/m)
      expect(input, name).toMatch(/^ {8}default:\s*false\s*$/m)
      expect(input, name).toMatch(/^ {8}required:\s*false\s*$/m)
    }
  })
})

describe('release.yml, which jobs a full dry run starts', () => {
  it('skips the gate', () => {
    expect(jobIf('gate')).toBe('${{ !inputs.mac_dry_run && !inputs.dry_run }}')
  })

  it('builds past the skipped gate, and a release still only after a green one', () => {
    expect(build).toMatch(/^ {4}needs:\s*gate\s*$/m)
    // `!cancelled()` replaces the implicit `success()`, so the condition has
    // to ask for the gate's result itself. Spelled out whole: every weaker
    // form (always(), no result check, `!= 'failure'`) lets a release build
    // after a gate that did not pass.
    expect(jobIf('build-tauri')).toBe(
      "${{ !cancelled() && (needs.gate.result == 'success' || (inputs.dry_run && needs.gate.result == 'skipped')) }}",
    )
  })

  it('leaves the release flags alone', () => {
    expect(jobIf('enforce-prerelease')).toBe('${{ always() && !inputs.mac_dry_run && !inputs.dry_run }}')
    expect(jobIf('demote-on-arrival')).toBe("github.event_name == 'release'")
  })

  it('builds the commit the run was started on, and leaves no token in the checkout', () => {
    const checkout = buildSteps.find((s) => s.includes('actions/checkout@')) ?? ''
    expect(checkout).toContain('ref: ${{ inputs.dry_run && github.sha || github.event.release.tag_name || github.event.inputs.tag }}')
    // true in a release, as the action's default always was.
    expect(checkout).toMatch(/^\s*persist-credentials:\s*\$\{\{ !inputs\.dry_run \}\}\s*$/m)
  })
})

describe('release.yml, a dry run step and a release step are never the same step', () => {
  const dry = buildSteps.filter((s) => stepIf(s) === DRY)

  it('has its own steps for key, endpoint, build, check, collection and artifact', () => {
    expect(dry).toHaveLength(6)
    // No third kind of condition on the new input: a step is in the dry run
    // by exactly `inputs.dry_run`, or out of it by `!inputs.dry_run`.
    for (const step of buildSteps) {
      const condition = stepIf(step)
      if (!condition.includes('dry_run')) continue
      expect(condition === DRY || /(^|[ {(])!inputs\.dry_run\b/.test(condition), condition).toBe(true)
      expect(condition).not.toMatch(/mac_dry_run|dry_run_mac/)
    }
  })

  it('no dry run step is handed a secret, a token, the release or a signer', () => {
    for (const step of dry) expect(step, step.split('\n')[0]).not.toMatch(REACHES_OUT)
  })

  it('and every step that is handed one stays out of a dry run', () => {
    const reaching = buildSteps.filter((s) => REACHES_OUT.test(s))
    // Detection, Azure setup, tauri-action, Azure verify, SignPath stage 1.
    // The SignPath attach step moved to windows-signpath.yml (stage 3).
    expect(reaching).toHaveLength(5)
    for (const step of reaching) {
      expect(stepIf(step), step.split('\n')[0]).toMatch(/(^|[ {(])!inputs\.dry_run\b/)
    }
  })

  it('every other step is the same code path in a dry run and in a release', () => {
    // The sidecar build, the ISA guard, both boot smokes and the two bundle
    // checks: none of them asks which kind of run this is.
    const neutral = buildSteps.filter((s) => !stepIf(s).includes('dry_run'))
    for (const needle of ['build-llama.sh', 'verify-sidecar-isa.sh', '/health', 'run: npm ci', '--appimage-extract', 'dpkg-deb -x']) {
      expect(neutral.some((s) => s.includes(needle)), needle).toBe(true)
    }
    // The summary line reads the input to say "dry run", and decides nothing.
    const mentions = neutral.filter((s) => s.includes('inputs.dry_run'))
    expect(mentions).toHaveLength(2)
    expect(mentions.some((s) => s.includes('actions/checkout@'))).toBe(true)
    expect(mentions.some((s) => s.includes('DRY_RUN: ${{ inputs.dry_run }}'))).toBe(true)
  })
})

describe('release.yml, what a dry run builds and in which order', () => {
  const npmCi = at((s) => /^\s*run:\s*npm ci\s*$/m.test(s))
  const key = at((s) => s.includes('tauri signer generate'))
  const rewrite = at((s) => s.includes('release-dry-run.mjs rewrite-updater'))
  const dryBuild = at((s) => /^\s*run:\s*npx tauri build /m.test(s))
  const check = at((s) => s.includes('release-dry-run.mjs check-binaries'))
  const appimage = at((s) => s.includes('--appimage-extract'))
  const deb = at((s) => s.includes('dpkg-deb -x'))
  const collect = at((s) => s.includes('release-dry-run.mjs collect'))
  const artifact = at((s) => s.includes('actions/upload-artifact@'))

  it('key, endpoint, build, check, the bundle checks, then the artifact', () => {
    const order = [npmCi, key, rewrite, dryBuild, check, appimage, deb, collect, artifact]
    for (const index of order) expect(index).toBeGreaterThanOrEqual(0)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(artifact).toBe(buildSteps.length - 1)
  })

  it('makes the key the way the Mac lane does, on both runners, and masks it', () => {
    const step = buildSteps[key]
    expect(step).toMatch(/^ {8}id:\s*dry-run-key\s*$/m)
    // bash exists on the Windows runner too; the default shell there is not it.
    expect(step).toMatch(/^ {8}shell:\s*bash\s*$/m)
    expect(step).toMatch(/npx tauri signer generate --ci -w "\$RUNNER_TEMP\/[\w./-]+" > \/dev\/null/)
    const mask = step.indexOf('echo "::add-mask::$key"')
    expect(mask).toBeGreaterThan(0)
    expect(step.indexOf('echo "key=$key" >> "$GITHUB_OUTPUT"')).toBeGreaterThan(mask)
    expect(step.split('\n').filter((l) => /\becho "[^"]*\$key\b/.test(l))).toHaveLength(2)
    expect(step).not.toMatch(/set -[a-z]*x/)
  })

  it('rewrites the updater with the public half only', () => {
    const step = buildSteps[rewrite]
    expect(step).toContain('dry-run-updater.key.pub"')
    expect(step).not.toMatch(/dry-run-updater\.key"/)
  })

  it('builds with the arguments of the release step and the throwaway key alone', () => {
    const step = buildSteps[dryBuild]
    const release = buildSteps.find((s) => s.includes('tauri-apps/tauri-action@')) ?? ''
    // Same overlay, same matrix arguments. The one argument a release can
    // add is the signing overlay of a lane the dry run switches off.
    const args = release.match(/^\s*args:\s*(.*?)\s*$/m)?.[1] ?? ''
    expect(args).toBe('--config src-tauri/tauri.release.conf.json ${{ matrix.args }} ${{ steps.winsign.outputs.config_args }}')
    expect(step).toMatch(/^\s*run:\s*npx tauri build --config src-tauri\/tauri\.release\.conf\.json \$\{\{ matrix\.args \}\}\s*$/m)
    expect(step).toMatch(/^\s*TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{ steps\.dry-run-key\.outputs\.key \}\}\s*$/m)
    expect(step).toMatch(/^\s*TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\s*''\s*$/m)
    // The same library path the release step sets for linuxdeploy (K1-18).
    const libraryPath = (s: string) => s.match(/^\s*LD_LIBRARY_PATH:\s*(.*?)\s*$/m)?.[1]
    expect(libraryPath(step)).toBeTruthy()
    expect(libraryPath(step)).toBe(libraryPath(release))
    // The runner's default shell, as for the action; and no way to go green
    // without a build.
    expect(step).not.toMatch(/^ {8}shell:/m)
    expect(step).not.toMatch(/\|\|\s*true|continue-on-error/)
  })

  it('reads the built programs and drops the private key before anything is kept', () => {
    const step = buildSteps[check]
    expect(step).toMatch(/check-binaries "\$RUNNER_TEMP\/lu-dry-run\/receipt\.json" src-tauri\/target\/release\s*$/m)
    expect(step).toContain('rm -f "$RUNNER_TEMP/lu-dry-run/dry-run-updater.key"')
    expect(step).not.toMatch(/\|\|\s*true|continue-on-error/)
  })

  it('keeps one short lived artifact per platform, named for it and for the run', () => {
    const step = buildSteps[artifact]
    expect(step).toMatch(
      /^\s*name:\s*lu-\$\{\{ matrix\.platform == 'windows-latest' && 'windows' \|\| 'linux' \}\}-dry-run-\$\{\{ github\.run_id \}\}\s*$/m,
    )
    expect(step).toMatch(/^\s*path:\s*\$\{\{ runner\.temp \}\}\/lu-dry-run-artifact\s*$/m)
    expect(buildSteps[collect]).toContain('"$RUNNER_TEMP/lu-dry-run-artifact"')
    expect(step).toMatch(/^\s*if-no-files-found:\s*error\s*$/m)
    expect(step).toMatch(/^\s*retention-days:\s*[1-7]\s*$/m)
    // Same pin as the Mac lane and every other upload-artifact here.
    const pin = (text: string) => text.match(/actions\/upload-artifact@([0-9a-f]{40})/)?.[1]
    expect(pin(step)).toBeTruthy()
    expect(pin(step)).toBe(pin(jobBlock(RELEASE_YML, 'build-tauri-macos')))
  })
})

// ── 2. Behaviour: the script, executed ─────────────────────────────────────

/** A throwaway tree with the script and the real config, so nothing here writes into the repository. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'lu-dry-run-'))
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'src-tauri'))
  copyFileSync(resolve(root, 'scripts/release-dry-run.mjs'), join(dir, 'scripts/release-dry-run.mjs'))
  for (const name of readdirSync(resolve(root, 'src-tauri'))) {
    if (/^tauri\..*conf\.json$/.test(name)) copyFileSync(resolve(root, 'src-tauri', name), join(dir, 'src-tauri', name))
  }
  const run = (args: string[], env: Record<string, string> = {}) => {
    try {
      const out = execFileSync(process.execPath, [join(dir, 'scripts/release-dry-run.mjs'), ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '', ...env },
      })
      return { code: 0, out }
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  }
  const conf = () => JSON.parse(readFileSync(join(dir, 'src-tauri/tauri.conf.json'), 'utf8'))
  return { dir, run, conf, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Shaped like the file `tauri signer generate` writes: one line of base64. */
const THROWAWAY_PUBKEY = Buffer.from('untrusted comment: minisign public key: 0000000000000000\nRWTthrowawaythrowawaythrowawaythrowawaythrowawaythrowa\n').toString('base64')
const CHECKED_IN = JSON.parse(read('src-tauri/tauri.conf.json'))
const PUBLIC_ENDPOINT: string = CHECKED_IN.plugins.updater.endpoints[0]
const RELEASE_PUBKEY: string = CHECKED_IN.plugins.updater.pubkey

describe('release-dry-run.mjs rewrite-updater, executed', () => {
  it('moves endpoint and pubkey, changes nothing else, and writes down what stood there', () => {
    const box = sandbox()
    try {
      writeFileSync(join(box.dir, 'pub'), `${THROWAWAY_PUBKEY}\n`)
      const result = box.run(['rewrite-updater', join(box.dir, 'pub'), join(box.dir, 'receipt.json')])
      expect(result.out).not.toContain('::error')
      expect(result.code).toBe(0)
      const after = box.conf()
      // Everything else of the section stays, requireSignedVersion too: the dry run builds with the same CLI.
      expect(after.plugins.updater).toEqual({ ...CHECKED_IN.plugins.updater, endpoints: [DRY_RUN_ENDPOINT], pubkey: THROWAWAY_PUBKEY })
      expect({ ...after, plugins: { ...after.plugins, updater: CHECKED_IN.plugins.updater } }).toEqual(CHECKED_IN)
      const text = readFileSync(join(box.dir, 'src-tauri/tauri.conf.json'), 'utf8')
      expect(text).not.toContain(PUBLIC_ENDPOINT)
      expect(text).not.toContain(RELEASE_PUBKEY)
      expect(JSON.parse(readFileSync(join(box.dir, 'receipt.json'), 'utf8'))).toEqual({
        dryRunEndpoint: DRY_RUN_ENDPOINT,
        dryRunPubkey: THROWAWAY_PUBKEY,
        publicEndpoints: CHECKED_IN.plugins.updater.endpoints,
        releasePubkey: RELEASE_PUBKEY,
      })
      // Never the private half, and never a value in the log.
      expect(result.out).not.toContain(THROWAWAY_PUBKEY)
    } finally {
      box.done()
    }
  })

  it('points at a name nobody can register', () => {
    // RFC 2606 reserves `.invalid`; a resolver answers for none of it.
    expect(new URL(DRY_RUN_ENDPOINT).hostname.endsWith('.invalid')).toBe(true)
    expect(read('scripts/release-dry-run.mjs')).toContain(`export const DRY_RUN_ENDPOINT = '${DRY_RUN_ENDPOINT}'`)
  })

  it('refuses the release pubkey, an empty key, and leaves the file alone', () => {
    for (const wrong of [RELEASE_PUBKEY, '', 'not a key\n']) {
      const box = sandbox()
      try {
        writeFileSync(join(box.dir, 'pub'), wrong)
        const result = box.run(['rewrite-updater', join(box.dir, 'pub'), join(box.dir, 'receipt.json')])
        expect(result.code, JSON.stringify(wrong.slice(0, 12))).toBe(1)
        expect(result.out).toContain('::error::')
        expect(box.conf()).toEqual(CHECKED_IN)
      } finally {
        box.done()
      }
    }
  })

  it('refuses when an overlay would put an updater back on top of the rewrite', () => {
    const box = sandbox()
    try {
      writeFileSync(join(box.dir, 'pub'), THROWAWAY_PUBKEY)
      writeFileSync(join(box.dir, 'src-tauri/tauri.release.conf.json'), JSON.stringify({ plugins: { updater: { endpoints: [PUBLIC_ENDPOINT] } } }))
      const result = box.run(['rewrite-updater', join(box.dir, 'pub'), join(box.dir, 'receipt.json')])
      expect(result.code).toBe(1)
      expect(result.out).toContain('tauri.release.conf.json sets plugins.updater')
      expect(box.conf()).toEqual(CHECKED_IN)
    } finally {
      box.done()
    }
  })

  it('no checked-in overlay does that today', () => {
    // The two phone files take the updater out of a phone build with `null`:
    // no desktop build reads them and `null` names no address.
    const phone = ['tauri.android.conf.json', 'tauri.ios.conf.json']
    for (const name of readdirSync(resolve(root, 'src-tauri')).filter((n) => /^tauri\..+\.conf\.json$/.test(n))) {
      const updater = JSON.parse(read(`src-tauri/${name}`)).plugins?.updater
      if (phone.includes(name)) expect(updater, name).toBeNull()
      else expect(updater, name).toBeUndefined()
    }
  })

  it('a phone file that names an updater of its own is refused like any other overlay', () => {
    const box = sandbox()
    try {
      writeFileSync(join(box.dir, 'pub'), THROWAWAY_PUBKEY)
      writeFileSync(join(box.dir, 'src-tauri/tauri.android.conf.json'), JSON.stringify({ plugins: { updater: { endpoints: [PUBLIC_ENDPOINT] } } }))
      const result = box.run(['rewrite-updater', join(box.dir, 'pub'), join(box.dir, 'receipt.json')])
      expect(result.code).toBe(1)
      expect(result.out).toContain('tauri.android.conf.json sets plugins.updater')
      expect(box.conf()).toEqual(CHECKED_IN)
    } finally {
      box.done()
    }
  })

  it('a desktop overlay that takes the updater out with null is refused', () => {
    const box = sandbox()
    try {
      writeFileSync(join(box.dir, 'pub'), THROWAWAY_PUBKEY)
      writeFileSync(join(box.dir, 'src-tauri/tauri.windows.conf.json'), JSON.stringify({ plugins: { updater: null } }))
      const result = box.run(['rewrite-updater', join(box.dir, 'pub'), join(box.dir, 'receipt.json')])
      expect(result.code).toBe(1)
      expect(result.out).toContain('tauri.windows.conf.json sets plugins.updater')
    } finally {
      box.done()
    }
  })
})

describe('release-dry-run.mjs check-binaries, executed', () => {
  const receipt = { dryRunEndpoint: DRY_RUN_ENDPOINT, dryRunPubkey: THROWAWAY_PUBKEY, publicEndpoints: [PUBLIC_ENDPOINT], releasePubkey: RELEASE_PUBKEY }
  /** Larger than one read of the script, so a needle can sit on the seam. */
  const filler = (bytes: number) => Buffer.alloc(bytes, 0x41)
  const PIECE = 4 * 1024 * 1024

  function judge(files: Record<string, Buffer>) {
    const box = sandbox()
    try {
      writeFileSync(join(box.dir, 'receipt.json'), JSON.stringify(receipt))
      mkdirSync(join(box.dir, 'release'))
      for (const [name, bytes] of Object.entries(files)) writeFileSync(join(box.dir, 'release', name), bytes)
      return box.run(['check-binaries', join(box.dir, 'receipt.json'), join(box.dir, 'release')])
    } finally {
      box.done()
    }
  }

  it('passes a program that carries the dry run endpoint and nothing public', () => {
    const result = judge({
      'app.exe': Buffer.concat([filler(1000), Buffer.from(DRY_RUN_ENDPOINT), filler(1000)]),
      'lu-llama-server': filler(1000),
    })
    expect(result.out).toContain('OK: 2 programs read')
    expect(result.code).toBe(0)
  })

  it('fails on the public endpoint, also when it sits across two reads', () => {
    const half = Math.floor(PUBLIC_ENDPOINT.length / 2)
    const result = judge({
      app: Buffer.concat([filler(PIECE - half), Buffer.from(PUBLIC_ENDPOINT), filler(1000), Buffer.from(DRY_RUN_ENDPOINT)]),
    })
    expect(result.code).toBe(1)
    expect(result.out).toContain('still carries the public updater endpoint')
  })

  it('fails on the release pubkey', () => {
    const result = judge({ app: Buffer.concat([Buffer.from(DRY_RUN_ENDPOINT), filler(100), Buffer.from(RELEASE_PUBKEY)]) })
    expect(result.code).toBe(1)
    expect(result.out).toContain('still carries the release updater pubkey')
    expect(result.out).not.toContain(RELEASE_PUBKEY)
  })

  it('fails when it finds no updater configuration at all: that search proved nothing', () => {
    const result = judge({ app: filler(5000) })
    expect(result.code).toBe(1)
    expect(result.out).toContain('proves nothing')
  })

  it('reads programs and libraries, not the notes next to them', () => {
    const result = judge({
      app: Buffer.from(DRY_RUN_ENDPOINT),
      'app.d': Buffer.from(PUBLIC_ENDPOINT),
    })
    expect(result.code).toBe(0)
    expect(result.out).toContain('OK: 1 programs read')
  })
})

describe('release-dry-run.mjs collect, executed', () => {
  const receipt = { dryRunEndpoint: DRY_RUN_ENDPOINT, dryRunPubkey: THROWAWAY_PUBKEY, publicEndpoints: [PUBLIC_ENDPOINT], releasePubkey: RELEASE_PUBKEY }
  const WINDOWS = [
    'nsis/Locally Uncensored_3.0.6_x64-setup.exe',
    'nsis/Locally Uncensored_3.0.6_x64-setup.nsis.zip',
    'nsis/Locally Uncensored_3.0.6_x64-setup.nsis.zip.sig',
    'msi/Locally Uncensored_3.0.6_x64_en-US.msi',
    'msi/Locally Uncensored_3.0.6_x64_en-US.msi.zip',
    'msi/Locally Uncensored_3.0.6_x64_en-US.msi.zip.sig',
  ]
  const LINUX = [
    'deb/Locally Uncensored_3.0.6_amd64.deb',
    'rpm/Locally Uncensored-3.0.6-1.x86_64.rpm',
    'appimage/Locally Uncensored_3.0.6_amd64.AppImage',
    'appimage/Locally Uncensored_3.0.6_amd64.AppImage.tar.gz',
    'appimage/Locally Uncensored_3.0.6_amd64.AppImage.tar.gz.sig',
  ]

  function collect(platform: string, files: readonly string[]) {
    const box = sandbox()
    const bundle = join(box.dir, 'bundle')
    const out = join(box.dir, 'out')
    const summary = join(box.dir, 'summary.md')
    writeFileSync(join(box.dir, 'receipt.json'), JSON.stringify(receipt))
    writeFileSync(summary, '')
    for (const file of files) {
      mkdirSync(dirname(join(bundle, file)), { recursive: true })
      writeFileSync(join(bundle, file), `bytes of ${file}`)
    }
    // What a bundler leaves next to its file: the tree it packed from.
    mkdirSync(join(bundle, 'deb/packed/usr/bin'), { recursive: true })
    writeFileSync(join(bundle, 'deb/packed/usr/bin/app.exe'), 'not an installer')
    const result = box.run(['collect', platform, bundle, out, join(box.dir, 'receipt.json')], {
      GITHUB_STEP_SUMMARY: summary, GITHUB_SHA: 'c0ffee', GITHUB_RUN_ID: '4711',
    })
    const kept = result.code === 0 ? readdirSync(out).sort() : []
    const marker = result.code === 0 ? readFileSync(join(out, 'DRY-RUN-NOT-FOR-RELEASE.txt'), 'utf8') : ''
    const written = readFileSync(summary, 'utf8')
    box.done()
    return { ...result, kept, marker, summary: written }
  }

  it('keeps the installers, the updater archives and their signatures, and nothing else', () => {
    for (const [platform, files] of [['windows', WINDOWS], ['linux', LINUX]] as const) {
      const result = collect(platform, files)
      expect(result.out, platform).not.toContain('::error')
      expect(result.kept, platform).toEqual(['DRY-RUN-NOT-FOR-RELEASE.txt', ...files.map((f) => f.split('/')[1])].sort())
    }
  })

  it('writes one sha256 line per file into the job summary', () => {
    const result = collect('windows', WINDOWS)
    const lines = result.summary.split('\n').filter((l) => /^- `.+` sha256 `[0-9a-f]{64}`$/.test(l))
    expect(lines).toHaveLength(WINDOWS.length)
    expect(result.summary).toContain('not for release')
  })

  it('says in the artifact what these files are not', () => {
    const windows = collect('windows', WINDOWS).marker
    expect(windows).toContain('DRY RUN, NOT FOR RELEASE')
    expect(windows).toContain('Commit: c0ffee')
    expect(windows).toContain('Run:    4711')
    expect(windows).toMatch(/THROWAWAY updater key/)
    expect(windows).toContain('latest.json')
    expect(windows).toContain(DRY_RUN_ENDPOINT)
    expect(windows).toContain(THROWAWAY_PUBKEY)
    expect(windows).toContain('no code signature')
    expect(windows).not.toContain(RELEASE_PUBKEY)
    expect(windows).not.toContain(PUBLIC_ENDPOINT)
    // Nobody signs a Linux package, so that paragraph is Windows only.
    expect(collect('linux', LINUX).marker).not.toContain('code signature')
  })

  it('fails when a kind a release ships is missing', () => {
    for (const missing of ['nsis/Locally Uncensored_3.0.6_x64-setup.exe', 'msi/Locally Uncensored_3.0.6_x64_en-US.msi']) {
      const result = collect('windows', WINDOWS.filter((f) => f !== missing))
      expect(result.code, missing).toBe(1)
      expect(result.out).toContain('the build left no file for')
    }
    expect(collect('linux', LINUX.filter((f) => !f.endsWith('.deb'))).code).toBe(1)
    expect(collect('linux', LINUX.filter((f) => !f.endsWith('.AppImage'))).code).toBe(1)
    // Installers without one updater signature: the overlay did not apply.
    expect(collect('linux', LINUX.filter((f) => !f.endsWith('.sig'))).code).toBe(1)
  })

  it('fails on a signature that signs nothing', () => {
    const result = collect('windows', WINDOWS.filter((f) => !f.endsWith('.msi.zip')))
    expect(result.code).toBe(1)
    expect(result.out).toContain('has no file it signs')
  })
})

describe('negative controls', () => {
  it('a release step without the dry run exclusion is recognised as one', () => {
    const step = "      - name: x\n        if: matrix.platform == 'windows-latest'\n        env:\n          T: ${{ secrets.GITHUB_TOKEN }}\n"
    expect(REACHES_OUT.test(step)).toBe(true)
    expect(stepIf(step)).not.toMatch(/(^|[ {(])!inputs\.dry_run\b/)
  })

  it('`inputs.dry_run` is not mistaken for its negation, nor for the Mac input', () => {
    expect('${{ inputs.dry_run }}').not.toMatch(/(^|[ {(])!inputs\.dry_run\b/)
    expect('${{ !inputs.dry_run_mac }}').not.toMatch(/(^|[ {(])!inputs\.dry_run\b/)
    expect("matrix.platform == 'windows-latest' && !inputs.dry_run").toMatch(/(^|[ {(])!inputs\.dry_run\b/)
  })
})
