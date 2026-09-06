/**
 * Die Chat-Id-Sanitisierung des Dev-Käfigs, gegen die Rust-Quelle gestellt.
 *
 * DER BEFUND: `devSanitizeChatSlug` (damals noch inline in `devWorkspaceRoot`)
 * erlaubte `[A-Za-z0-9_.-]` — MIT Punkt — und der Kommentar daneben behauptete
 * „exactly like the Rust side". Rust erlaubt `[A-Za-z0-9_-]`. Mit dem Punkt
 * überlebte eine Chat-Id von `".."` die Sanitisierung, `<workspace>/..`
 * kollabierte in `lexicalNormalize` auf `$HOME`, und die KÄFIGWURZEL SELBST
 * war damit das Heimatverzeichnis. Auf der Rust-Seite ist das Audit IPC-1.
 *
 * WARUM DIESE DATEI DIE RUST-QUELLE LIEST statt zwei Listen zu pflegen: ein
 * Test, der seine Erwartung aus dem ableitet, was er absichern soll, prüft
 * nichts — und zwei von Hand gepflegte Listen sind genau die Konstruktion, die
 * den Fehler erst erzeugt hat. Dieselbe Technik benutzt
 * `src/lib/__tests__/app-identity.test.ts` für die Verzeichnisnamen.
 *
 * Der Test steht deshalb auf drei Beinen:
 *   1. Er ZERLEGT `agent::sanitize_chat_slug` in seine Regeln (Kappung,
 *      Zeichenmenge, Ersatzzeichen, Leer-Rückfall) und baut daraus eine
 *      Referenz.
 *   2. Er vergleicht die TS-Seite mit dieser Referenz über ein Korpus, das die
 *      gefährlichen Formen UND einen systematischen Codepoint-Durchlauf
 *      enthält.
 *   3. Er prüft die Sicherheitseigenschaft SELBST (die Wurzel bleibt unter dem
 *      Workspace-Verzeichnis) — sonst wäre der Test grün, wenn beide Seiten
 *      denselben Fehler machen.
 *
 * MUTATIONSSONDE (von Hand geprüft): in `src/lib/dev-fs-jail.ts` den Punkt in
 * die Zeichenklasse zurücksetzen (`/^[A-Za-z0-9_.-]$/`) → „dieselbe
 * Zeichenmenge", „ein Punkt ist kein erlaubtes Zeichen" und „die Wurzel bleibt
 * im Workspace" werden rot; zurücknehmen → grün. `Array.from` durch `.split('')`
 * ersetzen → der Codepoint-Fall wird rot.
 *
 * Run: npx vitest run src/lib/__tests__/dev-fs-jail-slug.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { devSanitizeChatSlug, devWorkspaceRoot } from '../dev-fs-jail'
import { AGENT_WORKSPACE_DIR } from '../app-identity'

const HOME = '/home/tester'

// ── Die Rust-Regel, aus der Quelle gelesen ──────────────────────────────────

const agentRs = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/commands/agent.rs'),
  'utf8',
)

/** Der Rumpf von `sanitize_chat_slug`, ohne den Rest der Datei. */
function slugFnBody(): string {
  const start = agentRs.indexOf('pub(crate) fn sanitize_chat_slug(')
  expect(start, 'sanitize_chat_slug nicht in agent.rs gefunden').toBeGreaterThanOrEqual(0)
  const rest = agentRs.slice(start)
  const end = rest.indexOf('\n}')
  expect(end, 'Ende von sanitize_chat_slug nicht gefunden').toBeGreaterThan(0)
  return rest.slice(0, end + 2)
}

interface RustSlugRule {
  cap: number
  /** True, wenn `[A-Za-z0-9]` durchgelassen wird (`is_ascii_alphanumeric`). */
  alnum: boolean
  /** Die zusätzlich erlaubten Einzelzeichen aus den `c == '…'`-Vergleichen. */
  extras: string[]
  /** Womit alles andere ersetzt wird. */
  replacement: string
  /** Der Rückfall für ein LEERES Ergebnis. */
  emptyFallback: string
}

/**
 * `sanitize_chat_slug` in seine Regeln zerlegen.
 *
 * Jede Regel wird einzeln herausgelesen und die Prädikat-Zeile am Ende aus den
 * gelesenen Teilen WIEDER ZUSAMMENGESETZT und verglichen. Ohne diesen
 * Rückbau würde eine Rust-Änderung, die dieser Parser nicht kennt (ein
 * zusätzliches `|| c == '.'`), stillschweigend unter den Tisch fallen — der
 * Test wäre grün und hätte weniger geprüft, als er behauptet.
 */
function parseRustSlugRule(): RustSlugRule {
  const body = slugFnBody()

  // Kappung, und WORAUF sie zählt: `.chars()` sind Unicode-Skalarwerte, nicht
  // UTF-16-Einheiten. Das ist der Unterschied zwischen `Array.from` und
  // `.split('')` auf der TS-Seite.
  expect(body, 'sanitize_chat_slug zählt nicht mehr in `.chars()`').toContain('.chars()')
  const cap = /\.take\((\d+)\)/.exec(body)
  expect(cap, '.take(N) nicht gefunden').not.toBeNull()

  // Das Prädikat der `.map(|c| …)`-Zeile.
  const map = /\.map\(\|c\|\s*if\s+([^{]+?)\s*\{\s*c\s*\}\s*else\s*\{\s*'(.)'\s*\}\s*\)/.exec(body)
  expect(map, 'die .map(|c| if … { c } else { … })-Zeile nicht gefunden').not.toBeNull()
  const predicate = map![1].replace(/\s+/g, ' ').trim()
  const replacement = map![2]

  const alnum = /\bc\.is_ascii_alphanumeric\(\)/.test(predicate)
  const extras = [...predicate.matchAll(/c == '(.)'/g)].map((m) => m[1])

  // Der Rückbau: kennt der Parser JEDEN Teil des Prädikats?
  const rebuilt = [
    ...(alnum ? ['c.is_ascii_alphanumeric()'] : []),
    ...extras.map((e) => `c == '${e}'`),
  ].join(' || ')
  expect(
    predicate,
    'das Prädikat enthält eine Regel, die dieser Test nicht modelliert — nachsehen, nicht anpassen',
  ).toBe(rebuilt)

  // Der Rückfall gilt für ein LEERES Ergebnis, nicht für irgendeine andere
  // Form: ein Slug wie `"__"` muss ein eigener Ordner bleiben.
  const fallback =
    /if\s+safe\.is_empty\(\)\s*\{\s*"([^"]*)"\.to_string\(\)\s*\}\s*else\s*\{\s*safe\s*\}/.exec(body)
  expect(fallback, 'der Leer-Rückfall hat eine andere Form als erwartet').not.toBeNull()

  return {
    cap: Number(cap![1]),
    alnum,
    extras,
    replacement,
    emptyFallback: fallback![1],
  }
}

const RULE = parseRustSlugRule()

/** Die Referenz, ausschliesslich aus den oben gelesenen Regeln gebaut. */
function rustSlug(id: string): string {
  const allowed = (c: string): boolean =>
    (RULE.alnum && /^[A-Za-z0-9]$/.test(c)) || RULE.extras.includes(c)
  const safe = Array.from(id)
    .slice(0, RULE.cap)
    .map((c) => (allowed(c) ? c : RULE.replacement))
    .join('')
  return safe === '' ? RULE.emptyFallback : safe
}

// ── Das Korpus ─────────────────────────────────────────────────────────────

/** Die gefährlichen und die alltäglichen Formen, plus ein Codepoint-Durchlauf. */
function corpus(): string[] {
  const ids = [
    // Der IPC-1-Kern.
    '..', '.', '...', './..', '../..', '.ssh', 'a.b', 'a..b',
    // Was danach herauskommen soll — muss ein eigener Ordner bleiben.
    '__', '_', 'default', '-',
    // Alltag.
    '', 'chat-1', 'mein-projekt-a1b2c3', '__remote__', 'c-1735689600000-x9f2',
    '8f7c2a1b-4d3e-4f5a-9b8c-1e2d3f4a5b6c',
    // Trenner und Steuerzeichen.
    '../../etc', 'a/b c', 'a\\b', 'C:\\x', '\u0000', '\n', '\t', ' ',
    // Kappung.
    'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'x'.repeat(200),
    `${'a'.repeat(63)}..`, `${'a'.repeat(64)}..`,
    // Ausserhalb der BMP: in UTF-16 zwei Einheiten, in `.chars()` EIN Zeichen.
    '\u{1F642}', '\u{1F642}'.repeat(40), '\u{1F642}'.repeat(100),
    `${'a'.repeat(63)}\u{1F642}b`,
    // Innerhalb der BMP, aber nicht ASCII.
    'ä', 'ﬁ', 'Ω', '日本語',
  ]
  // Systematisch: jeder Codepoint bis U+02FF einzeln.
  for (let cp = 0; cp <= 0x2ff; cp++) ids.push(String.fromCodePoint(cp))
  // Und ein paar astrale Einzelzeichen.
  for (const cp of [0x10000, 0x1f600, 0x1d400, 0x2f800, 0x10fffe]) {
    ids.push(String.fromCodePoint(cp))
  }
  return ids
}

/** Lesbarer Name für eine Id, die Steuerzeichen enthalten kann. */
function zeige(id: string): string {
  return JSON.stringify(id)
}

// ── Die Zusicherungen ──────────────────────────────────────────────────────

describe('die Rust-Regel, wie dieser Test sie gelesen hat', () => {
  it('kappt bei 64 und ersetzt mit einem Unterstrich', () => {
    expect(RULE.cap).toBe(64)
    expect(RULE.replacement).toBe('_')
    expect(RULE.emptyFallback).toBe('default')
  })

  it('erlaubt Alphanumerik plus genau zwei Sonderzeichen — und der Punkt ist keines davon', () => {
    // Die eigentliche IPC-1-Zusicherung, auf der RUST-Seite: käme `.` dort
    // jemals zurück, sagt es dieser Test, bevor der Port es kopiert.
    expect(RULE.alnum).toBe(true)
    expect(RULE.extras.sort()).toEqual(['-', '_'])
    expect(RULE.extras, 'der Punkt ist wieder erlaubt — das ist IPC-1').not.toContain('.')
  })
})

describe('devSanitizeChatSlug gegen sanitize_chat_slug', () => {
  it('gibt für jede Id im Korpus dasselbe wie die Rust-Regel', () => {
    for (const id of corpus()) {
      expect(devSanitizeChatSlug(id), `Id ${zeige(id)}`).toBe(rustSlug(id))
    }
  })

  it('ersetzt den Punkt, statt ihn durchzulassen', () => {
    // Unabhängig formuliert, nicht aus der Rust-Quelle abgeleitet: wenn beide
    // Seiten denselben Fehler machen, ist der Vergleich oben grün.
    expect(devSanitizeChatSlug('..')).toBe('__')
    expect(devSanitizeChatSlug('.')).toBe('_')
    expect(devSanitizeChatSlug('a.b')).toBe('a_b')
    expect(devSanitizeChatSlug('.ssh')).toBe('_ssh')
  })

  it('lässt `__` ein eigener Ordner sein, nicht `default`', () => {
    // Der Rückfall gilt NUR für ein leeres Ergebnis. Zöge er auch hier, teilten
    // sich zwei verschiedene Chats ein Verzeichnis.
    expect(devSanitizeChatSlug('..')).not.toBe('default')
    expect(devSanitizeChatSlug('__')).toBe('__')
    expect(devSanitizeChatSlug('')).toBe('default')
  })

  it('zählt in Codepoints, nicht in UTF-16-Einheiten', () => {
    // Ein Zeichen ausserhalb der BMP ist in JS zwei Einheiten. Wurde es als
    // zwei gezählt, ergab es zwei Unterstriche statt einem — und die Kappung
    // schnitt an einer anderen Stelle als in der App.
    expect(devSanitizeChatSlug('\u{1F642}')).toBe('_')
    expect(devSanitizeChatSlug('\u{1F642}'.repeat(40))).toBe('_'.repeat(40))
    expect(devSanitizeChatSlug('\u{1F642}'.repeat(100))).toBe('_'.repeat(64))
  })

  it('kappt bei 64 — vor dem Ersetzen, wie `.take(64)` vor `.map(…)`', () => {
    expect(devSanitizeChatSlug('a'.repeat(200))).toBe('a'.repeat(64))
    expect(devSanitizeChatSlug(`${'a'.repeat(63)}..`)).toBe(`${'a'.repeat(63)}_`)
  })
})

describe('die Käfigwurzel, die daraus wird', () => {
  const WS = `${HOME}/${AGENT_WORKSPACE_DIR}`

  it('bleibt für JEDE Id im Korpus unter dem Workspace-Verzeichnis', () => {
    // Die Eigenschaft selbst, unabhängig von beiden Sanitisierern: keine Id
    // darf die Wurzel nach oben verschieben.
    for (const id of corpus()) {
      const root = devWorkspaceRoot(HOME, id)
      expect(root, `Id ${zeige(id)} verlässt den Workspace`).toMatch(
        new RegExp(`^${WS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+$`),
      )
      expect(root, `Id ${zeige(id)} ist der Workspace selbst`).not.toBe(WS)
      expect(root, `Id ${zeige(id)} ist das Heimatverzeichnis`).not.toBe(HOME)
    }
  })

  it('macht aus `..` einen Unterordner statt aus dem Heimatverzeichnis die Wurzel', () => {
    // Der Befund als Einzeiler: vorher `/home/tester`, jetzt `…/__`.
    expect(devWorkspaceRoot(HOME, '..')).toBe(`${WS}/__`)
    expect(devWorkspaceRoot(HOME, '../..')).toBe(`${WS}/_____`)
    expect(devWorkspaceRoot(HOME, '.')).toBe(`${WS}/_`)
  })

  it('lässt einen gewöhnlichen Chat unverändert, wo er war', () => {
    // Echte Ids sind `[a-z0-9-]` (chatWorkspaceSlug), enthalten also nie einen
    // Punkt: für sie ändert der Fix nichts.
    expect(devWorkspaceRoot(HOME, 'mein-projekt-a1b2c3')).toBe(`${WS}/mein-projekt-a1b2c3`)
    expect(devWorkspaceRoot(HOME, '__remote__')).toBe(`${WS}/__remote__`)
    expect(devWorkspaceRoot(HOME, null)).toBe(`${WS}/default`)
    expect(devWorkspaceRoot(HOME, '')).toBe(`${WS}/default`)
  })

  it('ändert nichts daran, dass ein Arbeitsordner gewinnt', () => {
    expect(devWorkspaceRoot(HOME, '..', '/projects/app')).toBe('/projects/app')
  })
})
