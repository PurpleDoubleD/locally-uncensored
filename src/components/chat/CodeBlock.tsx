import { useState } from 'react'
// PrismLight, NOT the `Prism` barrel. The barrel pulls refractor's ~300
// grammars into the boot chunk (~570 kB of a 2.61 MB App chunk) for a
// highlighter that realistically sees a dozen languages. PrismLight ships the
// engine only; every grammar below is an explicit opt-in.
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light'
// Deep path on purpose: `styles/prism` is a barrel over 46 themes.
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark'
import { Copy, Check, ChevronDown } from 'lucide-react'

// ── Grammars ───────────────────────────────────────────────────────────────
//
// What an LLM chat realistically emits, plus everything the Explorer's file
// preview can ask for (see LANGUAGE in lib/file-preview.ts) — a preview that
// silently lost its colours would be a regression, not a saving.
//
// refractor resolves a grammar's own dependencies on registration (tsx pulls
// jsx + typescript, cpp pulls c, csharp pulls clike, php pulls
// markup-templating), so the list stays at the languages a user can name.
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import batch from 'react-syntax-highlighter/dist/esm/languages/prism/batch'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import dart from 'react-syntax-highlighter/dist/esm/languages/prism/dart'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql'
import groovy from 'react-syntax-highlighter/dist/esm/languages/prism/groovy'
import hcl from 'react-syntax-highlighter/dist/esm/languages/prism/hcl'
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin'
import less from 'react-syntax-highlighter/dist/esm/languages/prism/less'
import lua from 'react-syntax-highlighter/dist/esm/languages/prism/lua'
import makefile from 'react-syntax-highlighter/dist/esm/languages/prism/makefile'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php'
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import r from 'react-syntax-highlighter/dist/esm/languages/prism/r'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift'
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'

/**
 * The grammars registered above, keyed by the name refractor knows them as.
 *
 * Left unannotated on purpose: the imports above carry refractor's own `Syntax`
 * type (see `src/types/react-syntax-highlighter.d.ts`), so inference hands
 * `registerLanguage` a checked grammar. Widening this to `Record<string,
 * unknown>` would only put the cast back.
 */
const GRAMMARS = {
  bash, batch, c, cpp, csharp, css, dart, diff, docker, go, graphql, groovy,
  hcl, ini, java, javascript, json, jsx, kotlin, less, lua, makefile, markdown,
  markup, php, powershell, python, r, ruby, rust, scss, sql, swift, toml, tsx,
  typescript, yaml,
}

for (const [name, grammar] of Object.entries(GRAMMARS)) {
  SyntaxHighlighter.registerLanguage(name, grammar)
}

/**
 * Names refractor answers to once the grammars above are registered — the
 * canonical ids plus the aliases each grammar brings with it (bash→sh/shell,
 * typescript→ts, python→py, markup→html/xml/svg, csharp→cs, …).
 *
 * Hardcoded rather than read from refractor so nothing outside this file has
 * to import the transitive dependency; `CodeBlock.test.ts` cross-checks the
 * set against refractor's real `listLanguages()` so it cannot drift.
 *
 * refractor's built-in plain-text family (`plain`, `plaintext`, `text`, `txt`)
 * is deliberately NOT in here: those must normalise to 'text', which is the
 * branch the highlighter short-circuits before it ever consults a grammar.
 */
export const PRISM_LANGUAGES: ReadonlySet<string> = new Set([
  'atom', 'bash', 'batch', 'c', 'clike', 'cpp', 'cs', 'csharp', 'css', 'dart',
  'diff', 'docker', 'dockerfile', 'dotnet', 'go', 'graphql', 'groovy', 'hcl',
  'html', 'ini', 'java', 'javascript', 'js', 'json', 'jsx', 'kotlin', 'kt',
  'kts', 'less', 'lua', 'makefile', 'markdown', 'markup', 'markup-templating',
  'mathml', 'md', 'php', 'powershell', 'py', 'python', 'r', 'rb', 'rss',
  'ruby', 'rust', 'scss', 'sh', 'shell', 'sql', 'ssml', 'svg', 'swift', 'toml',
  'ts', 'tsx', 'typescript', 'webmanifest', 'xml', 'yaml', 'yml',
])

/**
 * Fence tags LLMs write that refractor has no alias for. Everything else is
 * either a real id, a real alias, or unknown.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  'c#': 'csharp',
  'c++': 'cpp',
  console: 'bash',
  golang: 'go',
  htm: 'markup',
  jsonc: 'json',
  objectivec: 'c',
  'obj-c': 'c',
  shellsession: 'bash',
  'shell-session': 'bash',
  terraform: 'hcl',
  tf: 'hcl',
  rs: 'rust',
  zsh: 'bash',
}

/**
 * Map a fence tag onto a grammar this build actually ships.
 *
 * Unknown tags must land on plain text, never on a throw: the highlighter's
 * own refractor path does catch the "not registered" error, but relying on a
 * library's catch to keep the chat rendering is not a guarantee. Returning
 * 'text' takes the documented no-highlight branch instead.
 */
export function highlightLanguageFor(language?: string): string {
  if (!language) return 'text'
  const key = language.trim().toLowerCase()
  if (!key) return 'text'
  const mapped = LANGUAGE_ALIASES[key] ?? key
  return PRISM_LANGUAGES.has(mapped) ? mapped : 'text'
}

interface Props {
  code: string
  language?: string
}

const COLLAPSE_THRESHOLD = 4 // lines — always start collapsed unless very short

const HTML_LANG_TAGS = new Set(['html', 'htm', 'xhtml', 'svg'])

/**
 * Decide whether a code block should offer the Preview chip that opens
 * HtmlPreviewModal. Err on the side of NOT previewing: a fragment like
 * `<div>foo</div>` could just as well be JSX / Vue / Angular template,
 * and rendering those as raw HTML in a sandboxed iframe is useless.
 *
 * Positive by language tag: html, htm, xhtml, svg (case-insensitive).
 * Positive by content: starts with `<!doctype html`, `<html`, or an
 * `<svg xmlns=` that carries the xmlns attribute (leading whitespace ok).
 * Everything else → false.
 */
export function isHtmlSnippet(code: string, language?: string): boolean {
  if (language && HTML_LANG_TAGS.has(language.toLowerCase())) return true
  if (!code) return false
  const trimmed = code.trimStart()
  if (!trimmed) return false
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('<!doctype html')) return true
  if (lower.startsWith('<html')) return true
  if (lower.startsWith('<svg') && /<svg[^>]*\bxmlns\s*=/.test(trimmed)) return true
  return false
}

export function CodeBlock({ code, language }: Props) {
  const [copied, setCopied] = useState(false)
  const lineCount = code.split('\n').length
  const isLong = lineCount > COLLAPSE_THRESHOLD
  const [expanded, setExpanded] = useState(!isLong)

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const displayCode = expanded ? code : code.split('\n').slice(0, COLLAPSE_THRESHOLD).join('\n')

  return (
    <div className="relative group rounded-lg overflow-hidden my-1.5 border border-gray-200 dark:border-white/5">
      <div className="flex items-center justify-between px-3 py-1 bg-gray-50 dark:bg-white/5 border-b border-gray-200 dark:border-white/5">
        <span className="t-micro text-gray-400 font-mono">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 t-micro text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
          aria-label="Copy code"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        // The RAW tag stays in the header label above; only the highlighter
        // gets the normalised one, so an unknown fence still shows what the
        // model called it while rendering as plain text.
        language={highlightLanguageFor(language)}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: '0.75rem',
          background: 'rgba(0, 0, 0, 0.3)',
          fontSize: '0.75rem',
        }}
      >
        {displayCode}
      </SyntaxHighlighter>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-center gap-1 py-1 bg-gray-50 dark:bg-white/5 text-[0.55rem] text-gray-400 hover:text-gray-700 dark:hover:text-white border-t border-gray-200 dark:border-white/5 transition-colors"
        >
          <ChevronDown size={9} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
          {expanded ? 'Collapse' : `Show all ${lineCount} lines`}
        </button>
      )}
    </div>
  )
}
