/**
 * "Always allow `npm test` here" (CA K4).
 *
 * Claude Code, Codex, Cursor, Windsurf and VS Code all let the user approve a
 * command once and for the future, scoped to a project and to the command's
 * prefix, so a run that tests after every edit does not ask twenty times. LU
 * only had "ask for every command" or "stop asking for everything". These are
 * the pure rules; the store keeps them per folder (stores/commandRulesStore).
 *
 * The safety properties:
 * - A chained command is allowed only when EVERY part is (`npm test && rm -rf x`
 *   needs `rm` too). Pipes count as parts.
 * - Substitution (`$(…)`, backticks, `<(…)`) and output redirection are never
 *   allowed by a rule: the part that runs or writes is not the prefix the user
 *   approved.
 * - For programs that can do anything with their arguments (rm, sudo, curl,
 *   sh, python -c …) the suggested rule is the exact command, never a prefix.
 * - The hard shell block list (lib/shell-command-classify) still applies at
 *   execution, in every mode, whatever a rule says.
 */

/** Programs whose second word is the real command (`npm test`, `git status`). */
const TWO_WORD_PROGRAMS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'deno', 'node', 'git', 'gh', 'cargo', 'go', 'pip', 'pip3', 'uv',
  'poetry', 'make', 'docker', 'kubectl', 'dotnet', 'mvn', 'gradle', 'swift', 'rustup', 'brew', 'conda',
])

/** Programs a prefix rule must never cover: their arguments ARE the action. */
const EXACT_ONLY_PROGRAMS = new Set([
  'rm', 'rmdir', 'sudo', 'su', 'doas', 'chmod', 'chown', 'dd', 'mkfs', 'curl', 'wget', 'sh', 'bash', 'zsh', 'fish',
  'eval', 'exec', 'xargs', 'env', 'ssh', 'scp', 'rsync', 'mv', 'kill', 'killall', 'pkill', 'osascript', 'open',
  'powershell', 'pwsh', 'cmd', 'reg', 'shutdown', 'reboot', 'launchctl', 'crontab',
])

/** Interpreters: a script file is a fine prefix, inline code is not. */
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun'])
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '-p', '--print', '-'])

/** Split on && || ; | and newlines, outside quotes. Null when the command has
 *  substitution or redirection a rule must not cover. */
export function splitCommandChain(command: string): string[] | null {
  const parts: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  const s = command.trim()
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < s.length) { cur += ch + s[++i]; continue }
      if (ch === quote) quote = null
      // Substitution inside double quotes still runs.
      if (quote === '"' && ch === '$' && s[i + 1] === '(') return null
      if (quote === '"' && ch === '`') return null
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '\\' && i + 1 < s.length) { cur += ch + s[++i]; continue }
    if (ch === '`') return null
    if ((ch === '$' || ch === '<') && s[i + 1] === '(') return null
    if (ch === '>' || ch === '<') return null
    if (ch === '&' && s[i + 1] === '&') { parts.push(cur); cur = ''; i++; continue }
    if (ch === '|' && s[i + 1] === '|') { parts.push(cur); cur = ''; i++; continue }
    if (ch === '&') return null // background job: not the command that was approved
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  if (quote) return null
  parts.push(cur)
  const out = parts.map((p) => p.trim()).filter(Boolean)
  return out.length ? out : null
}

function words(part: string): string[] {
  return part.trim().split(/\s+/).filter(Boolean)
}

/** Leading `FOO=bar` assignments change what runs; a rule never skips them. */
function hasEnvPrefix(part: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(part.trim())
}

function program(w: string): string {
  // `./node_modules/.bin/vitest` → vitest; `/usr/bin/git` → git.
  return w.split('/').pop()!.toLowerCase()
}

/**
 * The rule to offer for one command, or null when only "this once" is safe.
 * `npm test -- math` → `npm test`; `python3 app.py` → `python3 app.py`;
 * `rm -rf build` → the exact command; a chain → null.
 */
export function suggestRuleFor(command: string): string | null {
  const parts = splitCommandChain(command)
  if (!parts || parts.length !== 1) return null
  const part = parts[0]
  if (hasEnvPrefix(part)) return null
  const w = words(part)
  if (w.length === 0) return null
  const prog = program(w[0])
  if (EXACT_ONLY_PROGRAMS.has(prog)) return part
  if (INTERPRETERS.has(prog)) {
    // `python3 app.py`, `node script.js`, `bun test`: the script or the
    // subcommand, never the bare interpreter.
    if (w.length < 2 || INLINE_CODE_FLAGS.has(w[1]) || w[1].startsWith('-')) return null
    return `${w[0]} ${w[1]}`
  }
  if (TWO_WORD_PROGRAMS.has(prog) && w.length >= 2 && !w[1].startsWith('-')) {
    // `npm run build` keeps the script name: `npm run` alone would allow every script.
    if ((prog === 'npm' || prog === 'pnpm' || prog === 'yarn' || prog === 'bun') && w[1] === 'run' && w[2]) {
      return `${w[0]} run ${w[2]}`
    }
    return `${w[0]} ${w[1]}`
  }
  return w[0]
}

/** Does one part fall under one rule? Prefix on whole words only. */
function partMatches(part: string, rule: string): boolean {
  const p = words(part)
  const r = words(rule)
  if (r.length === 0 || p.length < r.length) return false
  if (hasEnvPrefix(part)) return false
  const prog = program(p[0])
  // An exact-only program needs the exact command, whatever the rule looks like.
  if (EXACT_ONLY_PROGRAMS.has(prog)) return p.join(' ') === r.join(' ')
  if (INTERPRETERS.has(prog) && INLINE_CODE_FLAGS.has(p[1] ?? '')) return false
  for (let i = 0; i < r.length; i++) {
    const a = i === 0 ? program(p[i]) : p[i]
    const b = i === 0 ? program(r[i]) : r[i]
    if (a !== b) return false
  }
  return true
}

/** True when every part of the command is covered by one of the rules. */
export function commandAllowedByRules(command: string, rules: readonly string[]): boolean {
  if (!rules.length) return false
  const parts = splitCommandChain(command)
  if (!parts) return false
  return parts.every((part) => rules.some((rule) => partMatches(part, rule)))
}
