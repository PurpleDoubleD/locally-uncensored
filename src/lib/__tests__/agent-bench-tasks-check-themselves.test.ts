/** The harder bench tasks (C59): each check rejects the starting folder and accepts a reference solution. */
import { it, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { TASKS } from '../../../e2e/agent-live/tasks'

const seed = (ws: string, files: Record<string, string>) => {
  rmSync(ws, { recursive: true, force: true }); mkdirSync(ws, { recursive: true })
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(ws, p)), { recursive: true }); writeFileSync(join(ws, p), c) }
}
const W = (ws: string, p: string, c: string) => { mkdirSync(dirname(join(ws, p)), { recursive: true }); writeFileSync(join(ws, p), c) }
const SOL: Record<string, (ws: string) => string> = {
  AG8: (ws) => {
    const t: Record<string, number> = {}
    for (const f of readdirSync(join(ws, 'orders'))) {
      const o = JSON.parse(readFileSync(join(ws, 'orders', f), 'utf8'))
      t[o.customer] = (t[o.customer] ?? 0) + o.items.reduce((a: number, i: { price: number; qty: number }) => a + i.price * i.qty, 0)
    }
    W(ws, 'kunden.csv', 'kunde,summe\n' + Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k},${v}`).join('\n') + '\n')
    return ''
  },
  AG9: (ws) => {
    const out: string[] = []
    for (const d of readdirSync(join(ws, 'projekt'))) {
      if (!d.startsWith('modul')) continue
      for (const f of readdirSync(join(ws, 'projekt', d))) {
        readFileSync(join(ws, 'projekt', d, f), 'utf8').split('\n').forEach((l, i) => { if (l.includes('TODO')) out.push(`${d}/${f}:${i + 1}: ${l.trim()}`) })
      }
    }
    W(ws, 'todos.md', out.join('\n') + '\n')
    return `Es sind ${out.length} TODOs.`
  },
  CO8: (ws) => { W(ws, 'src/cli.mjs', `import { formatName } from './format.mjs'\nexport function run(argv) {\n  const flags = argv.filter((a) => a.startsWith('--'))\n  const [first, last] = argv.filter((a) => !a.startsWith('--'))\n  let s = flags.includes('--last-first') ? \`\${last}, \${first}\` : formatName(first, last)\n  if (flags.includes('--upper')) s = s.toUpperCase()\n  return s\n}\n`); return '' },
  CO9: (ws) => { W(ws, 'src/money.mjs', `export function euro(cents) {\n  const e = Math.floor(cents / 100)\n  const c = String(cents % 100).padStart(2, '0')\n  return \`\${e},\${c} €\`\n}\n`); return '' },
  CO10: (ws) => { W(ws, 'lru.mjs', `export class LruCache {\n  constructor(cap) { this.cap = cap; this.m = new Map() }\n  get(k) { if (!this.m.has(k)) return undefined; const v = this.m.get(k); this.m.delete(k); this.m.set(k, v); return v }\n  set(k, v) { this.m.delete(k); this.m.set(k, v); if (this.m.size > this.cap) this.m.delete(this.m.keys().next().value) }\n  delete(k) { return this.m.delete(k) }\n  get size() { return this.m.size }\n}\n`); return '' },
}
for (const id of Object.keys(SOL)) {
  it(id, () => {
    const t = TASKS.find((x) => x.id === id)!
    const ws = join(tmpdir(), 'c59-selfcheck', id)
    seed(ws, t.files)
    expect(t.check(ws, '', { toolCalls: [] }).ok, 'seed must fail').toBe(false)
    const answer = SOL[id](ws)
    const r = t.check(ws, answer, { toolCalls: [] })
    expect(r.detail).toBe('ok')
  })
}
