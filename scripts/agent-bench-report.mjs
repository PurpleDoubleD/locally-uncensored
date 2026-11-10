#!/usr/bin/env node
/**
 * Turns the rows of the agent test bench (e2e/agent-live, results.jsonl) into
 * a Markdown comparison: per model and label (vorher/nachher) the success
 * rate and the ways a run went wrong, then per task.
 *
 *   node scripts/agent-bench-report.mjs <results.jsonl> [more.jsonl …] > report.md
 */
import { readFileSync } from 'node:fs'

const rows = process.argv.slice(2).flatMap((file) =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
)
if (!rows.length) {
  console.error('usage: agent-bench-report.mjs <results.jsonl> …')
  process.exit(2)
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)} %` : '–')
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const tokens = (r) => (r.usage ?? []).reduce((sum, u) => sum + (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0), 0)
const group = (xs, key) => xs.reduce((m, x) => m.set(key(x), [...(m.get(key(x)) ?? []), x]), new Map())

const out = []
out.push('## Gesamt je Modell und Stand', '')
out.push('| Modell | Stand | Läufe | Erfolg | zu früh aufgehört | Loop-Guard-Abbruch | Budget-Abbruch | Timeout | Aufrufe Ø | fehlgeschl. Aufrufe Ø | Plan geschrieben | Token Ø | Dauer Ø |')
out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const [key, rs] of [...group(rows, (r) => `${r.model}\u0000${r.label}`)].sort()) {
  const [model, label] = key.split('\u0000')
  const n = rs.length
  out.push(`| ${model} | ${label} | ${n} | ${pct(rs.filter((r) => r.ok).length, n)} | ${pct(rs.filter((r) => r.earlyStop).length, n)} | ${rs.filter((r) => r.guardHalt).length} | ${rs.filter((r) => r.budgetHalt).length} | ${rs.filter((r) => r.end === 'timeout').length} | ${avg(rs.map((r) => r.calls)).toFixed(1)} | ${avg(rs.map((r) => r.failedCalls)).toFixed(1)} | ${pct(rs.filter((r) => r.planned).length, n)} | ${Math.round(avg(rs.map(tokens)))} | ${Math.round(avg(rs.map((r) => r.ms)) / 1000)} s |`)
}

out.push('', '## Je Aufgabe (erfolgreiche Läufe / Läufe)', '')
const labels = [...new Set(rows.map((r) => r.label))]
const models = [...new Set(rows.map((r) => r.model))]
const tasks = [...new Set(rows.map((r) => r.task))].sort()
const cols = models.flatMap((m) => labels.map((l) => [m, l]))
out.push(`| Aufgabe | ${cols.map(([m, l]) => `${m} ${l}`).join(' | ')} |`)
out.push(`|---|${cols.map(() => '---').join('|')}|`)
for (const t of tasks) {
  const cells = cols.map(([m, l]) => {
    const rs = rows.filter((r) => r.task === t && r.model === m && r.label === l)
    return rs.length ? `${rs.filter((r) => r.ok).length}/${rs.length}` : '–'
  })
  out.push(`| ${t} | ${cells.join(' | ')} |`)
}

out.push('', '## Fehlschläge im Einzelnen', '')
for (const r of rows.filter((x) => !x.ok)) {
  out.push(`- ${r.label} · ${r.model} · ${r.task} #${r.run}: ${r.detail} (${r.end}, ${r.calls} Aufrufe${r.guardHalt ? ', Loop-Guard' : ''}${r.budgetHalt ? ', Budget' : ''})`)
}
console.log(out.join('\n'))
