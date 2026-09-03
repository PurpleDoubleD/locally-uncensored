/**
 * Ambient types for the deep `react-syntax-highlighter` entry points.
 *
 * Why this file exists
 * ────────────────────
 * `react-syntax-highlighter` ships no types of its own, and while
 * `@types/react-syntax-highlighter` declares ~1100 ambient modules, that file
 * never reaches the program: `tsconfig.app.json` pins `"types"` to
 * `["vite/client", "vitest/globals"]`, which switches off automatic `@types`
 * inclusion, and nothing in `src/` imports the bare `react-syntax-highlighter`
 * specifier that would otherwise pull the declaration file in. Every deep
 * import in `components/chat/CodeBlock.tsx` therefore resolved to a plain
 * `.js` file with no declaration → 39 × TS7016.
 *
 * DefinitelyTyped declares every grammar as the untyped escape hatch, so
 * pointing the compiler at that file would have traded 39 errors for 37
 * unchecked values. These declarations are written against the shipped
 * modules instead — every grammar entry point
 * under `dist/esm/languages/prism/` is a one-line re-export of the matching
 * `refractor/<name>` module, so re-exporting the same binding here reproduces
 * refractor's real `Syntax` type rather than approximating it, and cannot
 * drift from the runtime.
 *
 * Prop coverage is deliberately narrow: only what `CodeBlock.tsx` passes is
 * declared. Widen it here when a call site needs more — do not reach for an
 * index signature.
 */

declare module 'react-syntax-highlighter/dist/esm/prism-light' {
  import type { CSSProperties, FC } from 'react'
  import type { Syntax } from 'refractor/core'

  export interface PrismLightProps {
    /** Grammar name or alias; unregistered names render unhighlighted. */
    language?: string
    /** A prism theme: CSS-class selector → inline style. */
    style?: Record<string, CSSProperties>
    /** Merged onto the generated `<pre>`. */
    customStyle?: CSSProperties
    /** The source to highlight. */
    children: string | string[]
  }

  /**
   * `prism-light` builds the component from refractor's bare core and exposes
   * the two registration statics; `registerLanguage` ignores its `name`
   * argument at runtime and registers under the grammar's own `displayName`.
   */
  const SyntaxHighlighter: FC<PrismLightProps> & {
    registerLanguage: (name: string, syntax: Syntax) => void
    alias: {
      (name: string, alias: ReadonlyArray<string> | string): void
      (aliases: Record<string, ReadonlyArray<string> | string>): void
    }
  }

  export default SyntaxHighlighter
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism/one-dark' {
  import type { CSSProperties } from 'react'
  const style: Record<string, CSSProperties>
  export default style
}

// ── Grammars ───────────────────────────────────────────────────────────────
//
// One block per grammar `CodeBlock.tsx` registers. Listing them individually
// rather than with a `.../prism/*` wildcard keeps the compiler able to reject
// a misspelled or unshipped grammar import, which is the point of having the
// typecheck run at all.

declare module 'react-syntax-highlighter/dist/esm/languages/prism/bash' {
  export { default } from 'refractor/bash'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/batch' {
  export { default } from 'refractor/batch'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/c' {
  export { default } from 'refractor/c'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/cpp' {
  export { default } from 'refractor/cpp'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/csharp' {
  export { default } from 'refractor/csharp'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/css' {
  export { default } from 'refractor/css'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/dart' {
  export { default } from 'refractor/dart'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/diff' {
  export { default } from 'refractor/diff'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/docker' {
  export { default } from 'refractor/docker'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/go' {
  export { default } from 'refractor/go'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/graphql' {
  export { default } from 'refractor/graphql'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/groovy' {
  export { default } from 'refractor/groovy'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/hcl' {
  export { default } from 'refractor/hcl'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/ini' {
  export { default } from 'refractor/ini'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/java' {
  export { default } from 'refractor/java'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/javascript' {
  export { default } from 'refractor/javascript'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/json' {
  export { default } from 'refractor/json'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/jsx' {
  export { default } from 'refractor/jsx'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/kotlin' {
  export { default } from 'refractor/kotlin'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/less' {
  export { default } from 'refractor/less'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/lua' {
  export { default } from 'refractor/lua'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/makefile' {
  export { default } from 'refractor/makefile'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/markdown' {
  export { default } from 'refractor/markdown'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/markup' {
  export { default } from 'refractor/markup'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/php' {
  export { default } from 'refractor/php'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/powershell' {
  export { default } from 'refractor/powershell'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/python' {
  export { default } from 'refractor/python'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/r' {
  export { default } from 'refractor/r'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/ruby' {
  export { default } from 'refractor/ruby'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/rust' {
  export { default } from 'refractor/rust'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/scss' {
  export { default } from 'refractor/scss'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/sql' {
  export { default } from 'refractor/sql'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/swift' {
  export { default } from 'refractor/swift'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/toml' {
  export { default } from 'refractor/toml'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/tsx' {
  export { default } from 'refractor/tsx'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/typescript' {
  export { default } from 'refractor/typescript'
}
declare module 'react-syntax-highlighter/dist/esm/languages/prism/yaml' {
  export { default } from 'refractor/yaml'
}
