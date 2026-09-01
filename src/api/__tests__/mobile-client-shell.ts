/**
 * Runs a single function out of `mobile-client/client.js` — the shipped one.
 *
 * ── Why this exists at all ──
 *
 * T-75 pulled the mobile client out of a Rust string. Most of its brain moved
 * into three real ES modules (`caveman.js`, `personas.js`, `agent-core.js`)
 * that tests simply `import`, and that is what you should reach for. This
 * helper is for the rest: functions that live in `client.js`, the 2 100-line
 * shell that touches `document`, `fetch` and `localStorage` on the first line
 * and therefore cannot be imported into a Node test.
 *
 * Two of them are worth testing anyway, because they decide what the model is
 * told rather than what the screen shows: `buildSystemPrompt` and the client's
 * own `isThinkingCompatible`. Both are pure once their surroundings are
 * supplied. So: cut the declaration out by name, evaluate it with the names it
 * refers to passed in, and run the real body.
 *
 * ── What this is NOT ──
 *
 * It is not the old pattern coming back in. What T-75 removed was a
 * hand-written TypeScript re-implementation of `buildSystemPrompt` sitting
 * next to the real one and being tested instead of it — two copies, one
 * maintained. This runs the shipped bytes. It is weaker than an import in
 * exactly one way, and the way is named and guarded: it locates a declaration
 * by name in a real `.js` file, and if the name is gone it throws instead of
 * quietly testing nothing.
 *
 * The reason `buildSystemPrompt` cannot simply be exported is worth writing
 * down, because "just move it too" is the obvious next thought: it reads
 * `chats`, `currentChatId` and `dispatchedSystemPrompt`, which `client.js`
 * ASSIGNS to. An ES module binding is read-only in the importer, so those
 * variables have to stay in the file that mutates them, and everything that
 * closes over them stays with them.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// `__dirname` rather than `new URL(import.meta.url).pathname`: on Windows the
// latter is `/C:/…`, which `resolve` does not undo. The repository normalises
// line endings for exactly this class of reason (.gitattributes).
const CLIENT_JS = resolve(__dirname, '..', '..', '..', 'mobile-client', 'client.js')

export const clientSource = (): string => readFileSync(CLIENT_JS, 'utf8')

/**
 * The source text of one top-level declaration in `client.js`.
 *
 * Top level means "two spaces in", which is where every declaration inside the
 * client's single IIFE sits. A `function` runs to the first closing brace at
 * that indentation; a `var` must fit on one line, and anything else throws
 * rather than guessing at a boundary.
 */
export function declarationSource(name: string): string {
  const src = clientSource()

  const fnHead = `\n  function ${name}(`
  const fnAt = src.indexOf(fnHead)
  if (fnAt !== -1) {
    const end = src.indexOf('\n  }', fnAt + fnHead.length)
    if (end === -1) {
      throw new Error(
        `mobile-client/client.js: function ${name} has no closing brace at top-level indentation`,
      )
    }
    return src.slice(fnAt + 1, end + '\n  }'.length)
  }

  // The inline handlers the page's HTML calls are hung on `window`, so they
  // are assignments rather than declarations. Same body, same closing brace.
  const winHead = `\n  window.${name} = function(`
  const winAt = src.indexOf(winHead)
  if (winAt !== -1) {
    const end = src.indexOf('\n  }', winAt + winHead.length)
    if (end === -1) {
      throw new Error(
        `mobile-client/client.js: window.${name} has no closing brace at top-level indentation`,
      )
    }
    return src.slice(winAt + 1, end + '\n  }'.length)
  }

  const varHead = `\n  var ${name} = `
  const varAt = src.indexOf(varHead)
  if (varAt !== -1) {
    const end = src.indexOf('\n', varAt + 1)
    const line = src.slice(varAt + 1, end)
    if (!line.trimEnd().endsWith(';')) {
      throw new Error(
        `mobile-client/client.js: var ${name} spans more than one line; ` +
          'export it from one of the three modules instead of cutting it out here',
      )
    }
    return line
  }

  throw new Error(
    `mobile-client/client.js declares none of "function ${name}(", "window.${name} = function(" ` +
      `or "var ${name} = ". ` +
      'It was renamed or deleted, and every assertion built on it would otherwise ' +
      'have silently stopped testing anything.',
  )
}

/**
 * Evaluates the named declarations with `deps` in scope and returns them.
 *
 * `deps` is the surrounding scope the cut-out code still refers to: pass the
 * real imported constants where you have them, and stubs for the state
 * accessors. A name the code needs and `deps` does not carry throws a
 * ReferenceError on the first call, which is loud and points at the line.
 */
export function loadFromClient<T extends Record<string, unknown>>(
  names: string[],
  deps: Record<string, unknown> = {},
): T {
  const body = names.map(declarationSource).join('\n')
  const depNames = Object.keys(deps)
  const factory = new Function(
    ...depNames,
    `${body}\nreturn { ${names.join(', ')} };`,
  ) as (...args: unknown[]) => T
  return factory(...depNames.map((k) => deps[k]))
}
