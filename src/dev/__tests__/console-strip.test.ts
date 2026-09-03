/**
 * §1.6 — `console.log/info/debug` aus dem Produktions-Build entfernen.
 *
 * Dieses Plugin schreibt Produktionscode um und war ungetestet. Die Tests
 * gehen den ganzen Weg: echter Quelltext → vites `parseAst` (derselbe
 * oxc-Parser wie im Build) → Bereiche sammeln → anwenden → das Ergebnis muss
 * WIEDER PARSEBAR sein. Ein Umschreiber, der syntaktisch kaputten Code
 * ausspuckt, fällt sonst erst im Build auf.
 *
 * BEFUND beim Herauslösen: der Sonderfall für `switch`-Zweige prüfte
 * `parentKey === 'consequent'`. An der Stelle, an der er geprüft wurde, steht
 * der Schlüssel aber immer auf `'expression'` — es ist der Schlüssel des
 * Aufrufs in SEINEM Elternknoten (dem ExpressionStatement), nicht der des
 * Statements in der `switch`-Liste. Der Zweig konnte nie auslösen, und
 * `case 1: console.log(x)` wurde zu `case 1: void 0` statt gelöscht zu werden.
 * Das Ergebnis war gültig, die Absicht nicht erfüllt.
 *
 * NEGATIVE CONTROL (von Hand geprüft):
 *   • 'SwitchCase' aus STATEMENT_LIST_PARENTS entfernen (= der alte Zustand)
 *     → "eine Anweisung in einem switch-Zweig fällt weg" wird rot.
 *   • in `collectConsoleRemovals` das `return` nach dem Treffer streichen
 *     → "verschachtelte Aufrufe überlappen nicht" wird rot.
 *   • in `applyConsoleRemovals` von vorn nach hinten sortieren
 *     → "mehrere Aufrufe in einer Datei" wird rot.
 *   • in `isStrippableModule` die logger-Zeile entfernen
 *     → "der strukturierte Logger bleibt unangetastet" wird rot.
 *
 * Run: npx vitest run src/dev/__tests__/console-strip.test.ts
 */
import { describe, expect, it } from 'vitest'
import { parseAst } from 'vite'
import {
  applyConsoleRemovals,
  collectConsoleRemovals,
  isStrippableConsoleCall,
  isStrippableModule,
} from '../console-strip'

/** Den kompletten Plugin-Durchlauf auf einem Stück Quelltext. */
function strip(code: string): string {
  const removals = collectConsoleRemovals(parseAst(code, { sourceType: 'module' }))
  return applyConsoleRemovals(code, removals)
}

/** Bleibt das Ergebnis parsebar? Das ist die eigentliche Zusicherung. */
function stillParses(code: string): boolean {
  try {
    parseAst(code, { sourceType: 'module' })
    return true
  } catch {
    return false
  }
}

describe('isStrippableModule', () => {
  it('nimmt normale Quelldateien', () => {
    expect(isStrippableModule('/p/src/app.tsx', 'console.log(1)')).toBe(true)
    expect(isStrippableModule('/p/src/a.mjs?v=1', 'console.log(1)')).toBe(true)
  })

  it('lässt virtuelle Module und node_modules aus', () => {
    expect(isStrippableModule('\0virtual:x', 'console.log(1)')).toBe(false)
    expect(isStrippableModule('/p/node_modules/lib/x.js', 'console.log(1)')).toBe(false)
  })

  it('der strukturierte Logger bleibt unangetastet', () => {
    // In Produktion serialisiert src/lib/logger.ts jedes Ereignis über
    // console.log. Neutralisiert das Plugin diesen Aufruf, ist JEDES
    // log.info/log.debug stumm.
    expect(isStrippableModule('/p/src/lib/logger.ts', 'console.log(line)')).toBe(false)
    expect(isStrippableModule('C:\\p\\src\\lib\\logger.ts', 'console.log(line)')).toBe(false)
    // Eine andere Datei namens logger in einem anderen Ordner ist nicht gemeint.
    expect(isStrippableModule('/p/src/api/logger.ts', 'console.log(1)')).toBe(true)
  })

  it('spart sich die Arbeit, wenn kein console darin vorkommt', () => {
    expect(isStrippableModule('/p/src/app.ts', 'const a = 1')).toBe(false)
  })

  it('lässt Nicht-Quelldateien aus', () => {
    expect(isStrippableModule('/p/src/style.css', 'console.log(1)')).toBe(false)
  })
})

describe('isStrippableConsoleCall', () => {
  const callOf = (code: string): unknown => {
    const ast = parseAst(code, { sourceType: 'module' }) as { body: { expression: unknown }[] }
    return ast.body[0].expression
  }

  it('trifft die drei lauten Methoden', () => {
    for (const m of ['log', 'info', 'debug']) {
      expect(isStrippableConsoleCall(callOf(`console.${m}(1)`)), m).toBe(true)
    }
  })

  it('lässt warn und error stehen', () => {
    for (const m of ['warn', 'error', 'trace', 'table']) {
      expect(isStrippableConsoleCall(callOf(`console.${m}(1)`)), m).toBe(false)
    }
  })

  it('trifft nur das blanke console', () => {
    expect(isStrippableConsoleCall(callOf('myLogger.log(1)'))).toBe(false)
    expect(isStrippableConsoleCall(callOf('foo.console.log(1)'))).toBe(false)
    expect(isStrippableConsoleCall(callOf("console['log'](1)"))).toBe(false)
  })

  it('sagt zu allem anderen nein, ohne zu werfen', () => {
    for (const value of [null, undefined, 42, 'x', {}, { type: 'CallExpression' }]) {
      expect(isStrippableConsoleCall(value)).toBe(false)
    }
  })
})

describe('der Umschreiber', () => {
  it('löscht eine Anweisung in einem Block', () => {
    const out = strip('function f() {\n  console.log("x")\n  return 1\n}\n')
    expect(out).not.toContain('console.log')
    expect(out).toContain('return 1')
    expect(out).not.toContain('void 0')
    expect(stillParses(out)).toBe(true)
  })

  it('löscht eine Anweisung auf oberster Ebene', () => {
    const out = strip('const a = 1\nconsole.log(a)\nexport default a\n')
    expect(out).not.toContain('console.log')
    expect(stillParses(out)).toBe(true)
  })

  it('eine Anweisung in einem switch-Zweig fällt weg', () => {
    // Der tote Zweig von vorher: hier stand `case 1: void 0`.
    const out = strip('switch (x) {\n  case 1:\n    console.log(1)\n    break\n}\n')
    expect(out).not.toContain('console.log')
    expect(out).not.toContain('void 0')
    expect(out).toContain('break')
    expect(stillParses(out)).toBe(true)
  })

  it('ein einziger Aufruf als ganzer switch-Zweig bleibt gültig', () => {
    const out = strip('switch (x) {\n  case 1:\n    console.log(1)\n}\n')
    expect(out).not.toContain('console.log')
    expect(stillParses(out)).toBe(true)
  })

  it('behält einen klammerlosen else-Zweig als Anweisung', () => {
    // Genau der logger.ts-Fall, an dem die naive Fassung Code zerbrach.
    const out = strip('if (a) console.error(x)\nelse console.log(y)\n')
    expect(out).toContain('console.error(x)')
    expect(out).not.toContain('console.log')
    expect(out).toContain('void 0')
    expect(stillParses(out)).toBe(true)
  })

  it('behält klammerlose Schleifen- und Label-Rümpfe', () => {
    for (const code of [
      'for (const x of xs) console.log(x)\n',
      'while (a) console.log(1)\n',
      'do console.log(1)\nwhile (a)\n',
      'if (a) console.log(1)\n',
      'lab: console.log(1)\n',
    ]) {
      const out = strip(code)
      expect(out, code).not.toContain('console.log')
      expect(stillParses(out), `${code} → ${out}`).toBe(true)
    }
  })

  it('neutralisiert einen Aufruf als Teilausdruck', () => {
    for (const code of [
      'const a = b && console.log(1)\n',
      'const a = c ? console.log(1) : 2\n',
      'f(console.log(1))\n',
      'const a = [console.log(1)]\n',
      'const a = () => console.log(1)\n',
    ]) {
      const out = strip(code)
      expect(out, code).not.toContain('console.log')
      expect(out, code).toContain('void 0')
      expect(stillParses(out), `${code} → ${out}`).toBe(true)
    }
  })

  it('verschachtelte Aufrufe überlappen nicht', () => {
    // Der äussere Aufruf verschwindet ganz; der innere darf nicht ZUSÄTZLICH
    // geschnitten werden, sonst überlappen die Bereiche und der Text zerfällt.
    const out = strip('function f() {\n  console.log(console.log(1))\n}\n')
    expect(out).not.toContain('console.log')
    expect(stillParses(out)).toBe(true)
  })

  it('mehrere Aufrufe in einer Datei', () => {
    const code = [
      'function f() {',
      '  console.log("a")',
      '  console.warn("b")',
      '  console.debug("c")',
      '  return 1',
      '}',
      'console.info("d")',
      'export default f',
      '',
    ].join('\n')
    const out = strip(code)
    expect(out).toContain('console.warn("b")')
    expect(out).not.toContain('console.log')
    expect(out).not.toContain('console.debug')
    expect(out).not.toContain('console.info')
    expect(out).toContain('return 1')
    expect(out).toContain('export default f')
    expect(stillParses(out)).toBe(true)
  })

  it('fasst eine Datei ohne Treffer nicht an', () => {
    const code = 'console.warn("nur warn")\nconsole.error("und error")\n'
    expect(collectConsoleRemovals(parseAst(code, { sourceType: 'module' }))).toEqual([])
  })

  it('lässt eine zugewiesene Referenz auf console.log stehen', () => {
    const code = 'const l = console.log\nl(1)\n'
    expect(strip(code)).toBe(code)
  })
})

describe('applyConsoleRemovals', () => {
  it('wendet von hinten nach vorn an, damit frühere Offsets gültig bleiben', () => {
    const code = 'AAAABBBBCCCC'
    const out = applyConsoleRemovals(code, [
      { start: 0, end: 4, replacement: 'x' },
      { start: 8, end: 12, replacement: 'y' },
    ])
    expect(out).toBe('xBBBBy')
  })

  it('ändert die übergebene Liste nicht', () => {
    const removals = [{ start: 4, end: 8, replacement: '' }, { start: 0, end: 4, replacement: '' }]
    applyConsoleRemovals('AAAABBBB', removals)
    expect(removals[0].start).toBe(4)
  })
})
