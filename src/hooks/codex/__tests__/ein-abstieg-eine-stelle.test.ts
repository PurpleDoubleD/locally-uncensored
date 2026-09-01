/**
 * KF-21 — der Denk-Abstieg: EINE Stelle, und die Zusatzbedingung ueberlebt.
 *
 * ── DER BEFUND ─────────────────────────────────────────────────────────────
 * Die Frage "muss der Denkmodus herabgestuft werden?" stand dreimal in
 * useCodex.ts, in drei Schreibweisen. Zwei unterschieden sich nur in der
 * Reihenfolge der `||`-Operanden. Die Hermes-Kopie trug eine ZUSATZBEDINGUNG,
 * die den anderen beiden fehlte: nur absteigen, wenn ueberhaupt ein
 * Denk-Schalter gesetzt war.
 *
 * Das ist die gefaehrlichste Form der Doppelung: drei Kopien, die fast gleich
 * sind. Der Unterschied sieht aus wie ein Schreibfehler und wird beim
 * Vereinheitlichen still weggeraeumt.
 *
 * ── DAS URTEIL ─────────────────────────────────────────────────────────────
 * Die Zusatzbedingung ist KEINE Hermes-Eigenart, sondern eine Luecke in den
 * anderen beiden. Der Abstieg besteht darin, `thinking` fallen zu lassen — war
 * es schon `undefined`, ist die Wiederholung Byte fuer Byte die gescheiterte
 * Anfrage. useChat.ts fragt seit jeher so, useAgentChat.ts hat es am
 * 2026-08-14 in allen drei Zweigen nachgetragen. Die Begruendung steht an der
 * zusammengezogenen Stelle: codex/thinking-downgrade.ts.
 *
 * Diese Reihe misst beides: DASS es eine Stelle ist, und DASS sie die
 * Zusatzbedingung traegt. Eine Wache, die nur zaehlt, waere auch dann gruen,
 * wenn die Vereinheitlichung die Bedingung verloren haette.
 *
 * ── KF-21b: DIE WACHE ZAEHLT JETZT REPO-WEIT ───────────────────────────────
 * Die erste Fassung las nur useCodex.ts. Damit war sie gruen, waehrend
 * ausserhalb noch VIER Kopien standen: drei in useAgentChat.ts und eine in
 * useChat.ts. Genau so waechst eine Kopie an der naechsten Stelle nach. Der
 * Zaehler unten liest darum jede .ts/.tsx unter src/.
 *
 * Und er misst dabei die 422-Entscheidung mit: useChat.ts trug als einzige
 * Kopie zusaetzlich `status === 422`. Das ist DeepInfras Status hinter dem
 * LU-Cloud-Proxy und erreicht `provider.chatStream` — denselben Aufruf, den
 * auch `streamProviderTurn` fuer die Agenten- und Codex-Zweige macht. Also
 * keine Eigenheit dieses Transports, sondern eine Luecke in den anderen: der
 * 422 ist in die gemeinsame Fehlerform gewandert und gilt fuer alle. Die
 * Faelle unten halten fest, dass die Vereinheitlichung ihn NICHT verloren hat.
 *
 * Run: npx vitest run src/hooks/codex/__tests__/ein-abstieg-eine-stelle.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join, relative } from 'node:path'
import { shouldDowngradeThinking, isThinkingUnsupportedError } from '../thinking-downgrade'

// Auf LF normiert: eine Windows-Auscheckung mit core.autocrlf=true legt CRLF
// an, und die mehrzeiligen Pins scheiterten sonst schon an den Zeilenenden.
const hier = dirname(fileURLToPath(import.meta.url))
const lies = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const srcWurzel = resolve(hier, '../../..')
const useCodex = lies(resolve(hier, '../../useCodex.ts'))
const modul = lies(resolve(hier, '../thinking-downgrade.ts'))

const vierhundert = () => Object.assign(new Error('bad request'), { status: 400 })
const vierzweizwei = () => Object.assign(new Error('bad parameter'), { status: 422 })

describe('die Zusatzbedingung: nur absteigen, wenn es etwas fallen zu lassen gibt', () => {
  it('mit angefragtem Denkmodus steigt der Lauf ab', () => {
    expect(shouldDowngradeThinking(true, vierhundert())).toBe(true)
  })

  it('ein ausdrueckliches AUS zaehlt auch — `false` ist ein gesetzter Schalter', () => {
    // `false` heisst "aus", `undefined` heisst "der Server entscheidet". Die
    // Wiederholung schickt also etwas anderes als der gescheiterte Zug.
    expect(shouldDowngradeThinking(false, vierhundert())).toBe(true)
  })

  it('OHNE angefragten Denkmodus steigt er NICHT ab — das ist die Bedingung', () => {
    // Ohne sie waere die Wiederholung Byte fuer Byte die Anfrage, die eben
    // gescheitert ist: zweite Absage, zweite Abrechnung, zweite Wartezeit.
    expect(shouldDowngradeThinking(undefined, vierhundert())).toBe(false)
    expect(shouldDowngradeThinking(undefined, new Error('does not support thinking'))).toBe(false)
  })

  it('ein anderer Fehler bleibt ein anderer Fehler', () => {
    expect(shouldDowngradeThinking(true, Object.assign(new Error('nope'), { status: 500 }))).toBe(false)
    expect(shouldDowngradeThinking(true, new Error('Failed to fetch'))).toBe(false)
  })

  it('ein geworfener Nicht-Fehler wirft hier nicht', () => {
    expect(() => shouldDowngradeThinking(true, null)).not.toThrow()
    expect(shouldDowngradeThinking(true, null)).toBe(false)
    expect(shouldDowngradeThinking(true, 'does not support thinking')).toBe(true)
  })

  it('die Fehlerform allein bleibt fuer sich pruefbar', () => {
    // `isThinkingUnsupportedError` ist die halbe Frage und bleibt exportiert;
    // entschieden wird aber ueber `shouldDowngradeThinking`.
    expect(isThinkingUnsupportedError(vierhundert())).toBe(true)
  })
})

describe('der 422 ist mitgewandert, nicht verlorengegangen', () => {
  // Er stand vor dem Zusammenziehen NUR in useChat.ts. Eine Vereinheitlichung,
  // die ihn still einebnet, waere schlimmer als die Kopien: derselbe Anbieter
  // haette auf dem Agentenpfad weiter den ganzen Lauf beendet, wo der Chat nur
  // eine Wiederholung zahlt.
  it('DeepInfras 422 loest denselben Abstieg aus wie ein 400', () => {
    expect(isThinkingUnsupportedError(vierzweizwei())).toBe(true)
    expect(shouldDowngradeThinking(true, vierzweizwei())).toBe(true)
  })

  it('auch in der `statusCode`-Schreibweise des Ollama-Streams', () => {
    // `httpStatusOf` liest beide Felder; ein Waechter, der nur `status` kennt,
    // waere auf dem anderen Transport tot.
    expect(shouldDowngradeThinking(true, Object.assign(new Error('x'), { statusCode: 422 }))).toBe(true)
  })

  it('die Zusatzbedingung deckelt ihn genauso', () => {
    expect(shouldDowngradeThinking(undefined, vierzweizwei())).toBe(false)
  })

  it('und ein 4xx daneben bleibt draussen', () => {
    // 421 und 423 sind keine Bad-Parameter-Antworten. Waere die Pruefung als
    // "irgendein 4xx" gebaut, faenge sie auch Rechte- und Sperrfehler ein.
    expect(shouldDowngradeThinking(true, Object.assign(new Error('x'), { status: 421 }))).toBe(false)
    expect(shouldDowngradeThinking(true, Object.assign(new Error('x'), { status: 423 }))).toBe(false)
  })

  it('das WARUM steht am Modul, sonst faellt der 422 beim naechsten Aufraeumen', () => {
    expect(modul).toContain('422')
    expect(modul).toContain('DeepInfra')
    expect(modul).toContain('provider.chatStream')
    expect(modul).toContain('openai-provider.ts')
  })
})

describe('EINE Stelle entscheidet', () => {
  const aufrufe = useCodex.match(/shouldDowngradeThinking\(/g) ?? []

  it('useCodex.ts fragt an genau drei Transporten, und immer ueber die eine Stelle', () => {
    expect(aufrufe).toHaveLength(3)
  })

  it('jeder Transport reicht SEINE eigenen Optionen hinein', () => {
    // Ein fest verdrahtetes `true` waere die Zusatzbedingung durch die
    // Hintertuer wieder abgewaehlt.
    expect(useCodex).toContain('shouldDowngradeThinking(chatOptions.thinking, thinkErr)')
    expect(useCodex).toContain('shouldDowngradeThinking(streamOpts.thinking, thinkErr)')
    expect(useCodex).toContain('shouldDowngradeThinking(hermesOpts.thinking, thinkErr)')
  })

  it('keine Kopie der Fehlerform ist in useCodex.ts zurueckgeblieben', () => {
    expect(useCodex).not.toContain('does not support thinking')
    expect(useCodex).not.toMatch(/httpStatusOf\([^)]*\)\s*===\s*400/)
    // Auch nicht die halbe Frage: wer sie hier direkt stellt, umgeht die
    // Zusatzbedingung.
    expect(useCodex).not.toContain('isThinkingUnsupportedError')
  })

  it('die Zusatzbedingung steht nicht noch einmal VOR dem Aufruf', () => {
    expect(useCodex).not.toMatch(/thinking !== undefined\s*&&\s*shouldDowngradeThinking/)
  })
})

describe('die zusammengezogene Stelle haelt die Zusatzbedingung fest', () => {
  it('sie steht im Modul, nicht an den Aufrufstellen', () => {
    expect(modul).toContain('requestedThinking !== undefined')
  })

  it('und die Begruendung steht dabei, damit sie niemand als Rauschen entfernt', () => {
    // Ohne das WARUM sieht die Bedingung beim naechsten Aufraeumen wieder aus
    // wie ein Schreibfehler — genau so ist sie in zwei von drei Zweigen
    // verlorengegangen.
    expect(modul).toContain('die eben gescheitert ist')
    expect(modul).toContain('zweite Abrechnung')
    expect(modul).toContain('useChat.ts')
    expect(modul).toContain('useAgentChat.ts')
    expect(modul).toContain('2026-08-14')
  })

  it('die drei alten Schreibweisen bleiben als Fundstelle notiert', () => {
    expect(modul).toContain('Ollama:')
    expect(modul).toContain('OpenAI:')
    expect(modul).toContain('Hermes:')
  })
})

// ── DER REPO-WEITE ZAEHLER ────────────────────────────────────────────────────
//
// Was gezaehlt wird, ist die FEHLERFORM als Ausdruck: der Modelltext und eine
// 400/422-Pruefung, mit `||` in EINEM Ausdruck verbunden — in beiden
// Reihenfolgen, denn genau darin unterschieden sich zwei der alten Kopien.
//
// Der Abstand `[^;{}]{0,160}` haelt den Treffer innerhalb einer Anweisung: ohne
// ihn wuerde ein `'does not support thinking'` in einer Meldung irgendwo im
// File mit einer 400 dreissig Zeilen weiter zu einem Phantomtreffer.
//
// Was NICHT zaehlt und auch nicht zaehlen darf: der blosse Modelltext. Er steht
// zu Recht an drei Stellen, die keine Entscheidung treffen — als Knopf-Tooltip
// (components/chat/ChatInput.tsx) und als Erklaersatz fuer den Nutzer in
// useChat.ts und useAgentChat.ts, wenn der Abstieg endgueltig gescheitert ist.
// Eine Wache, die den Text allein verbietet, waere Laerm und wuerde abgeschaltet.
const GRENZE = '[^;{}]{0,160}'
const MODELLTEXT = "'does not support thinking'"
const FEHLERFORM = new RegExp(
  `(?:${MODELLTEXT}${GRENZE}\\|\\|${GRENZE}\\b4(?:00|22)\\b`
  + `|\\b4(?:00|22)\\b${GRENZE}\\|\\|${GRENZE}${MODELLTEXT})`,
  'g',
)

// Zwei Dateien duerfen die alte Form im Text tragen, beide mit Grund:
//  - das Modul selbst zitiert die drei alten Schreibweisen im Kopf, damit die
//    Fundstelle nachlesbar bleibt;
//  - diese Datei baut das Suchmuster.
const AUSNAHMEN = new Set([
  'hooks/codex/thinking-downgrade.ts',
  'hooks/codex/__tests__/ein-abstieg-eine-stelle.test.ts',
])

function alleQuellen(dir: string, out: string[] = []): string[] {
  for (const eintrag of readdirSync(dir)) {
    if (eintrag === 'node_modules') continue
    const pfad = join(dir, eintrag)
    if (statSync(pfad).isDirectory()) { alleQuellen(pfad, out); continue }
    if (/\.tsx?$/.test(pfad)) out.push(pfad)
  }
  return out
}

describe('repo-weit: die Fehlerform steht nirgends mehr ausgeschrieben', () => {
  const quellen = alleQuellen(srcWurzel)

  it('src/ ist ueberhaupt eingelesen — ein leerer Lauf waere still gruen', () => {
    // Ein verrutschter Wurzelpfad haette 0 Dateien und damit 0 Kopien gemeldet.
    expect(quellen.length).toBeGreaterThan(300)
    expect(quellen.some((p) => p.endsWith('useAgentChat.ts'))).toBe(true)
    expect(quellen.some((p) => p.endsWith('useChat.ts'))).toBe(true)
  })

  it('das Muster erkennt beide alten Schreibweisen — sonst zaehlt es nichts', () => {
    // Gegenprobe am echten Vorher-Text, in beiden Operandenreihenfolgen.
    expect("(errorText(e).includes('does not support thinking') || httpStatusOf(e) === 400)")
      .toMatch(FEHLERFORM)
    expect("(httpStatusOf(e) === 400 || errorText(e).includes('does not support thinking'))")
      .toMatch(FEHLERFORM)
    expect("(errorText(err).includes('does not support thinking') || status === 400 || status === 422)")
      .toMatch(FEHLERFORM)
  })

  it('und laesst die drei blossen Erwaehnungen in Ruhe', () => {
    expect("title={canThink ? 'Thinking ON' : 'Model does not support thinking'}").not.toMatch(FEHLERFORM)
    expect("} else if (errorMsg.includes('does not support thinking')) {").not.toMatch(FEHLERFORM)
  })

  it('KEINE Kopie mehr, in keiner Datei unter src/ (vorher: 4)', () => {
    const funde = quellen
      .map((pfad) => ({ datei: relative(srcWurzel, pfad).replace(/\\/g, '/'), text: lies(pfad) }))
      .filter(({ datei }) => !AUSNAHMEN.has(datei))
      .flatMap(({ datei, text }) => (text.match(FEHLERFORM) ?? []).map((t) => `${datei}: ${t}`))

    // Die Meldung nennt die Fundstelle, damit der naechste Lauf nicht suchen
    // muss: wer hier auftaucht, ruft shouldDowngradeThinking() statt zu kopieren.
    expect(funde).toEqual([])
  })

  it('auch die halbe Frage wird im Betriebscode nirgends ausserhalb des Moduls gestellt', () => {
    // `isThinkingUnsupportedError` direkt aufzurufen umgeht die
    // Zusatzbedingung — dieselbe Luecke, nur mit Import statt Copy-Paste.
    //
    // Nur Betriebscode: Wachen DUERFEN den Namen nennen, sie tun es gerade, um
    // ihn zu verbieten (hooks/__tests__/agent-think-downgrade.test.ts fuehrt
    // ihn in einem `not.toContain`). Ein Zaehler, der das anschwaerzt, misst
    // sich selbst.
    const roh = quellen
      .map((pfad) => ({ datei: relative(srcWurzel, pfad).replace(/\\/g, '/'), text: lies(pfad) }))
      .filter(({ datei, text }) =>
        !datei.startsWith('hooks/codex/')
        && !datei.includes('__tests__/')
        && text.includes('isThinkingUnsupportedError'))
      .map(({ datei }) => datei)
    expect(roh).toEqual([])
  })
})

describe('repo-weit: wer absteigt, geht durch die eine Stelle', () => {
  const zaehlung = alleQuellen(srcWurzel)
    .map((pfad) => ({
      datei: relative(srcWurzel, pfad).replace(/\\/g, '/'),
      treffer: (lies(pfad).match(/shouldDowngradeThinking\(/g) ?? []).length,
    }))
    .filter(({ datei, treffer }) => treffer > 0 && !datei.includes('__tests__') && !datei.startsWith('hooks/codex/'))

  it('genau drei Dateien steigen ab, mit sieben Transporten', () => {
    // Diese Liste ist die Landkarte. Eine neue Zeile hier ist erlaubt, aber sie
    // muss ABSICHT sein: wer einen Transport dazunimmt, traegt ihn ein und
    // sieht dabei, dass es die siebte Stelle ist, die dieselbe Frage stellt.
    expect(Object.fromEntries(zaehlung.map((z) => [z.datei, z.treffer]))).toEqual({
      'hooks/useAgentChat.ts': 3,
      'hooks/useChat.ts': 1,
      'hooks/useCodex.ts': 3,
    })
  })
})

describe('useAgentChat.ts reicht jedem Zweig SEINE eigene Option herein', () => {
  const useAgentChat = lies(resolve(hier, '../../useAgentChat.ts'))
  const useChat = lies(resolve(hier, '../../useChat.ts'))

  it('die drei Zweige nennen drei verschiedene Optionsobjekte', () => {
    // Ein fest verdrahtetes `true` waere die Zusatzbedingung durch die
    // Hintertuer wieder abgewaehlt — genau der Fehler, den KF-21 behoben hat.
    expect(useAgentChat).toContain('shouldDowngradeThinking(chatOptions.thinking, thinkErr)')
    expect(useAgentChat).toContain('shouldDowngradeThinking(streamOpts.thinking, thinkErr)')
    expect(useAgentChat).toContain('shouldDowngradeThinking(hermesOpts.thinking, thinkErr)')
  })

  it('useChat.ts reicht den Wert, den es angefragt hat', () => {
    expect(useChat).toContain('shouldDowngradeThinking(useThinking, err)')
  })

  it('und keine der beiden stellt die Bedingung noch einmal davor', () => {
    for (const text of [useAgentChat, useChat]) {
      expect(text).not.toMatch(/thinking !== undefined\s*\n?\s*&&\s*shouldDowngradeThinking/)
    }
  })
})
