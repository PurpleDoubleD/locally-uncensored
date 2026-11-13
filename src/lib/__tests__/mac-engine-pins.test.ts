/**
 * The pins of the five Mac media engines have one home each.
 *
 * `macos-gate` in ci.yml asks pip whether the engines' packages still
 * resolve (`scripts/mac-engine-pins-dry-run.sh`). The lists it asks about
 * are read by `scripts/mac-engine-pins.mjs` from the places the app itself
 * installs from: four Rust files and one requirements file. Nothing is
 * copied, so nothing can drift between a copy and its original. What CAN
 * happen is that a Rust file changes shape and the reader reads less than
 * is there, or nothing. This file holds that the reader then stops:
 *
 *   1. against the working tree it finds all five engines, every entry an
 *      exact pin or a pinned archive, and the lists are what the Rust code
 *      builds (array lengths, the archive addresses);
 *   2. it refuses a source whose shape it does not know: a missing constant,
 *      a declared length that does not match, an open version bound, a
 *      changed address template.
 *
 * It proves nothing about PyPI. That is what the dry run is for.
 *
 * Run: npx vitest run src/lib/__tests__/mac-engine-pins.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPO_ROOT,
  SOURCES,
  LTX_SPEC_TEMPLATE,
  isPinned,
  pythonLine,
  readEnginePins,
  requirementLines,
  rustStrArray,
  rustStrConst,
} from '../../../scripts/mac-engine-pins.mjs'

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')
const engines = readEnginePins()
const byId = (id: string) => engines.find((e) => e.id === id)!

describe('the working tree', () => {
  it('yields the five engines, in a fixed order', () => {
    expect(engines.map((e) => e.id)).toEqual(['image', 'mflux', 'mlx-video', 'ltx-2-mlx', 'mesh3d'])
    for (const engine of engines) expect(engine.source).toBe(SOURCES[engine.id])
  })

  it('names only exact pins and pinned archives', () => {
    for (const engine of engines) {
      expect(engine.specs.length, engine.id).toBeGreaterThan(0)
      for (const spec of engine.specs) expect(isPinned(spec), `${engine.id}: ${spec}`).toBe(true)
    }
  })

  it('reads the image sidecar list as pip reads the file', () => {
    // Every line of the file that is not a comment or empty, none left out.
    const lines = read(SOURCES.image)
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    expect(byId('image').specs).toEqual(lines.map((l) => l.trim()))
    expect(byId('image').specs).toContain('uvicorn[standard]==' + lines.find((l) => l.startsWith('uvicorn'))!.split('==')[1])
  })

  it('reads as many mflux pins as the Rust array declares, the engine among them', () => {
    const source = read(SOURCES.mflux)
    const declared = Number(source.match(/const PINNED: \[&str; (\d+)\]/)![1])
    expect(byId('mflux').specs).toHaveLength(declared)
    const version = rustStrConst(source, 'VERSION')
    expect(byId('mflux').specs).toContain(`mflux==${version}`)
  })

  it('reads the first video engine as MLX pins plus the archive of one commit', () => {
    const source = read(SOURCES['mlx-video'])
    const declared = Number(source.match(/const MLX_VIDEO_PINNED: \[&str; (\d+)\]/)![1])
    const specs = byId('mlx-video').specs
    expect(specs).toHaveLength(declared + 1)
    expect(specs.at(-1)).toMatch(/^mlx-video @ https:\/\/github\.com\/[^/]+\/mlx-video\/archive\/[0-9a-f]{40}\.zip$/)
    // The function that builds the pip call still chains exactly these two.
    expect(source).toContain('MLX_VIDEO_PINNED.iter().copied().chain([MLX_VIDEO_PIP_SPEC]).collect()')
  })

  it('reads the second video engine as its pins plus one archive address per package', () => {
    const source = read(SOURCES['ltx-2-mlx'])
    const pinned = Number(source.match(/const PINNED: \[&str; (\d+)\]/)![1])
    const packages = rustStrArray(source, 'PACKAGES')
    const commit = rustStrConst(source, 'COMMIT')
    const specs = byId('ltx-2-mlx').specs
    expect(specs).toHaveLength(pinned + packages.length)
    for (const p of packages) {
      expect(specs).toContain(`${p} @ ${rustStrConst(source, 'SOURCE')}/${commit}.zip#subdirectory=packages/${p}`)
    }
    // The template this reader repeats is the one in the Rust source.
    expect(source).toContain(`format!("${LTX_SPEC_TEMPLATE}")`)
  })

  it('reads the 3D engine as exactly the PINNED array of mesh3d.rs, wheels only', () => {
    const source = read(SOURCES.mesh3d)
    const declared = Number(source.match(/const PINNED: \[&str; (\d+)\]/)![1])
    const specs = byId('mesh3d').specs
    expect(specs).toHaveLength(declared)
    // Every entry is name==version: the second pass of the dry run checks all
    // of them for wheels on the oldest macOS.
    expect(specs.every((s) => !s.includes(' @ '))).toBe(true)
    // torch is the one the music engine installs, so the wheel is fetched once.
    expect(specs).toContain('torch==2.10.0')
    expect(specs.some((s) => s.startsWith('torchmcubes') || s.startsWith('rembg'))).toBe(false)
  })

  it('takes the Python line from python.json', () => {
    expect(pythonLine()).toMatch(/^3\.\d+$/)
    expect(JSON.parse(read('src-tauri/resources/voice_loop/python.json')).version.startsWith(pythonLine() + '.')).toBe(true)
  })
})

describe('a source that changed shape stops the reader', () => {
  const real = (rel: string) => read(rel)
  const withFile = (rel: string, change: (text: string) => string) => (path: string) =>
    path === rel ? change(real(path)) : real(path)

  it('a 3D engine whose list lost its declared length', () => {
    const reader = withFile(SOURCES.mesh3d, (t) => t.replace(/const PINNED: \[&str; \d+\]/, 'const PINNED: [&str; 3]'))
    expect(() => readEnginePins(reader)).toThrow(/mesh3d\.rs.*declares 3 entries/)
  })

  it('a renamed constant', () => {
    const reader = withFile(SOURCES.mflux, (t) => t.replace('const PINNED:', 'const PINS:'))
    expect(() => readEnginePins(reader)).toThrow(/image_mflux\.rs.*PINNED/)
  })

  it('a declared length that is not the number of entries', () => {
    const reader = withFile(SOURCES.mflux, (t) => t.replace(/const PINNED: \[&str; \d+\]/, 'const PINNED: [&str; 99]'))
    expect(() => readEnginePins(reader)).toThrow(/declares 99 entries/)
  })

  it('an open bound instead of a pin', () => {
    const reader = withFile(SOURCES['mlx-video'], (t) => t.replace(/"mlx==[^"]+"/, '"mlx>=0.31"'))
    expect(() => readEnginePins(reader)).toThrow(/mlx>=0\.31.*neither/)
  })

  it('an open bound in the requirements file', () => {
    const reader = withFile(SOURCES.image, (t) => t.replace(/^torch==.*$/m, 'torch>=2.4'))
    expect(() => readEnginePins(reader)).toThrow(/torch>=2\.4/)
  })

  it('a changed address template of the second video engine', () => {
    const reader = withFile(SOURCES['ltx-2-mlx'], (t) => t.replace('#subdirectory=packages/{p}', '#subdirectory={p}'))
    expect(() => readEnginePins(reader)).toThrow(/address template/)
  })

  it('a commit that is a branch name', () => {
    const reader = withFile(SOURCES['ltx-2-mlx'], (t) => t.replace(/const COMMIT: &str = "[0-9a-f]{40}"/, 'const COMMIT: &str = "main"'))
    expect(() => readEnginePins(reader)).toThrow(/not a full commit id/)
  })

  it('an empty requirements file', () => {
    const reader = withFile(SOURCES.image, () => '# nothing\n')
    expect(() => readEnginePins(reader)).toThrow(/no package was read/)
  })
})

describe('the small readers', () => {
  it('a pin in a comment is not a pin', () => {
    const rust = '// const PINNED: [&str; 1] = ["old==1.0"];\nconst PINNED: [&str; 1] = ["new==2.0"];\n'
    expect(rustStrArray(rust, 'PINNED')).toEqual(['new==2.0'])
  })

  it('a constant may break after the equals sign', () => {
    expect(rustStrConst('const A: &str =\n    "x @ https://e/x.zip";', 'A')).toBe('x @ https://e/x.zip')
  })

  it('requirement lines lose comments and blank lines', () => {
    expect(requirementLines('# a\n\ntorch==1.0  # why\n  pillow==2.0\n')).toEqual(['torch==1.0', 'pillow==2.0'])
  })

  it('knows a pin from a bound', () => {
    expect(isPinned('uvicorn[standard]==0.49.0')).toBe(true)
    expect(isPinned('opencv-python==4.13.0.90')).toBe(true)
    expect(isPinned('a @ https://github.com/x/y/archive/abc.zip#subdirectory=p')).toBe(true)
    expect(isPinned('torch')).toBe(false)
    expect(isPinned('torch>=2.4')).toBe(false)
    expect(isPinned('torch==2.*')).toBe(false)
    expect(isPinned('a @ git+https://github.com/x/y')).toBe(false)
  })
})
