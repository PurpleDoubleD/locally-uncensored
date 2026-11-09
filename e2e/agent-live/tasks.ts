/**
 * The fixed tasks of the agent test bench (C59).
 *
 * Every task has a starting folder (`files`), the user's sentence, and a check
 * that reads the folder and the visible answer after the run. The tasks were
 * fixed in AGENT-SOTA-RECHERCHE.md (section 4.2) BEFORE anything in the loop
 * changed, so a "before" and an "after" run measure the same thing. Do not
 * edit a task once a baseline exists; add a new id instead.
 *
 * Nothing here needs the network: the coding tasks use `node --test` and
 * plain Python, no package install.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Tab = 'agent' | 'code'

export interface CheckResult {
  ok: boolean
  detail: string
}

export interface BenchTask {
  id: string
  tab: Tab
  /** Code-tab mode for this task. Default 'bypass' (no approvals). */
  codeMode?: 'bypass' | 'plan'
  prompt: string
  files: Record<string, string>
  /** Reads the workspace and the final visible answer. */
  check: (ws: string, answer: string, run: RunFacts) => CheckResult
}

/** What the runner measured, for checks that judge the way, not the result. */
export interface RunFacts {
  toolCalls: Array<{ name: string; args: unknown }>
}

const read = (ws: string, p: string) => (existsSync(join(ws, p)) ? readFileSync(join(ws, p), 'utf8') : null)
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const ok = (detail = 'ok'): CheckResult => ({ ok: true, detail })
const fail = (detail: string): CheckResult => ({ ok: false, detail })

/** Runs a command in the workspace with a hard time limit, never through a shell. */
function sh(ws: string, cmd: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, { cwd: ws, timeout: 60_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────

const NOTES = `Projekt Sonnenhof – Notizen vom Montag

Das Dach muss vor dem Winter neu gedeckt werden, sonst regnet es in den Speicher.
Nebenbei: der Briefkasten klemmt, aber das hat Zeit.
Die Heizung braucht eine Wartung, die letzte war vor drei Jahren.
Kaffee für das Büro ist fast leer.
Das Budget für 2027 muss bis Freitag bei der Bank sein.
`

const CSV = (rows: number, seed: number) =>
  ['id,wert', ...Array.from({ length: rows }, (_, i) => `${i + 1},${(i * seed) % 97}`)].join('\n') + '\n'

const DOCS: Record<string, string> = {
  'docs/intro.md': '# Einleitung\n\nText.\n\n## Unterpunkt\n\nMehr.\n',
  'docs/setup.md': '# Installation\n\nSchritte.\n\n# Konfiguration\n\nWerte.\n',
  'docs/api.md': '# API\n\n## GET /items\n\n# Fehlercodes\n\nListe.\n',
  'docs/faq.md': '# FAQ\n\nFragen.\n\n# Kontakt\n\nMail.\n',
  'docs/notes.txt': '# Keine Markdown-Datei\n',
}
const DOCS_H1 = ['Einleitung', 'Installation', 'Konfiguration', 'API', 'Fehlercodes', 'FAQ', 'Kontakt']

const WERTE = [12, 7, 30, 1, 50]

const MATH_JS = `export function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}
`
const MATH_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mean, median } from './math.mjs'

test('mean', () => assert.equal(mean([1, 2, 3]), 2))
test('median odd', () => assert.equal(median([5, 1, 3]), 3))
test('median even', () => assert.equal(median([4, 1, 3, 2]), 2.5))
test('median does not change the input', () => {
  const xs = [3, 1, 2]
  median(xs)
  assert.deepEqual(xs, [3, 1, 2])
})
`

const PAGINATE = `/** Returns the items of page \`page\` (1-based), \`size\` per page. */
export function paginate(items, page, size) {
  const start = page * size
  return items.slice(start, start + size)
}

export function pageCount(items, size) {
  return Math.ceil(items.length / size)
}
`
const PAGINATE_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paginate, pageCount } from './paginate.mjs'

const items = [1, 2, 3, 4, 5, 6, 7]
test('first page', () => assert.deepEqual(paginate(items, 1, 3), [1, 2, 3]))
test('last page', () => assert.deepEqual(paginate(items, 3, 3), [7]))
test('page count', () => assert.equal(pageCount(items, 3), 3))
`
const PKG = JSON.stringify({ name: 'bench', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n'

const USER_FILES: Record<string, string> = {
  'src/api.mjs': `export function getUser(id) {\n  return { id, name: 'user' + id }\n}\n`,
  'src/profile.mjs': `import { getUser } from './api.mjs'\n\nexport function profile(id) {\n  return getUser(id).name\n}\n`,
  'src/admin.mjs': `import { getUser } from './api.mjs'\n\nexport const admin = () => getUser(0)\n`,
  'src/log.mjs': `// The audit log keeps the old event name on purpose.\nexport const EVENT = 'getUser'\n`,
  'src/index.mjs': `export { getUser } from './api.mjs'\nexport { profile } from './profile.mjs'\n`,
  'test/user.test.mjs': `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { fetchUser } from '../src/api.mjs'\nimport { profile } from '../src/profile.mjs'\nimport { admin } from '../src/admin.mjs'\nimport { EVENT } from '../src/log.mjs'\n\ntest('fetchUser', () => assert.equal(fetchUser(2).name, 'user2'))\ntest('profile', () => assert.equal(profile(3), 'user3'))\ntest('admin', () => assert.equal(admin().id, 0))\ntest('event name kept', () => assert.equal(EVENT, 'getUser'))\n`,
}

const SLUGIFY = `import re


def slugify(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")
`

const BIG_LINES = Array.from({ length: 1500 }, (_, i) =>
  i === 1199 ? 'export const RETRY_LIMIT = 3' : `export const value${i + 1} = ${i + 1}`,
).join('\n') + '\n'

const DATE_JS = `export function addDays(date, days) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}
`


// ── harder tasks (added after the first baseline showed 9B solving ~90 % of
//    the first set; run before AND after like the others) ─────────────────

const CUSTOMERS = ['Anna', 'Ben', 'Cem', 'Dora', 'Emil']
const ORDERS: Record<string, string> = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [
    `orders/2026-10-${String(i + 1).padStart(2, '0')}.json`,
    JSON.stringify({ id: 100 + i, customer: CUSTOMERS[(i * 3) % 5], items: [{ sku: 'A', price: 10 + i, qty: 1 + (i % 3) }, { sku: 'B', price: 5, qty: i % 2 }] }, null, 2) + '\n',
  ]),
)
const ORDER_TOTALS = (() => {
  const t: Record<string, number> = {}
  for (const c of Object.values(ORDERS)) {
    const o = JSON.parse(c) as { customer: string; items: Array<{ price: number; qty: number }> }
    t[o.customer] = (t[o.customer] ?? 0) + o.items.reduce((a, it) => a + it.price * it.qty, 0)
  }
  return Object.entries(t).sort((a, b) => b[1] - a[1])
})()

const TODO_TREE: Record<string, string> = {}
let todoCount = 0
for (let d = 0; d < 4; d++) {
  for (let f = 0; f < 5; f++) {
    const lines = Array.from({ length: 30 }, (_, l) => {
      if ((d * 5 + f + l) % 11 === 0) { todoCount++; return `  // TODO: punkt ${d}-${f}-${l}` }
      return `  const v${l} = ${l}`
    })
    TODO_TREE[`projekt/modul${d}/datei${f}.js`] = `export function f() {\n${lines.join('\n')}\n}\n`
  }
}
TODO_TREE['projekt/README.md'] = '# Projekt\n\nKein TODO-Kommentar hier, nur das Wort im Text.\n'
const TODO_COUNT = todoCount

const CLI_FILES: Record<string, string> = {
  'package.json': PKG,
  'src/format.mjs': `export function formatName(first, last) {\n  return \`\${first} \${last}\`\n}\n`,
  'src/cli.mjs': `import { formatName } from './format.mjs'\n\nexport function run(argv) {\n  const [first, last] = argv\n  return formatName(first, last)\n}\n`,
  'test/cli.test.mjs': `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { run } from '../src/cli.mjs'\n\ntest('plain', () => assert.equal(run(['Ada', 'Lovelace']), 'Ada Lovelace'))\ntest('--upper', () => assert.equal(run(['--upper', 'Ada', 'Lovelace']), 'ADA LOVELACE'))\ntest('--last-first', () => assert.equal(run(['--last-first', 'Ada', 'Lovelace']), 'Lovelace, Ada'))\ntest('both flags', () => assert.equal(run(['--upper', '--last-first', 'Ada', 'Lovelace']), 'LOVELACE, ADA'))\n`,
}

const SHARED_BUG: Record<string, string> = {
  'package.json': PKG,
  'src/money.mjs': `/** Cents to a euro string: 1234 -> "12,34 €". */\nexport function euro(cents) {\n  const e = Math.floor(cents / 100)\n  const c = cents % 100\n  return \`\${e},\${c} €\`\n}\n`,
  'src/invoice.mjs': `import { euro } from './money.mjs'\n\nexport function total(lines) {\n  return euro(lines.reduce((a, l) => a + l.cents * l.qty, 0))\n}\n`,
  'src/receipt.mjs': `import { euro } from './money.mjs'\n\nexport function line(name, cents) {\n  return \`\${name}: \${euro(cents)}\`\n}\n`,
  'test/invoice.test.mjs': `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { total } from '../src/invoice.mjs'\nimport { line } from '../src/receipt.mjs'\n\ntest('total', () => assert.equal(total([{ cents: 250, qty: 2 }, { cents: 105, qty: 1 }]), '6,05 €'))\ntest('line', () => assert.equal(line('Brot', 309), 'Brot: 3,09 €'))\ntest('round euros', () => assert.equal(line('Milch', 200), 'Milch: 2,00 €'))\n`,
}

const LRU_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LruCache } from './lru.mjs'

test('get returns what was set', () => { const c = new LruCache(2); c.set('a', 1); assert.equal(c.get('a'), 1) })
test('missing key is undefined', () => assert.equal(new LruCache(2).get('x'), undefined))
test('evicts the least recently used', () => { const c = new LruCache(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3); assert.equal(c.get('b'), undefined); assert.equal(c.get('a'), 1) })
test('set on an existing key refreshes it', () => { const c = new LruCache(2); c.set('a', 1); c.set('b', 2); c.set('a', 9); c.set('c', 3); assert.equal(c.get('a'), 9); assert.equal(c.get('b'), undefined) })
test('size', () => { const c = new LruCache(3); c.set('a', 1); c.set('b', 2); assert.equal(c.size, 2) })
test('delete', () => { const c = new LruCache(2); c.set('a', 1); assert.equal(c.delete('a'), true); assert.equal(c.get('a'), undefined); assert.equal(c.delete('a'), false) })
`

// ── the tasks ────────────────────────────────────────────────────────────

export const TASKS: BenchTask[] = [
  {
    id: 'AG1', tab: 'agent',
    prompt: 'Lies notes.txt und schreib die drei wichtigsten Punkte als Liste nach summary.md.',
    files: { 'notes.txt': NOTES },
    check: (ws) => {
      const s = read(ws, 'summary.md')
      if (s === null) return fail('summary.md fehlt')
      const items = s.split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l))
      if (items.length !== 3) return fail(`${items.length} Listenpunkte statt 3`)
      const keys = [/dach/i, /heizung|wartung/i, /budget|bank/i]
      const hit = keys.filter((k) => items.some((l) => k.test(l))).length
      return hit >= 2 ? ok(`${hit}/3 Kernpunkte`) : fail(`nur ${hit}/3 Kernpunkte`)
    },
  },
  {
    id: 'AG2', tab: 'agent',
    prompt: 'Wie viele .csv-Dateien liegen in data/ (auch in Unterordnern) und wie viele Datenzeilen ohne Kopfzeile haben sie zusammen?',
    files: { 'data/a.csv': CSV(5, 3), 'data/b.csv': CSV(12, 5), 'data/c.csv': CSV(3, 7), 'data/archiv/d.csv': CSV(20, 11), 'data/readme.txt': 'keine csv\n' },
    check: (_ws, answer) => {
      const has4 = /\b4\b|vier/i.test(answer)
      const has40 = /\b40\b/.test(answer)
      return has4 && has40 ? ok() : fail(`4 Dateien: ${has4}, 40 Zeilen: ${has40}`)
    },
  },
  {
    id: 'AG3', tab: 'agent',
    prompt: 'Benenne alle IMG_*.jpg in fotos/ nach urlaub-001.jpg, urlaub-002.jpg usw. um, in der Reihenfolge der alten Dateinamen.',
    files: { 'fotos/IMG_2041.jpg': 'b', 'fotos/IMG_1999.jpg': 'a', 'fotos/IMG_2100.jpg': 'c', 'fotos/behalten.png': 'x' },
    check: (ws) => {
      const dir = join(ws, 'fotos')
      if (!existsSync(dir)) return fail('fotos/ fehlt')
      const names = readdirSync(dir).sort()
      const want = ['behalten.png', 'urlaub-001.jpg', 'urlaub-002.jpg', 'urlaub-003.jpg']
      if (JSON.stringify(names) !== JSON.stringify(want)) return fail(`Dateien: ${names.join(', ')}`)
      const order = ['urlaub-001.jpg', 'urlaub-002.jpg', 'urlaub-003.jpg'].map((n) => readFileSync(join(dir, n), 'utf8')).join('')
      return order === 'abc' ? ok() : fail(`Reihenfolge ${order}`)
    },
  },
  {
    id: 'AG4', tab: 'agent',
    prompt: 'In config.json steht der Port 3000. Ändere ihn auf 8080 und lege vorher eine Sicherung config.json.bak an.',
    files: { 'config.json': JSON.stringify({ name: 'app', port: 3000, debug: false }, null, 2) + '\n' },
    check: (ws) => {
      const bak = read(ws, 'config.json.bak')
      const cur = read(ws, 'config.json')
      if (bak === null) return fail('Sicherung fehlt')
      if (cur === null) return fail('config.json fehlt')
      try {
        const b = JSON.parse(bak)
        const c = JSON.parse(cur)
        if (b.port !== 3000) return fail(`Sicherung hat Port ${b.port}`)
        if (c.port !== 8080) return fail(`Port ist ${c.port}`)
        if (c.name !== 'app' || c.debug !== false) return fail('andere Felder verändert')
        return ok()
      } catch {
        return fail('kein gültiges JSON')
      }
    },
  },
  {
    id: 'AG5', tab: 'agent',
    prompt: 'Leg einen Ordner bericht/ an, sammle aus allen .md-Dateien in docs/ die Überschriften erster Ebene in bericht/index.md und sag mir am Ende, wie viele es sind.',
    files: DOCS,
    check: (ws, answer) => {
      const s = read(ws, 'bericht/index.md')
      if (s === null) return fail('bericht/index.md fehlt')
      const missing = DOCS_H1.filter((h) => !s.includes(h))
      if (missing.length) return fail(`fehlt: ${missing.join(', ')}`)
      if (/Keine Markdown/.test(s)) return fail('notes.txt mitgezählt')
      return /\b7\b|sieben/i.test(answer) ? ok() : fail('Anzahl 7 nicht genannt')
    },
  },
  {
    id: 'AG6', tab: 'agent',
    prompt: 'Lies daten/werte.txt und rechne die Summe der Zahlen aus.',
    files: { 'data/werte.txt': WERTE.join('\n') + '\n' },
    check: (_ws, answer, run) => {
      const sum = WERTE.reduce((a, b) => a + b, 0)
      if (!new RegExp(`\\b${sum}\\b`).test(answer)) return fail(`Summe ${sum} nicht genannt`)
      return run.toolCalls.length <= 8 ? ok(`${run.toolCalls.length} Aufrufe`) : fail(`${run.toolCalls.length} Aufrufe (> 8)`)
    },
  },
  {
    id: 'AG7', tab: 'agent',
    prompt: 'Was ist der Unterschied zwischen TCP und UDP, in zwei Sätzen?',
    files: {},
    check: (_ws, answer, run) => {
      if (run.toolCalls.length) return fail(`${run.toolCalls.length} Werkzeugaufrufe`)
      const sentences = answer.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 3)
      if (!/TCP/.test(answer) || !/UDP/.test(answer)) return fail('TCP/UDP fehlt')
      return sentences.length <= 4 ? ok() : fail(`${sentences.length} Sätze`)
    },
  },
  {
    id: 'CO1', tab: 'code',
    prompt: 'In math.mjs fehlt die Funktion median(). Implementiere sie, die Tests in math.test.mjs sollen mit `node --test` grün werden.',
    files: { 'package.json': PKG, 'math.mjs': MATH_JS, 'math.test.mjs': MATH_TEST },
    check: (ws) => {
      const r = sh(ws, 'node', ['--test'])
      if (read(ws, 'math.test.mjs') !== MATH_TEST) return fail('Testdatei verändert')
      return r.code === 0 ? ok() : fail('node --test rot')
    },
  },
  {
    id: 'CO2', tab: 'code',
    prompt: '`npm test` ist rot. Finde den Fehler und behebe ihn, ohne die Tests zu ändern.',
    files: { 'package.json': PKG, 'paginate.mjs': PAGINATE, 'paginate.test.mjs': PAGINATE_TEST },
    check: (ws) => {
      if (sha(read(ws, 'paginate.test.mjs') ?? '') !== sha(PAGINATE_TEST)) return fail('Testdatei verändert')
      return sh(ws, 'node', ['--test']).code === 0 ? ok() : fail('node --test rot')
    },
  },
  {
    id: 'CO3', tab: 'code',
    prompt: 'Benenne die Funktion getUser überall in fetchUser um. Der String im Audit-Log bleibt, wie er ist. Danach sollen die Tests grün sein.',
    files: { 'package.json': PKG, ...USER_FILES },
    check: (ws) => {
      if (read(ws, 'src/log.mjs') !== USER_FILES['src/log.mjs']) return fail('Audit-String verändert')
      const left = ['src/api.mjs', 'src/profile.mjs', 'src/admin.mjs', 'src/index.mjs'].filter((f) => /\bgetUser\b/.test(read(ws, f) ?? ''))
      if (left.length) return fail(`getUser noch in ${left.join(', ')}`)
      return sh(ws, 'node', ['--test']).code === 0 ? ok() : fail('node --test rot')
    },
  },
  {
    id: 'CO4', tab: 'code',
    prompt: 'Füge slugify.py eine Kommandozeile hinzu: `python3 slugify.py "Hallo Welt"` soll genau `hallo-welt` ausgeben.',
    files: { 'slugify.py': SLUGIFY },
    check: (ws) => {
      const r = sh(ws, 'python3', ['-I', 'slugify.py', 'Hallo Welt'])
      return r.code === 0 && r.out.trim() === 'hallo-welt' ? ok() : fail(`Ausgabe: ${JSON.stringify(r.out.trim().slice(0, 80))}`)
    },
  },
  {
    id: 'CO5', tab: 'code',
    prompt: 'In constants.mjs steht RETRY_LIMIT = 3. Setz den Wert auf 5, sonst nichts ändern.',
    files: { 'constants.mjs': BIG_LINES },
    check: (ws) => {
      const s = read(ws, 'constants.mjs')
      if (s === null) return fail('Datei fehlt')
      const want = BIG_LINES.replace('RETRY_LIMIT = 3', 'RETRY_LIMIT = 5')
      if (s === want) return ok()
      const a = s.split('\n')
      const b = want.split('\n')
      const diff = Math.abs(a.length - b.length) + a.filter((l, i) => l !== b[i]).length
      return fail(`${diff} Zeilen weichen ab`)
    },
  },
  {
    id: 'CO6', tab: 'code', codeMode: 'plan',
    prompt: 'Plane, wie wir in dieses Projekt ein einfaches Logging (Datei logger.mjs, Level info/warn/error) einbauen.',
    files: { 'package.json': PKG, ...USER_FILES },
    check: (ws, answer, run) => {
      const changed = Object.entries({ 'package.json': PKG, ...USER_FILES }).filter(([p, c]) => read(ws, p) !== c)
      if (changed.length || existsSync(join(ws, 'logger.mjs'))) return fail('im Plan-Modus Dateien verändert')
      if (!run.toolCalls.some((c) => c.name === 'todo_write')) return fail('kein todo_write')
      return /logger\.mjs/.test(answer) ? ok() : fail('Plan nennt logger.mjs nicht')
    },
  },
  {
    id: 'CO7', tab: 'code',
    prompt: 'Füge date.mjs eine Funktion isWeekend(date) hinzu, schreib Tests dafür in date.test.mjs und lass die Tests laufen.',
    files: { 'package.json': PKG, 'date.mjs': DATE_JS },
    check: (ws, _answer, run) => {
      const t = read(ws, 'date.test.mjs')
      if (!t || !/isWeekend/.test(t)) return fail('keine Tests für isWeekend')
      if (!/export\s+(function\s+isWeekend|const\s+isWeekend)/.test(read(ws, 'date.mjs') ?? '')) return fail('isWeekend nicht exportiert')
      if (sh(ws, 'node', ['--test']).code !== 0) return fail('node --test rot')
      const ran = run.toolCalls.some((c) => c.name === 'shell_execute' && /test/.test(JSON.stringify(c.args)))
      return ran ? ok() : fail('Tests nicht selbst gelaufen')
    },
  },
  {
    id: 'AG8', tab: 'agent',
    prompt: 'In orders/ liegen 12 Bestellungen als JSON. Rechne für jeden Kunden die Summe aller Positionen (price × qty) aus und schreib sie nach kunden.csv mit den Spalten kunde,summe, absteigend nach Summe sortiert.',
    files: ORDERS,
    check: (ws) => {
      const s = read(ws, 'kunden.csv')
      if (s === null) return fail('kunden.csv fehlt')
      const rows = s.trim().split('\n').map((l) => l.split(',').map((x) => x.trim()))
      const body = /^kunde/i.test(rows[0]?.[0] ?? '') ? rows.slice(1) : rows
      const got = body.map(([k, v]) => [k, Number(v)])
      const want = ORDER_TOTALS
      if (got.length !== want.length) return fail(`${got.length} Zeilen statt ${want.length}`)
      const wrong = want.filter(([k, v], i) => got[i]?.[0] !== k || got[i]?.[1] !== v)
      return wrong.length ? fail(`falsch: ${wrong.map(([k]) => k).join(', ')}`) : ok()
    },
  },
  {
    id: 'AG9', tab: 'agent',
    prompt: 'Finde in projekt/ alle TODO-Kommentare in den .js-Dateien und schreib sie nach todos.md, eine Zeile je Fund im Format `datei:zeile: text`. Sag mir am Ende, wie viele es sind.',
    files: TODO_TREE,
    check: (ws, answer) => {
      const s = read(ws, 'todos.md')
      if (s === null) return fail('todos.md fehlt')
      const hits = s.split('\n').filter((l) => /TODO/.test(l) && /datei\d\.js:\d+/.test(l))
      if (hits.length !== TODO_COUNT) return fail(`${hits.length} Funde statt ${TODO_COUNT}`)
      if (/README/.test(s)) return fail('README mitgezählt')
      return new RegExp(`\\b${TODO_COUNT}\\b`).test(answer) ? ok() : fail(`Anzahl ${TODO_COUNT} nicht genannt`)
    },
  },
  {
    id: 'CO8', tab: 'code',
    prompt: 'Die CLI in src/cli.mjs soll zwei Schalter bekommen: --upper (alles groß) und --last-first ("Nachname, Vorname"). Beide sind kombinierbar. Die Tests in test/cli.test.mjs zeigen das gewünschte Verhalten, ändere sie nicht.',
    files: CLI_FILES,
    check: (ws) => {
      if (read(ws, 'test/cli.test.mjs') !== CLI_FILES['test/cli.test.mjs']) return fail('Testdatei verändert')
      return sh(ws, 'node', ['--test']).code === 0 ? ok() : fail('node --test rot')
    },
  },
  {
    id: 'CO9', tab: 'code',
    prompt: 'Die Rechnungen zeigen manchmal falsche Beträge (z. B. "6,5 €" statt "6,05 €"). Finde die Ursache, behebe sie an der richtigen Stelle und lass die Tests laufen.',
    files: SHARED_BUG,
    check: (ws) => {
      if (read(ws, 'test/invoice.test.mjs') !== SHARED_BUG['test/invoice.test.mjs']) return fail('Testdatei verändert')
      if (read(ws, 'src/invoice.mjs') !== SHARED_BUG['src/invoice.mjs'] || read(ws, 'src/receipt.mjs') !== SHARED_BUG['src/receipt.mjs']) return fail('an der falschen Stelle geflickt')
      return sh(ws, 'node', ['--test']).code === 0 ? ok() : fail('node --test rot')
    },
  },
  {
    id: 'CO10', tab: 'code',
    prompt: 'Schreib lru.mjs: eine Klasse LruCache(capacity) mit get, set, delete und size, die bei voller Kapazität den am längsten nicht benutzten Eintrag verdrängt. Die Tests in lru.test.mjs müssen grün werden.',
    files: { 'package.json': PKG, 'lru.test.mjs': LRU_TEST },
    check: (ws) => {
      if (read(ws, 'lru.test.mjs') !== LRU_TEST) return fail('Testdatei verändert')
      return sh(ws, 'node', ['--test']).code === 0 ? ok() : fail('node --test rot')
    },
  },
]
