/**
 * A16 (A14-1a), Windows counter-check 02.09.: the rename to "LU Engine" held
 * everywhere the counter-check looked in 2.6.8, with one leftover it could
 * name: "Cannot reach the built-in embeddings server." That sentence is about
 * the embeddings sidecar rather than the chat engine, so it slipped past the
 * checklist, and standing next to "LU Engine" everywhere else it simply reads
 * as a second product.
 *
 * This is the sweep that keeps the next one from slipping through. It reads
 * every source file the app ships, throws the comments away, and fails on any
 * remaining "built-in" in text that can reach a user, a log line included.
 *
 * Second pass, same counter-check: the first version of this sweep only knew
 * "built-in engine" and "built-in embeddings", and the rename it was guarding
 * was not finished. It missed "Create built-in models dir", "already exists in
 * the built-in models folder", "Could not link the model into the built-in
 * folder", "Starting built-in llama-server", "Built-in embeddings server
 * healthy", "the built-in /v1/embeddings endpoint" and "Could not resolve the
 * built-in models directory." Two reasons: the pattern stopped at two nouns,
 * and the Rust side, where half of those live, was never read at all. Both are
 * fixed here.
 *
 * Deliberately NOT covered:
 *   - `release-notes.ts`. Notes for 2.6.7 and older describe the app as it was
 *     called then, and rewriting history there would make the notes lie.
 *   - `lib/engine-name.ts`. It holds the old display name on purpose:
 *     `LEGACY_ENGINE_NAME` is what sits in provider configs written before
 *     2.6.8, and `isLuEngineName` has to keep recognising it.
 *   - The legacy matcher in `commands/download.rs`, for the same reason one
 *     step further down: those spellings are what older callers send, so the
 *     old name IS the data there.
 *   - Code identifiers (`isBuiltinEngineEntry`, `builtin_*`, `activateBuiltinModel`).
 *     They are not text on a screen and renaming them would be a large diff
 *     with no reader.
 *   - Other things that are genuinely built in: ComfyUI's own nodes and VAEs,
 *     LU's built-in workflows and personas, the built-in HTTP server behind
 *     Remote Access. Those keep the adjective because it is true of them, and
 *     the pattern below is deliberately narrow enough to walk past them.
 *
 * Limit worth knowing: the comment stripper is a regular expression, not a
 * parser. It can swallow the tail of a string containing `//`, so the sweep can
 * miss a hit hidden behind a URL inside a literal. It cannot invent one.
 *
 * Run: npx vitest run src/lib/__tests__/no-built-in-engine-left-on-screen.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../..')
const RUST_SRC = resolve(HERE, '../../../src-tauri/src')

/**
 * The old name, in every spelling that ever shipped.
 *
 * The noun list is what the second pass added. "built-in" on its own is not
 * the target: plenty of things in this app really are built in and say so
 * honestly. What is banned is the adjective standing where the product name
 * belongs, and these are the words the engine and its folder are named with.
 */
const OLD_NAME = /built[-\s]?in\s+(engine|embedding|model|folder|llama-server|\/v1\/embeddings)/i

const EXEMPT = [
  'lib/release-notes.ts',
  'lib/engine-name.ts',
]

/**
 * Rust lines that are exempt, and the whole reason each one is.
 *
 * A line, not a file: exempting `download.rs` outright would hide every future
 * message in a 1200 line file behind one legacy matcher.
 */
const RUST_EXEMPT_LINES = [
  // The legacy provider-id matcher. These strings arrive from configs and
  // callers written before 2.6.8, so the old spelling is input, not output.
  '"builtin" | "lu engine" | "built-in engine" | "built in engine" =>',
]

function sourceFiles(dir: string, ext: RegExp): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'target') continue
      out.push(...sourceFiles(full, ext))
    } else if (ext.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** Everything that is not a comment. See the limit noted at the top. Serves
 *  both languages: `//` and `/* *\/` mean the same in Rust, and `///` doc
 *  comments fall out with the rest. */
function withoutComments(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, '$1'))
}

/**
 * The double-quoted spans of a Rust line.
 *
 * Rust code is full of identifiers built from the same word (`builtin_models_dir`,
 * `is_builtin_generation_url`), and renaming those would be a large diff with
 * no reader, exactly as on the TypeScript side. So only string literals are
 * read here, because a string literal is the only thing in a .rs file that can
 * end up in front of a user or in a log.
 */
function rustStrings(line: string): string {
  return (line.match(/"(?:[^"\\]|\\.)*"/g) ?? []).join(' ')
}

describe('the old engine name is gone from everything a user can read', () => {
  it('leaves no "built-in engine" or "built-in embeddings" in src/', () => {
    const left: string[] = []
    for (const file of sourceFiles(SRC, /\.(ts|tsx)$/)) {
      const rel = relative(SRC, file).replace(/\\/g, '/')
      if (EXEMPT.some((e) => rel.endsWith(e))) continue
      withoutComments(readFileSync(file, 'utf8')).forEach((line, i) => {
        if (OLD_NAME.test(line)) left.push(`src/${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(left, `the old name is still on screen:\n${left.join('\n')}`).toEqual([])
  })

  it('and none in the Rust messages and log lines either', () => {
    // Where the counter-check's remaining leftovers actually lived. Rust
    // writes the folder errors the Model Storage panel shows and the engine
    // log lines a support answer is read out of, and none of that was swept.
    const left: string[] = []
    for (const file of sourceFiles(RUST_SRC, /\.rs$/)) {
      const rel = relative(RUST_SRC, file).replace(/\\/g, '/')
      withoutComments(readFileSync(file, 'utf8')).forEach((line, i) => {
        if (RUST_EXEMPT_LINES.some((e) => line.includes(e))) return
        if (OLD_NAME.test(rustStrings(line))) left.push(`src-tauri/src/${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(left, `the old name is still in a Rust string:\n${left.join('\n')}`).toEqual([])
  })

  // NEGATIVE CONTROL: the sweep has to be able to see the thing it is looking
  // for. Without this a broken matcher would report a clean house forever.
  it('really does recognise the old name', () => {
    const seen = [
      'Cannot reach the built-in embeddings server.',
      'the Built-in Engine loads it',
      'moved to the built in engine',
      "log.warn('[x] built-in engine resume failed')",
      // The seven the second pass added, verbatim from where they stood.
      'Create built-in models dir: {}',
      'A model named {} already exists in the built-in models folder',
      'Could not link the model into the built-in folder ({e}).',
      '[Engine] Starting built-in llama-server on port {port}',
      '[Engine] Built-in embeddings server healthy on port {port}',
      'Unexpected response from the built-in /v1/embeddings endpoint',
      'Could not resolve the built-in models directory.',
    ].filter((s) => OLD_NAME.test(s))
    expect(seen).toHaveLength(11)
    // And it is not simply matching everything. These things really are built
    // in and keep the word: ComfyUI's own nodes, LU's workflows and personas,
    // and the HTTP server Remote Access runs on.
    for (const innocent of [
      "ComfyUI's built-in inpaint nodes",
      'Use the built-in workflow',
      'the built-in VAE',
      'built-in HTTP server, secure passcodes, Cloudflare tunnel',
      'rebuilds built-in personas while migrating',
    ]) {
      expect(OLD_NAME.test(innocent), `swept an innocent: ${innocent}`).toBe(false)
    }
  })

  // NEGATIVE CONTROL: only STRING literals are read on the Rust side, or the
  // sweep would demand a rename of every `builtin_*` function in the crate.
  it('reads Rust strings and not Rust identifiers', () => {
    expect(OLD_NAME.test(rustStrings('pub fn builtin_models_dir() -> Result<PathBuf, String> {'))).toBe(false)
    expect(OLD_NAME.test(rustStrings('    let dir = builtin_models_dir()?;'))).toBe(false)
    expect(OLD_NAME.test(rustStrings('    println!("[Engine] Starting built-in llama-server");'))).toBe(true)
  })

  // NEGATIVE CONTROL: the exemptions are exemptions, not a hole big enough to
  // hide the whole app in. Each must still contain what it is exempt for, or
  // the exemption is stale and should go.
  it('keeps the exemptions honest', () => {
    const legacy = readFileSync(join(SRC, 'lib/engine-name.ts'), 'utf8')
    expect(legacy, 'engine-name.ts no longer needs its exemption').toMatch(OLD_NAME)
    const notes = readFileSync(join(SRC, 'lib/release-notes.ts'), 'utf8')
    expect(notes, 'release-notes.ts no longer needs its exemption').toMatch(OLD_NAME)
    const download = readFileSync(join(RUST_SRC, 'commands/download.rs'), 'utf8')
    for (const line of RUST_EXEMPT_LINES) {
      expect(download, `download.rs no longer holds the exempt line: ${line}`).toContain(line)
    }
  })
})
