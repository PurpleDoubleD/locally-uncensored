/**
 * pr_resume — Claude-Code-style "/resume <pr-url>" support.
 *
 * Given a GitHub PR URL, fetches title, body, head ref, latest comments,
 * and a unified diff via the local `gh` CLI in a single call. The
 * builtin tool wraps three `gh` invocations + the URL parser so the
 * model gets a compact, ready-to-paraphrase snapshot of where the PR
 * left off.
 *
 * Pure helpers (parser + renderer) live here so they can be unit-tested
 * without touching the bridge.
 */

import { prop, propPath } from '../../types/json-guards'

export interface PrLocator {
  owner: string
  repo: string
  number: number
}

export interface PrResumePayload {
  url: string
  title: string
  body: string
  state: string
  headRefName: string
  baseRefName: string
  author?: string
  comments: Array<{ author: string; body: string; createdAt: string }>
  diff: string
}

// owner and repo land in a shell command (`gh pr view … --repo owner/repo`),
// so they are restricted to what GitHub actually allows rather than "anything
// without a slash". The loose form accepted `o/r;Write-Output PWNED` and the
// text after the semicolon ran as its own command (proven 2026-07-26). Owners
// are alphanumeric plus single hyphens, repos add dot and underscore; neither
// can contain a quote, a semicolon, a backtick or whitespace.
const PR_URL_RE =
  /^https?:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d+)(?:[?#/].*)?$/

export function parsePrUrl(url: string): PrLocator | null {
  const m = (url ?? '').trim().match(PR_URL_RE)
  if (!m) return null
  const num = parseInt(m[3], 10)
  if (!Number.isFinite(num) || num <= 0) return null
  return { owner: m[1], repo: m[2], number: num }
}

/**
 * Compact a verbose `gh pr view --json` response into a renderer-friendly
 * shape. The bridge returns a raw JSON blob; this normalises field names
 * + truncates long comment bodies so the system-prompt section fits.
 */
export function normalisePrJson(raw: unknown, url: string): Omit<PrResumePayload, 'diff'> {
  // `raw` is `gh`'s stdout, parsed. The caller (mcp/builtin-tools.ts) already
  // holds it as `unknown`; the old `any` parameter was the one thing that let
  // it in without a check. Every read below goes through prop/propPath, which
  // answer `undefined` for a non-object instead of throwing.
  const rawComments = prop(raw, 'comments')
  const comments: PrResumePayload['comments'] = (
    Array.isArray(rawComments) ? rawComments : []
  )
    .slice(-12) // last 12 — older comments are usually stale
    .map((c: unknown) => ({
      author: String(propPath(c, 'author', 'login') ?? prop(c, 'author') ?? 'unknown'),
      body: clip(String(prop(c, 'body') ?? ''), 600),
      createdAt: String(prop(c, 'createdAt') ?? ''),
    }))
  const authorLogin = propPath(raw, 'author', 'login')
  return {
    url,
    title: String(prop(raw, 'title') ?? ''),
    body: clip(String(prop(raw, 'body') ?? ''), 4000),
    state: String(prop(raw, 'state') ?? 'UNKNOWN'),
    headRefName: String(prop(raw, 'headRefName') ?? ''),
    baseRefName: String(prop(raw, 'baseRefName') ?? ''),
    author: authorLogin ? String(authorLogin) : undefined,
    comments,
  }
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n).trimEnd()}\n…(truncated, ${s.length - n} chars dropped)`
}

/**
 * Renders the structured PR payload as a markdown summary the model
 * can use to orient itself. Designed to land at the top of the next
 * user message so the model has full context for "continue this PR".
 */
export function renderPrResume(p: PrResumePayload): string {
  const head = [
    `# PR ${p.url}`,
    `**State:** ${p.state}  **Branch:** ${p.headRefName} → ${p.baseRefName}` +
      (p.author ? `  **Author:** @${p.author}` : ''),
    '',
    `## Title`,
    p.title || '(no title)',
    '',
    `## Description`,
    p.body || '(empty)',
    '',
  ].join('\n')
  const comments = p.comments.length
    ? [
        '## Latest comments',
        ...p.comments.map(
          (c) =>
            `- **@${c.author}** (${c.createdAt}):\n  ${c.body.replace(/\n/g, '\n  ')}`,
        ),
        '',
      ].join('\n')
    : ''
  const diff = p.diff
    ? `## Diff\n\n\`\`\`diff\n${clip(p.diff, 8000)}\n\`\`\`\n`
    : ''
  return `${head}${comments}${diff}`
}
