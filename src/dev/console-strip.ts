/**
 * §1.6 — `console.log/info/debug` aus dem PRODUKTIONS-Build entfernen,
 * `warn`/`error` behalten. Der Entscheidungs- und Rechenteil des
 * vite-Plugins `lu-strip-console`, ohne vite.
 *
 * Warum von Hand statt per Minifier-Option: das vite 8 hier ist rolldown-basiert
 * und benutzt den oxc-Minifier — der alte `esbuild: { drop, pure }`-Block war
 * damit TOT und `console.*` ging mit ins Bündel. rolldowns oxc-`CompressOptions`
 * kennt nur ein Alles-oder-nichts-`dropConsole`, das `warn`/`error` mitnehmen
 * würde. Also entfernen wir die drei lauten Methoden selbst.
 *
 * Warum das hier steht und nicht mehr in `vite.config.ts`: dieses Plugin
 * schreibt Produktionscode um und war ungetestet. Beim Herauslösen fiel ein
 * toter Zweig auf — der Sonderfall für `switch`-Zweige prüfte
 * `parentKey === 'consequent'`, aber an der Stelle, an der er geprüft wurde,
 * steht der Schlüssel immer auf `'expression'` (der Schlüssel des Aufrufs in
 * SEINEM Elternknoten, dem ExpressionStatement). Der Zweig konnte nie
 * auslösen; `case 1: console.log(x)` wurde zu `case 1: void 0` statt gelöscht.
 * Falsch war nur die Aufräumung, nicht das Ergebnis — aber ein Zweig, der nie
 * läuft, ist keine Absicherung.
 *
 * Der AST kommt aus vites `parseAst` (oxc, ESTree mit Byte-Offsets) — fremde
 * Daten, also `unknown` plus Prüfung an der Grenze statt einer selbstgebauten
 * Knoten-Schnittstelle, die nur behauptet, was drinsteht.
 *
 * REIN, ABSICHTLICH: kein `node:*`- und kein `vite`-Import, damit das Modul in
 * `src` neben seinem Test liegen kann.
 */

import { asNumber, asString, isRecord, prop } from '../types/json-guards'

/** Die drei Methoden, die verschwinden. `warn`/`error` bleiben. */
const TARGETS = new Set(['log', 'info', 'debug'])

/** Dateiendungen, in denen überhaupt umgeschrieben wird. */
const STRIPPABLE = /\.[cm]?[jt]sx?$/

/**
 * Container, aus denen ein ExpressionStatement ersatzlos verschwinden darf:
 * die Geschwister (oder der leere Block) bleiben gültiger Code.
 *
 * `SwitchCase` gehört dazu — ein `case 1:` ohne Rumpf ist erlaubt.
 */
const STATEMENT_LIST_PARENTS = new Set(['BlockStatement', 'Program', 'StaticBlock', 'SwitchCase'])

/** Ein Textbereich, der durch `replacement` ersetzt wird. */
export interface ConsoleRemoval {
  start: number
  end: number
  /** `''` löscht, `'void 0'` neutralisiert und lässt einen Ausdruck stehen. */
  replacement: string
}

/** Der `type` eines ESTree-Knotens, oder `undefined` wenn es keiner ist. */
function nodeType(value: unknown): string | undefined {
  return isRecord(value) ? asString(value.type) : undefined
}

/**
 * Wird in dieser Datei überhaupt umgeschrieben?
 *
 * Der strukturierte Logger (`src/lib/logger.ts`) ist die EINE erlaubte
 * console-Senke: er serialisiert in Produktion jedes Ereignis als einzeilige
 * JSON-Zeile über `console.log`. Dieser Aufruf ist ein klammerloses
 * `else console.log(line)`; würde das Plugin ihn zu `void 0` machen, wäre jedes
 * `log.info`/`log.debug` in Produktion stumm. Also bleibt der Logger
 * unangetastet, wie `node_modules`.
 */
export function isStrippableModule(id: string, code: string): boolean {
  if (id.includes('\0')) return false // virtuelles Modul
  if (id.includes('node_modules')) return false
  const clean = id.split('?')[0]
  if (/[\\/]lib[\\/]logger\.[cm]?[jt]sx?$/.test(clean)) return false
  if (!STRIPPABLE.test(clean)) return false
  return code.includes('console.')
}

/**
 * True genau dann, wenn `node` ein `console.log(…)` / `.info` / `.debug` ist.
 *
 * Nur der blanke `console.<m>(…)`-Aufruf zählt — `foo.console.log`,
 * `myLogger.log` und ein zugewiesenes `const x = console.log` bleiben stehen.
 */
export function isStrippableConsoleCall(node: unknown): boolean {
  if (nodeType(node) !== 'CallExpression') return false
  const callee = prop(node, 'callee')
  if (nodeType(callee) !== 'MemberExpression') return false
  if (prop(callee, 'computed') === true) return false
  const object = prop(callee, 'object')
  const property = prop(callee, 'property')
  return (
    nodeType(object) === 'Identifier' &&
    asString(prop(object, 'name')) === 'console' &&
    nodeType(property) === 'Identifier' &&
    TARGETS.has(asString(prop(property, 'name')) ?? '')
  )
}

/**
 * Alle zu entfernenden Bereiche eines geparsten Moduls, in Quelltext-Reihenfolge
 * des Besuchs (die Anwendung sortiert selbst).
 *
 *   • Ganzer Aufruf als eigene Anweisung in einer Anweisungsliste
 *     → die Anweisung fällt weg.
 *   • Ganzer Aufruf als klammerloser Rumpf eines if/else/for/while/do/label
 *     → der AUFRUF wird `void 0`, damit der Zweig eine Anweisung behält
 *     (`else void 0;`). Löschen würde das `else` verwaisen lassen.
 *   • Aufruf als Teilausdruck (`a && console.log(b)`, Ternär-Arm, Argument)
 *     → der Aufruf wird `void 0`.
 */
export function collectConsoleRemovals(ast: unknown): ConsoleRemoval[] {
  const removals: ConsoleRemoval[] = []

  const push = (node: unknown, replacement: string): void => {
    const start = asNumber(prop(node, 'start'))
    const end = asNumber(prop(node, 'end'))
    // Ohne Byte-Offsets lässt sich nichts schneiden — dann lieber den Aufruf
    // stehen lassen als an einer geratenen Stelle schneiden.
    if (start === undefined || end === undefined) return
    removals.push({ start, end, replacement })
  }

  const visit = (node: unknown, parent: unknown, grandparent: unknown): void => {
    if (nodeType(node) === undefined || !isRecord(node)) return

    if (isStrippableConsoleCall(node)) {
      const isOwnStatement =
        nodeType(parent) === 'ExpressionStatement' && prop(parent, 'expression') === node
      const container = nodeType(grandparent)
      if (isOwnStatement && container !== undefined && STATEMENT_LIST_PARENTS.has(container)) {
        push(parent, '') // inklusive des abschliessenden `;`
      } else {
        push(node, 'void 0')
      }
      return // nicht in die Argumente eines Aufrufs absteigen, der wegfällt
    }

    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end' || key === 'parent') continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const item of child) {
          if (nodeType(item) !== undefined) visit(item, node, parent)
        }
      } else if (nodeType(child) !== undefined) {
        visit(child, node, parent)
      }
    }
  }

  visit(ast, undefined, undefined)
  return removals
}

/**
 * Die Bereiche auf den Quelltext anwenden — von hinten nach vorn, damit die
 * früheren Offsets gültig bleiben.
 */
export function applyConsoleRemovals(code: string, removals: readonly ConsoleRemoval[]): string {
  const ordered = [...removals].sort((a, b) => b.start - a.start)
  let out = code
  for (const removal of ordered) {
    out = out.slice(0, removal.start) + removal.replacement + out.slice(removal.end)
  }
  return out
}
