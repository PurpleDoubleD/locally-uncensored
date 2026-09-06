/**
 * Ein Ausgang, den nur die Tests benutzen sollen, muss auch benutzt werden.
 *
 * Die Nachlese hat `__resetProxyWarnLogForTests` in src/api/backend.ts
 * gefunden: exportiert, dokumentiert ("Test-only: forget which hosts have
 * already had their warning"), und im ganzen Baum ohne einen einzigen Leser,
 * Tests eingeschlossen. Ein solcher Ausgang ist schlimmer als kein Ausgang.
 * Er behauptet, jemand raeume `proxyWarnSeen` zwischen zwei Laeufen auf, und
 * wer das glaubt, schreibt einen Test, der von einer Isolation ausgeht, die es
 * nicht gibt.
 *
 * Geprueft wird nur src/api/backend.ts. Es gibt zwei weitere tote Ausgaenge
 * derselben Art im Baum (`__resetCivitaiVaultForTests`,
 * `__resetProviderSlotDarkeningForTests`), beide in Dateien, die zu dieser
 * Aufgabe nicht gehoeren.
 *
 * Run: npx vitest run src/api/__tests__/kein-toter-testausgang-im-backend.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const repo = resolve(__dirname, '..', '..', '..')
const backend = join(repo, 'src', 'api', 'backend.ts')

function dateien(dir: string, endung: RegExp): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === 'target') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...dateien(p, endung))
    else if (endung.test(e)) out.push(p)
  }
  return out
}

/**
 * Jeder Leser im Baum ausser der Datei, in der die Funktion selbst steht, und
 * ausser dieser hier: ein Waechter, der den Namen nennt, um ihn zu suchen,
 * wuerde sonst jeden toten Ausgang am Leben halten, den er gerade meldet.
 */
const selbst = join(__dirname, 'kein-toter-testausgang-im-backend.test.ts')

function leser(name: string): string[] {
  const orte: string[] = []
  for (const f of [...dateien(join(repo, 'src'), /\.tsx?$/), ...dateien(join(repo, 'e2e'), /\.tsx?$/)]) {
    if (f === backend || f === selbst) continue
    if (readFileSync(f, 'utf8').includes(name)) orte.push(f)
  }
  return orte
}

describe('die Test-Ausgaenge in api/backend.ts', () => {
  const quelle = readFileSync(backend, 'utf8')
  const ausgaenge = [...quelle.matchAll(/export (?:function|const) (__[A-Za-z]+ForTests)/g)].map((m) => m[1])

  it('jeder von ihnen hat einen Leser', () => {
    const tot = ausgaenge.filter((n) => leser(n).length === 0)
    expect(tot).toEqual([])
  })

  it('und der gefundene ist wirklich weg, samt seiner Notiz', () => {
    expect(quelle).not.toContain('__resetProxyWarnLogForTests')
    expect(quelle).not.toContain('Test-only: forget which hosts')
  })

  // Negativkontrolle: der Sammelbehaelter, den er raeumen sollte, steht noch
  // da und wird noch gebraucht. Entfernt wurde der Ausgang, nicht die Regel.
  it('der Behaelter selbst bleibt, er tut ja etwas', () => {
    expect(quelle).toContain('const proxyWarnSeen = new Map<string, number>()')
  })
})
