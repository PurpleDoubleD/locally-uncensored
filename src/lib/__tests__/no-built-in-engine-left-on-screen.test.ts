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
 * remaining "built-in engine" / "built-in embeddings" in text that can reach a
 * user, a log line included.
 *
 * Deliberately NOT covered:
 *   - `release-notes.ts`. Notes for 2.6.7 and older describe the app as it was
 *     called then, and rewriting history there would make the notes lie.
 *   - `lib/engine-name.ts`. It holds the old display name on purpose:
 *     `LEGACY_ENGINE_NAME` is what sits in provider configs written before
 *     2.6.8, and `isLuEngineName` has to keep recognising it.
 *   - Code identifiers (`isBuiltinEngineEntry`, `builtin_*`, `activateBuiltinModel`).
 *     They are not text on a screen and renaming them would be a large diff
 *     with no reader.
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

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The old name, in every spelling that ever shipped. */
const OLD_NAME = /built[-\s]?in\s+(engine|embedding)/i

const EXEMPT = [
  'lib/release-notes.ts',
  'lib/engine-name.ts',
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      out.push(...sourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** Everything that is not a comment. See the limit noted at the top. */
function withoutComments(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, '$1'))
}

describe('the old engine name is gone from everything a user can read', () => {
  it('leaves no "built-in engine" or "built-in embeddings" in src/', () => {
    const left: string[] = []
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/')
      if (EXEMPT.some((e) => rel.endsWith(e))) continue
      withoutComments(readFileSync(file, 'utf8')).forEach((line, i) => {
        if (OLD_NAME.test(line)) left.push(`src/${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(left, `the old name is still on screen:\n${left.join('\n')}`).toEqual([])
  })

  // NEGATIVE CONTROL: the sweep has to be able to see the thing it is looking
  // for. Without this a broken matcher would report a clean house forever.
  it('really does recognise the old name', () => {
    const seen = [
      'Cannot reach the built-in embeddings server.',
      'the Built-in Engine loads it',
      'moved to the built in engine',
      "log.warn('[x] built-in engine resume failed')",
    ].filter((s) => OLD_NAME.test(s))
    expect(seen).toHaveLength(4)
    // And it is not simply matching everything: ComfyUI's own built-in nodes
    // and LU's built-in workflows are other things with the same adjective.
    expect(OLD_NAME.test("ComfyUI's built-in inpaint nodes")).toBe(false)
    expect(OLD_NAME.test('Use the built-in workflow')).toBe(false)
  })

  // NEGATIVE CONTROL: the exemptions are exemptions, not a hole big enough to
  // hide the whole app in. Both named files must still contain what they are
  // exempt for, or the exemption is stale and should go.
  it('keeps the two exemptions honest', () => {
    const legacy = readFileSync(join(SRC, 'lib/engine-name.ts'), 'utf8')
    expect(legacy, 'engine-name.ts no longer needs its exemption').toMatch(OLD_NAME)
    const notes = readFileSync(join(SRC, 'lib/release-notes.ts'), 'utf8')
    expect(notes, 'release-notes.ts no longer needs its exemption').toMatch(OLD_NAME)
  })
})
