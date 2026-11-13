#!/usr/bin/env node
// mac-engine-pins.mjs: what the Mac media engines hand to pip, read from
// the place the app itself reads it from.
//
// WHY THIS EXISTS
// ---------------
// The engines are not part of the .app. A customer's Mac resolves their
// packages from PyPI and GitHub the first time a model is installed, so a
// yanked release or a wheel that is missing for arm64 shows up there and
// nowhere else. `macos-gate` in ci.yml asks pip the same question ahead of
// time (scripts/mac-engine-pins-dry-run.sh, `pip install --dry-run`).
//
// The lists are NOT copied into this file. Four of them are Rust constants,
// one is a requirements file, and a copy would be out of date the day
// somebody moves a pin. This file parses the sources and refuses to answer
// when a source no longer has the shape it reads: a declared array length
// that does not match, a constant that is gone, an entry that is neither
// `name==version` nor `name @ https://...`. A wrong answer here would be a
// green check on the wrong packages.
//
//   engine      source
//   image       src-tauri/resources/mlx/requirements.txt   (pip reads it itself)
//   mflux       src-tauri/src/commands/image_mflux.rs      PINNED
//   mlx-video   src-tauri/src/commands/video.rs            MLX_VIDEO_PINNED, MLX_VIDEO_PIP_SPEC
//   ltx-2-mlx   src-tauri/src/commands/video_ltx2mlx.rs    PINNED, PACKAGES, SOURCE, COMMIT
//   mesh3d      src-tauri/src/commands/mesh3d.rs           PINNED (the TripoSR source is
//                                                          not a pip package: Rust fetches
//                                                          it by sha256, so pip never sees it)
//
// Usage:
//   node scripts/mac-engine-pins.mjs                 # print the lists
//   node scripts/mac-engine-pins.mjs --json          # the same as JSON
//   node scripts/mac-engine-pins.mjs --write <dir>   # one <engine>.txt per engine, for `pip -r`
//
// Guard: src/lib/__tests__/mac-engine-pins.test.ts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..')

export const SOURCES = {
  image: 'src-tauri/resources/mlx/requirements.txt',
  mflux: 'src-tauri/src/commands/image_mflux.rs',
  'mlx-video': 'src-tauri/src/commands/video.rs',
  'ltx-2-mlx': 'src-tauri/src/commands/video_ltx2mlx.rs',
  mesh3d: 'src-tauri/src/commands/mesh3d.rs',
}

/** The Python line the app's own interpreter is on, e.g. "3.12". */
export const PYTHON_PIN_FILE = 'src-tauri/resources/voice_loop/python.json'

/**
 * How video_ltx2mlx.rs builds the address of one of its two packages. The
 * template is repeated in `ltxSpecs` below because Rust's `format!` cannot be
 * run from here. `readEnginePins` requires this exact literal in the Rust
 * source, so a change over there stops this script and does not pass it by.
 */
export const LTX_SPEC_TEMPLATE = '{p} @ {SOURCE}/{COMMIT}.zip#subdirectory=packages/{p}'

const EXACT_PIN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?==[0-9][A-Za-z0-9.+!_-]*$/
const URL_PIN = /^[A-Za-z0-9][A-Za-z0-9._-]* @ https:\/\/\S+$/

/** True for `name==version` and for `name @ https://...`, false for an open bound. */
export function isPinned(spec) {
  return EXACT_PIN.test(spec) || URL_PIN.test(spec)
}

/** Comments out, so a pin that is only mentioned in prose is not read as one. */
function withoutRustComments(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

/**
 * `const NAME: [&str; N] = ["a", "b"];` as a list. The declared length is
 * compared with what was read: a parser that silently reads three of four
 * entries is worse than none.
 */
export function rustStrArray(source, name) {
  const code = withoutRustComments(source)
  const re = new RegExp(`\\bconst ${name}: \\[&str; (\\d+)\\] =\\s*\\[([^\\]]*)\\];`)
  const found = code.match(re)
  if (!found) throw new Error(`no \`const ${name}: [&str; N] = [...]\` found`)
  const declared = Number(found[1])
  const items = [...found[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
  if (items.length !== declared) {
    throw new Error(`${name} declares ${declared} entries, ${items.length} were read`)
  }
  return items
}

/** `const NAME: &str = "value";`, the value may sit on the next line. */
export function rustStrConst(source, name) {
  const code = withoutRustComments(source)
  const re = new RegExp(`\\bconst ${name}: &str =\\s*"((?:[^"\\\\]|\\\\.)*)";`)
  const found = code.match(re)
  if (!found) throw new Error(`no \`const ${name}: &str = "..."\` found`)
  return found[1]
}

/** The lines of a requirements file that name a package. */
export function requirementLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

function ltxSpecs(source) {
  if (!source.includes(`"${LTX_SPEC_TEMPLATE}"`)) {
    throw new Error(
      `the address template "${LTX_SPEC_TEMPLATE}" is gone from pip_specs(); ` +
        'scripts/mac-engine-pins.mjs repeats it and has to follow',
    )
  }
  const base = rustStrConst(source, 'SOURCE')
  const commit = rustStrConst(source, 'COMMIT')
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`COMMIT is not a full commit id: ${commit}`)
  const packages = rustStrArray(source, 'PACKAGES')
  return [
    ...rustStrArray(source, 'PINNED'),
    ...packages.map((p) => `${p} @ ${base}/${commit}.zip#subdirectory=packages/${p}`),
  ]
}

/**
 * The five lists. `read` takes a path relative to the repository and returns
 * the file's text; the default reads the working tree.
 */
export function readEnginePins(read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')) {
  const engines = []
  const add = (id, label, build) => {
    const source = SOURCES[id]
    let specs
    try {
      specs = build(read(source))
    } catch (error) {
      throw new Error(`${source} (${label}): ${error.message}`)
    }
    if (specs.length === 0) throw new Error(`${source} (${label}): no package was read`)
    for (const spec of specs) {
      if (!isPinned(spec)) {
        throw new Error(`${source} (${label}): "${spec}" is neither name==version nor name @ https://...`)
      }
    }
    engines.push({ id, label, source, specs })
  }

  add('image', 'image sidecar', requirementLines)
  add('mflux', 'second image engine (mflux)', (src) => rustStrArray(src, 'PINNED'))
  add('mlx-video', 'first video engine (mlx-video)', (src) => [
    ...rustStrArray(src, 'MLX_VIDEO_PINNED'),
    rustStrConst(src, 'MLX_VIDEO_PIP_SPEC'),
  ])
  add('ltx-2-mlx', 'second video engine (ltx-2-mlx)', ltxSpecs)
  add('mesh3d', '3D engine (TripoSR)', (src) => rustStrArray(src, 'PINNED'))
  return engines
}

/** "3.12" from python.json's "3.12.15". */
export function pythonLine(read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')) {
  const version = JSON.parse(read(PYTHON_PIN_FILE)).version
  const found = /^(\d+\.\d+)\.\d+$/.exec(String(version))
  if (!found) throw new Error(`${PYTHON_PIN_FILE}: "version" is not x.y.z: ${version}`)
  return found[1]
}

function main(argv) {
  const engines = readEnginePins()
  if (argv[0] === '--json') {
    process.stdout.write(JSON.stringify({ python: pythonLine(), engines }, null, 2) + '\n')
    return
  }
  if (argv[0] === '--python') {
    process.stdout.write(pythonLine() + '\n')
    return
  }
  if (argv[0] === '--write') {
    const dir = argv[1]
    if (!dir) throw new Error('--write needs a directory')
    mkdirSync(dir, { recursive: true })
    for (const engine of engines) {
      writeFileSync(join(dir, `${engine.id}.txt`), engine.specs.join('\n') + '\n')
      process.stdout.write(`${engine.id}\n`)
    }
    return
  }
  if (argv.length > 0) throw new Error(`unknown argument: ${argv[0]}`)
  for (const engine of engines) {
    process.stdout.write(`# ${engine.label}, from ${engine.source}\n${engine.specs.join('\n')}\n\n`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`FAIL: ${error.message}\n`)
    process.exit(1)
  }
}
