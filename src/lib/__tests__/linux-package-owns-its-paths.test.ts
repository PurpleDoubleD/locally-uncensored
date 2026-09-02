/**
 * The Linux packages may only claim paths that belong to us, and they have to
 * name every system library the bundled engine actually links against.
 *
 * GitHub #120 (AnnSdf1969, Ubuntu 26.04, 2026-08-28): dpkg refused the whole
 * install with "trying to overwrite '/usr/bin/llama-server', which is also in
 * package llama.cpp-tools". Tauri's deb and rpm bundlers copy every
 * `externalBin` straight into /usr/bin under its plain name, so the file name
 * IS the system path. Read out of the shipped 2.6.6 deb, which is the build
 * the reporter had:
 *
 *   ar x Locally.Uncensored_2.6.6_amd64.deb && tar tzf data.tar.gz | grep usr/bin
 *     usr/bin/llama-server        <- Debian's llama.cpp-tools owns this
 *     usr/bin/locally-uncensored
 *
 * The rename to lu-llama-server closed that in 2.6.7. What was still only a
 * list of four forbidden llama names is now a positive rule, so the next
 * sidecar (an ffmpeg, a whisper server) cannot walk into the same trap.
 *
 * Second half, same package, found on the same artifact: the sidecar is not
 * static after all. The ELF in the shipped deb carries
 *
 *   DT_NEEDED libgomp.so.1
 *   DT_NEEDED libvulkan.so.1
 *
 * and neither libvulkan1 nor libgomp1 was in the package's Depends. On a box
 * without them the deb installs fine and the built-in engine then dies at
 * exec with "error while loading shared libraries", which reaches the user as
 * an engine that never answers on 127.0.0.1:8127. The dependency belongs in
 * the package, not in a support thread.
 *
 * Run: npx vitest run src/lib/__tests__/linux-package-owns-its-paths.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const conf = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8')) as {
  bundle?: {
    externalBin?: string[]
    linux?: { deb?: { depends?: string[] }; rpm?: { depends?: string[] } }
  }
}

/** Prefix every binary we drop into /usr/bin has to carry. */
const OURS = 'lu-'

/** Is this a file name we may put into a shared system bin directory? */
export function bundledNameIsOurs(name: string): boolean {
  const stem = name.endsWith('.exe') ? name.slice(0, -'.exe'.length) : name
  return stem.startsWith(OURS) && stem.length > OURS.length
}

/** Which of `required` is not in `depends`. Empty means the package is complete. */
export function missingFrom(depends: string[], required: string[]): string[] {
  return required.filter((r) => !depends.includes(r))
}

const externalBin = conf.bundle?.externalBin ?? []
const names = externalBin.map((b) => b.split('/').pop() ?? b)

// The shared objects the Vulkan build of the sidecar links against, and the
// package that provides each one. Read off the shipped binary, not guessed.
const DEB_RUNTIME = ['libvulkan1', 'libgomp1']
const RPM_RUNTIME = ['vulkan-loader', 'libgomp']

describe('the bundled binaries claim only paths we own', () => {
  it('ships at least one external binary, so the rules below are not vacuous', () => {
    expect(names.length).toBeGreaterThan(0)
  })

  it('gives every bundled binary our own prefix', () => {
    for (const name of names) {
      expect(bundledNameIsOurs(name), `${name} would land in /usr/bin under a name we do not own`)
        .toBe(true)
    }
  })

  it('never ships a name a distribution package already owns in /usr/bin', () => {
    // Negative control, and wider than the four names #120 happened to hit:
    // this is what Debian's llama.cpp-tools and Fedora's llama-cpp put there.
    const owned = [
      'llama-server',
      'llama-cli',
      'llama-bench',
      'llama-quantize',
      'llama-embedding',
      'llama-tokenize',
      'llama-perplexity',
      'llama-gguf',
      'ffmpeg',
      'whisper',
      'python3',
    ]
    for (const taken of owned) {
      expect(names).not.toContain(taken)
      // The rule and the list agree: none of those names passes the rule.
      expect(bundledNameIsOurs(taken)).toBe(false)
    }
  })

  it('accepts the name we ship and rejects the one 2.6.6 shipped', () => {
    expect(bundledNameIsOurs('lu-llama-server')).toBe(true)
    expect(bundledNameIsOurs('lu-llama-server.exe')).toBe(true)
    expect(bundledNameIsOurs('llama-server')).toBe(false)
    // A bare prefix is not a name.
    expect(bundledNameIsOurs('lu-')).toBe(false)
  })
})

describe('the Linux packages pull in what the engine links against', () => {
  it('names the sidecar runtime libraries in the deb', () => {
    const depends = conf.bundle?.linux?.deb?.depends ?? []
    expect(missingFrom(depends, DEB_RUNTIME)).toEqual([])
  })

  it('names the sidecar runtime libraries in the rpm', () => {
    const depends = conf.bundle?.linux?.rpm?.depends ?? []
    expect(missingFrom(depends, RPM_RUNTIME)).toEqual([])
  })

  it('keeps the desktop dependencies it already had', () => {
    const depends = conf.bundle?.linux?.deb?.depends ?? []
    expect(missingFrom(depends, ['libwebkit2gtk-4.1-0', 'libgtk-3-0'])).toEqual([])
  })

  it('negative control: the check fails on the dependency list 2.6.7 shipped', () => {
    const asShipped = ['libwebkit2gtk-4.1-0', 'libgtk-3-0', 'libayatana-appindicator3-1']
    expect(missingFrom(asShipped, DEB_RUNTIME)).toEqual(DEB_RUNTIME)
  })
})
