/**
 * AS-10 — Sonde fuer die drei Lockerungen in eslint.config.js.
 *
 * Eine Regel weicher zu stellen ist der billigste Weg, einen Zaehler zu
 * senken, und der teuerste, wenn dabei die gefaehrliche Form mit durchrutscht.
 * Dieser Test misst genau die Grenze: was die Lockerung erlauben SOLL, muss
 * sauber sein, und was sie NICHT erlauben soll, muss weiterhin ein Fehler
 * sein. Er laesst dazu die echte eslint.config.js des Projekts laufen — kein
 * Nachbau, keine zweite Wahrheit.
 *
 * Geprueft werden:
 *   1. no-fallthrough mit allowEmptyCase: true
 *      Erlaubt: `case 'a': /* warum *\/ case 'b':` — ein LEERES Label kann
 *      nirgends hineinfallen, es laeuft kein Code. Gemeldet wurde es nur, weil
 *      ein Kommentar dazwischenstand; die Voreinstellung bestraft also das
 *      Erklaeren, nicht den Code.
 *      Weiterhin verboten: ein case MIT Anweisungen, der ohne `break` in den
 *      naechsten laeuft. Das ist die Form, die wirklich schadet.
 *
 *   2. @typescript-eslint/no-unused-vars mit ^_-Mustern
 *      Erlaubt: `catch (_err)`, `(_args) => …` — die Schreibweise, mit der
 *      dieser Baum seit jeher "absichtlich ungenutzt" sagt.
 *      Weiterhin verboten: ein gefangener Fehler OHNE Unterstrich, der nicht
 *      gelesen wird. Genau das war der eine echte Fehler unter den 43
 *      Meldungen (api/mcp/builtin-tools.ts, `catch (fallbackErr)`), und genau
 *      den muss die Regel nach der Lockerung noch finden.
 *
 *   3. reportUnusedDisableDirectives: 'error'
 *      Eine Unterdrueckung fuer eine Regel, die nichts meldet, ist eine Luege
 *      ueber das, was geprueft wird. Voreinstellung war 'warn', und
 *      `npm run lint` ist `eslint .` ohne --max-warnings 0: eine Warnung faellt
 *      durch jedes Gate hindurch.
 *
 * Run: npx vitest run src/lib/__tests__/das-gate-bleibt-scharf.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ESLint } from 'eslint'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

let eslint: ESLint
beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT })
})

/** Regel-IDs, die eslint fuer diesen Quelltext meldet. */
async function rulesFor(code: string, filePath = 'src/lib/__lint-probe.ts'): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) })
  return res.messages.map((m) => m.ruleId ?? 'UNUSED-DISABLE-DIRECTIVE')
}

describe('no-fallthrough: der Kommentar ist erlaubt, der Durchfall nicht', () => {
  it('ein leeres case mit Kommentar dazwischen ist sauber', async () => {
    const rules = await rulesFor(`
export function f(x: string): number {
  switch (x) {
    case 'a':
    // Teilt sich absichtlich den Rumpf mit 'b' — genau die Form, die
    // side-effect-key.ts dreimal benutzt.
    case 'b':
      return 1
    default:
      return 0
  }
}
`)
    expect(rules).not.toContain('no-fallthrough')
  })

  it('SONDE: ein case MIT Anweisungen faellt weiterhin nicht straflos durch', async () => {
    // Setzt man allowEmptyCase zurueck auf false, bleibt DIESER Test gruen —
    // er ist die Haelfte, die beweist, dass die Lockerung eng ist. Schaltet
    // jemand die Regel dagegen ganz ab, faellt er um.
    const rules = await rulesFor(`
export function f(x: string, sink: string[]): number {
  switch (x) {
    case 'a':
      sink.push('a')
    case 'b':
      sink.push('b')
      return 1
    default:
      return 0
  }
}
`)
    expect(rules).toContain('no-fallthrough')
  })
})

describe('no-unused-vars: `_` ist die Konvention, alles andere bleibt ein Fehler', () => {
  it('ein Unterstrich-Name gilt als absichtlich ungenutzt', async () => {
    const rules = await rulesFor(`
export function f(_args: string, cb: (x: number) => void): void {
  try {
    cb(1)
  } catch (_err) {
    cb(0)
  }
}
`)
    expect(rules).not.toContain('@typescript-eslint/no-unused-vars')
  })

  it('SONDE: ein gefangener Fehler ohne Unterstrich, der nicht gelesen wird, bleibt ein Fehler', async () => {
    // Die Bauart des einzigen echten Fehlers im Haufen. Wuerde man statt der
    // ^_-Muster `caughtErrors: 'none'` setzen — die andere naheliegende Art,
    // 43 auf 3 zu druecken —, waere dieser Test rot und der Fehler fuer immer
    // unsichtbar.
    const rules = await rulesFor(`
export async function f(primary: () => Promise<string>, fallback: () => Promise<string>): Promise<string> {
  try {
    return await primary()
  } catch (e) {
    try {
      return await fallback()
    } catch (fallbackErr) {
      return String(e)
    }
  }
}
`)
    expect(rules).toContain('@typescript-eslint/no-unused-vars')
  })

  it('das Weglass-Idiom mit Rest bleibt sauber — die Namen benennen, was wegfaellt', async () => {
    const rules = await rulesFor(`
type Item = { keep: string; dataUrl: string; unavailable: boolean }
export const strip = (items: Item[]) => items.map(({ dataUrl, unavailable, ...rest }) => rest)
`)
    expect(rules).not.toContain('@typescript-eslint/no-unused-vars')
  })
})

describe('tote Unterdrueckungen sind Fehler, nicht Warnungen', () => {
  it('SONDE: eine Unterdrueckung fuer eine Regel, die nichts meldet, faellt auf', async () => {
    const [res] = await eslint.lintText(
      'export const n: number = 1\n// eslint-disable-next-line no-fallthrough\nexport const m = n + 1\n',
      { filePath: resolve(ROOT, 'src/lib/__lint-probe.ts') },
    )
    const dead = res.messages.filter((m) => m.ruleId === null)
    expect(dead.length, JSON.stringify(res.messages)).toBeGreaterThan(0)
    // Der Punkt der Aenderung: Schweregrad 2, nicht 1. `eslint .` laeuft ohne
    // --max-warnings 0, eine Warnung waere folgenlos.
    expect(dead[0].severity).toBe(2)
  })
})

describe('tsc deckt die Seite ab, die eslint hier abgibt', () => {
  const readCfg = (name: string) => readFileSync(resolve(ROOT, name), 'utf8')

  it('noFallthroughCasesInSwitch steht in JEDEM der drei Projekte', () => {
    // allowEmptyCase ist nur deshalb unbedenklich, weil der gefaehrliche Fall
    // doppelt gedeckt ist. Faellt der Schalter irgendwo raus, ist die
    // Begruendung in eslint.config.js nicht mehr wahr.
    for (const f of ['tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.e2e.json']) {
      expect(readCfg(f), f).toContain('"noFallthroughCasesInSwitch": true')
    }
  })

  it('e2e/ und playwright.config.ts stehen in einem Projekt, das tsconfig.json referenziert', () => {
    // Vor dieser Aenderung stand e2e/ in keinem tsconfig: 17 Spezifikationen
    // plus playwright.config.ts, die `npm run typecheck` nie gelesen hat.
    expect(readCfg('tsconfig.json')).toContain('./tsconfig.e2e.json')
    const e2e = readCfg('tsconfig.e2e.json')
    expect(e2e).toContain('"e2e"')
    expect(e2e).toContain('playwright.config.ts')
  })
})
