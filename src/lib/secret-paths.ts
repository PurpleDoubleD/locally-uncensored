/**
 * Paths an agent never reads, lists, searches or runs a command on, in any
 * mode, Bypass included (C59, after C60's live run 1: a 9B tried
 * `file_read ~/.huggingface/token` unasked).
 *
 * What this is: a hard floor under every built-in tool. A call that names
 * one of these paths is refused before anything runs, the model is told why,
 * and the user sees a notice in the run.
 *
 * What this is not: a sandbox. A shell command can reach a file without
 * spelling its name (`grep -r token ~`, a script, a variable). The list
 * catches what a model actually writes, which is the name. The boundary for
 * everything else is the approval mode the user chose.
 */

export interface SecretHit {
  /** The path as the model wrote it. */
  path: string
  /** Why it is off limits, for the model and the notice. */
  why: string
}

interface Rule { test: (p: string) => boolean; why: string }

const seg = (p: string) => p.split('/').filter(Boolean)
const has = (p: string, dir: string) => seg(p).includes(dir)

/** Patterns over a normalised path: forward slashes, `~` for the home folder, lower case. */
const RULES: Rule[] = [
  { test: (p) => has(p, '.ssh'), why: 'SSH keys' },
  { test: (p) => /(^|\/)\.?huggingface\/token$/.test(p) || /(^|\/)\.cache\/huggingface\/(token|stored_tokens)$/.test(p), why: 'a Hugging Face access token' },
  { test: (p) => has(p, '.aws'), why: 'AWS credentials' },
  { test: (p) => /(^|\/)\.config\/gcloud(\/|$)/.test(p), why: 'Google Cloud credentials' },
  { test: (p) => /(^|\/)\.azure(\/|$)/.test(p), why: 'Azure credentials' },
  { test: (p) => /(^|\/)\.kube\/config$/.test(p), why: 'Kubernetes credentials' },
  { test: (p) => /(^|\/)(\.netrc|_netrc|\.git-credentials|\.pgpass|\.npmrc|\.pypirc)$/.test(p), why: 'stored passwords or tokens' },
  { test: (p) => /(^|\/)\.docker\/config\.json$/.test(p), why: 'Docker registry credentials' },
  { test: (p) => /(^|\/)\.config\/gh\/hosts\.ya?ml$/.test(p), why: 'the GitHub CLI token' },
  { test: (p) => has(p, '.gnupg'), why: 'GPG keys' },
  { test: (p) => /(^|\/)library\/keychains(\/|$)/.test(p) || /\.keychain(-db)?$/.test(p), why: 'the system keychain' },
  { test: (p) => /\.(pem|key|p12|pfx|jks|keystore|ppk)$/.test(p), why: 'a private key or certificate store' },
  { test: (p) => /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?$/.test(p), why: 'an SSH key' },
  {
    // .env, .env.local, .env.production … but not the examples projects ship.
    test: (p) => /(^|\/)\.env(\.[a-z0-9_-]+)*$/.test(p) && !/(^|\/)\.env\.(example|sample|template|dist|defaults)$/.test(p),
    why: 'environment secrets (.env)',
  },
  { test: (p) => /(^|\/)secrets?\.json$/.test(p), why: 'stored API keys' },
  { test: (p) => /^\/volumes\/[^/]*credential/.test(p), why: 'a credentials volume' },
  {
    // Browser profiles: cookies, saved logins, session stores.
    test: (p) => /(^|\/)(cookies|login data|web data|logins\.json|key[34]\.db|cookies\.sqlite)(-journal)?$/.test(p)
      || /(^|\/)library\/application support\/(google\/chrome|bravesoftware|microsoft edge|firefox|arc\/user data)(\/|$)/.test(p)
      || /(^|\/)library\/cookies(\/|$)/.test(p)
      || /(^|\/)appdata\/(local|roaming)\/(google\/chrome|microsoft\/edge|mozilla\/firefox)\/.*user data/.test(p),
    why: 'browser cookies or saved logins',
  },
]

/** `~`, `$HOME`, `${HOME}`, `%USERPROFILE%` and the real home all become `~`. */
export function normaliseForSecrets(raw: string, home?: string): string {
  let p = raw.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/')
  p = p.replace(/^file:\/\//i, '')
  p = p.replace(/^(\$\{?HOME\}?|%USERPROFILE%)(?=\/|$)/i, '~')
  if (home) {
    const h = home.replace(/\\/g, '/').replace(/\/+$/, '')
    if (h && (p === h || p.startsWith(h + '/'))) p = '~' + p.slice(h.length)
  }
  // Collapse ./ and duplicate slashes; a `..` does not unlock anything, the
  // rules match on segments wherever they stand.
  p = p.replace(/\/{2,}/g, '/').replace(/(^|\/)\.\/(?=.)/g, '$1')
  return p.toLowerCase()
}

/** Why `path` is off limits, or null. */
export function secretPathReason(path: string, home?: string): string | null {
  if (!path || typeof path !== 'string') return null
  const p = normaliseForSecrets(path, home)
  if (!p) return null
  return RULES.find((r) => r.test(p))?.why ?? null
}

/**
 * The words of a shell command that look like paths. Quote aware enough for
 * the forms models write: `cat ~/.ssh/id_rsa`, `cat "$HOME/.aws/credentials"`,
 * `grep x < .env`, `cp ~/.netrc /tmp/x`.
 */
function shellWords(command: string): string[] {
  return command
    .split(/[\s;|&<>()`]+|=(?=[~/$.])/)
    .map((w) => w.replace(/^["']+|["']+$/g, ''))
    .filter((w) => w.length > 1)
}

/** Argument names that hold a path or a command in the built-in tools. */
const PATH_KEYS = ['path', 'paths', 'cwd', 'file', 'files', 'directory', 'dir', 'source', 'destination', 'target', 'url']
const COMMAND_KEYS = ['command', 'stdin', 'script']

function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return []
}

/**
 * The first secret path a tool call names, or null. Looks at the path-like
 * arguments of any tool and at the words of a shell command or script. The
 * content a tool writes is not looked at: a file that mentions `.env` is fine.
 */
export function secretAccessOf(toolName: string, args: Record<string, unknown> | undefined, home?: string): SecretHit | null {
  if (!args || typeof args !== 'object') return null
  for (const key of PATH_KEYS) {
    for (const s of strings(args[key])) {
      const why = secretPathReason(s, home)
      if (why) return { path: s, why }
    }
  }
  for (const key of COMMAND_KEYS) {
    for (const s of strings(args[key])) {
      for (const w of shellWords(s)) {
        const why = secretPathReason(w, home)
        if (why) return { path: w, why }
      }
    }
  }
  // Shell arguments passed as a list (`args: ["~/.ssh/id_rsa"]`).
  if (/shell|exec|code/.test(toolName)) {
    for (const s of strings(args.args)) {
      const why = secretPathReason(s, home)
      if (why) return { path: s, why }
    }
  }
  return null
}

/** What the model reads back. Starts with "Error:" so every caller counts it as a failed call. */
export function secretRefusal(hit: SecretHit): string {
  return `Error: Refused: ${hit.path} holds ${hit.why}. LU never lets an agent read, list, search or run commands on secret files, in any mode. Nothing was read. Do the task without it; if you really need a value from it, ask the user to give it to you.`
}

/** The line the user sees in the run. */
export function secretNotice(toolName: string, hit: SecretHit): string {
  return `🔒 Blocked: the model tried ${toolName} on ${hit.path} (${hit.why}). Nothing was read.`
}

/**
 * file_search over a folder reads every file in it, .env included. Drops the
 * result lines whose file is a secret one, so a broad search cannot carry a
 * token out. A line is `path:line: text` or a bare path.
 */
export function dropSecretLines(result: string, home?: string): string {
  if (!result) return result
  let dropped = 0
  const kept = result.split('\n').filter((line) => {
    const file = line.match(/^(.+?):\d+:/)?.[1] ?? line.trim()
    if (file && secretPathReason(file, home)) { dropped++; return false }
    return true
  })
  return dropped ? `${kept.join('\n')}\n(${dropped} line(s) from secret files left out.)` : result
}
