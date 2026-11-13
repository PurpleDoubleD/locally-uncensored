/**
 * The Arguments field of an MCP server is one line of text, but the server
 * receives a list. Splitting on a single space made a path with spaces
 * impossible ("Application Support", "My Tools") and turned a double space
 * into an empty argument that stopped the server from starting.
 *
 * Simple shell-like rules: runs of whitespace separate arguments, "..." and
 * '...' group text with spaces into one argument, and inside "..." only \"
 * and \\ are escapes. Outside quotes a backslash is a plain character, so
 * a Windows path like C:\Tools\server.js arrives as typed. No variables, no
 * globbing. `joinArgs` is the reverse, so opening a saved server for editing
 * and saving it again keeps the list unchanged.
 */
export function parseArgs(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (quote === '"') {
      if (c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i]
      else if (c === '"') quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
      continue
    }
    if (/\s/.test(c)) {
      if (has) out.push(cur)
      cur = ''
      has = false
      continue
    }
    cur += c
    has = true
  }
  if (has) out.push(cur)
  return out
}

/** Quote one argument only when it needs it, so plain args stay readable. */
function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s"']/.test(arg)) return arg
  if (!arg.includes("'")) return `'${arg}'`
  return `"${arg.replace(/[\\"]/g, (m) => `\\${m}`)}"`
}

export function joinArgs(args: string[]): string {
  return args.map(quoteArg).join(' ')
}
