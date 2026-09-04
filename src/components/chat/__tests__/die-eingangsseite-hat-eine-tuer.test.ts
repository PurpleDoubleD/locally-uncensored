/**
 * Die erste Flaeche der App — D-S02, D-S05, D-S06 und D-S18.
 *
 * Vier Befunde, eine Datei, weil sie sich alle auf dieselbe Frage beziehen:
 * was steht auf dem Bildschirm, bevor irgendetwas passiert ist, und was steht
 * ueber und unter dem Transkript, wenn etwas passiert?
 *
 *   D-S02  „Empty-State ohne Titel und CTA": 46px-Monogramm auf opacity-20
 *          plus bedingt „Select a model above." Kein Titel, keine Subline,
 *          kein Primaerbutton.
 *   D-S05  „1237x850px tote Flaeche" — derselbe Befund von der Seite der
 *          Flaeche gesehen.
 *   D-S06  „Zwei Kontextanzeigen 24px nebeneinander in verschiedener
 *          Notation" — „32/8.2k" und „ctx 8K".
 *   D-S18  „Drei Baender vor dem ersten Inhalt."
 *
 * Es gibt in diesem Projekt keine Render-Umgebung fuer Views (mehrere
 * bestehende Tests sagen das ausdruecklich und pruefen deshalb an der Quelle);
 * dieselbe Methode hier. Was am laufenden Fenster geprueft WURDE, steht im
 * Bericht — u. a. dass die zusammengelegte Kontextanzeige dort „117/16.4k"
 * zeigt und kein zweites „ctx 16K" daneben.
 *
 * Run: npx vitest run src/components/chat/__tests__/die-eingangsseite-hat-eine-tuer.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CHAT = resolve(__dirname, '..')
const read = (f: string) => readFileSync(resolve(CHAT, f), 'utf-8')

const VIEW = read('ChatView.tsx')
const CODEX = read('CodexView.tsx')
const DROPDOWN = read('ContextDropdown.tsx')

/** Ohne Kommentare — die Begruendungen NENNEN, was sie ersetzt haben. */
function ohneKommentare(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
}

const VIEW_CODE = ohneKommentare(VIEW)
const CODEX_CODE = ohneKommentare(CODEX)

describe('D-S02: die Eingangsseite sagt, wo man ist und was zu tun ist', () => {
  it('traegt eine Ueberschrift — vorher war der einzige Text bedingt und klein', () => {
    expect(VIEW_CODE).toMatch(/<h1 className="t-display[^"]*">[^<]+<\/h1>/)
  })

  it('die Ueberschrift steht auf der Typo-Leiter des Hauses, nicht auf einer eigenen Zahl', () => {
    // `t-display` ist --text-display. Ein `text-[…]` hier waere die 1018.
    // arbitraere Groesse der App (D-T04) statt einer der sechs Stufen.
    const h1 = VIEW_CODE.match(/<h1 className="([^"]*)"/)?.[1] ?? ''
    expect(h1).toContain('t-display')
    expect(h1).not.toMatch(/text-\[/)
  })

  it('und eine Subline, die aus dem Zustand kommt statt aus einer Bedingung im JSX', () => {
    expect(VIEW_CODE).toMatch(/\{landing\.subline\}/)
    expect(VIEW_CODE).toMatch(/const landing: Landing =/)
  })

  it('der Satz „Select a model above." ist weg — er zeigte in die falsche Richtung', () => {
    // Der Modellwaehler liegt seit 2026-07-11 IM Composer und oeffnet nach
    // oben; er steht also UNTER diesem Text, nicht darueber.
    // Im Code — der Kommentar an der Stelle NENNT den alten Satz.
    expect(VIEW_CODE).not.toContain('Select a model above')
    expect(VIEW_CODE).toContain('Pick a model in the box below')
  })

  it('der Primaerknopf steht genau dort, wo der Composer nicht weiterhilft', () => {
    // Kein Modell installiert: der Composer kann daran nichts aendern, die
    // Modellansicht schon. In jeder anderen Lage IST der Composer die
    // Primaeraktion und bekommt keinen zweiten Knopf daneben (bewusster
    // Widerspruch zum Audit, begruendet in ChatView.tsx).
    const install = VIEW_CODE.indexOf("cta: { label: 'Install a model'")
    expect(install).toBeGreaterThan(-1)
    const ctas = [...VIEW_CODE.matchAll(/cta: \{ label:/g)]
    expect(ctas).toHaveLength(1)
  })

  it('und er traegt das eine Primaer-Rezept, nicht ein eigenes', () => {
    expect(VIEW_CODE).toMatch(/onClick=\{landing\.cta\.run\}\s+className="lu-primary lu-control/)
  })

  it('im Cloud-Modus fuehrt er nirgendwohin und wird deshalb nicht gezeigt', () => {
    // Cloud versteckt die Modellansicht (lokale Hardware); ein Knopf dorthin
    // waere ein toter Klick — genau der Fall, den Sidebar.tsx:119 schon kennt.
    const start = VIEW_CODE.indexOf('const landing: Landing =')
    const branch = VIEW_CODE.slice(start, VIEW_CODE.indexOf('displayModelName(activeModel)', start))
    expect(branch).toMatch(/appMode === 'cloud'[\s\S]*cta: null/)
    // und der Knopf haengt am ANDEREN Zweig, nicht an diesem
    expect(branch).toMatch(/cta: \{ label: 'Install a model'/)
  })
})

describe('D-S02/D-A9: das Zeichen ist da und ist sichtbar', () => {
  it('Vektorfassung, nicht das 512px-PNG', () => {
    expect(VIEW_CODE).toContain('src={MONOGRAM}')
    expect(VIEW).not.toContain('LU-monogram-bw.png')
  })

  it('56px statt 46px, und nicht mehr auf opacity-20', () => {
    // opacity-20 auf einem Zeichen heisst: es ist da, aber es zaehlt nicht.
    expect(VIEW_CODE).toMatch(/width=\{56\}\s+height=\{56\}/)
    expect(VIEW_CODE).not.toMatch(/opacity-20/)
    expect(VIEW_CODE).toMatch(/opacity-90/)
  })
})

describe('D-S05: der Block haengt am Composer, nicht in der Mitte der Leere', () => {
  it('unten verankert statt zentriert', () => {
    const home = VIEW_CODE.slice(VIEW_CODE.indexOf('key="home"'), VIEW_CODE.indexOf('key="chat"'))
    expect(home).toContain('justify-end')
    expect(home).not.toContain('justify-center')
  })

  it('und liegt in derselben Spalte wie Transkript und Composer', () => {
    // --lu-measure ist die EINE Messgroesse (D-A1). Ein eigener max-w-Wert
    // hier waere die zweite Formel, die dieser Audit gerade beseitigt hat.
    const home = VIEW_CODE.slice(VIEW_CODE.indexOf('key="home"'), VIEW_CODE.indexOf('key="chat"'))
    expect(home).toContain('max-w-[var(--lu-measure)]')
  })
})

describe('D-S06: eine Kontextanzeige, nicht zwei', () => {
  it('der Fuellstand liegt IM Fensterwaehler, nicht daneben', () => {
    expect(VIEW_CODE).toContain('<ContextDropdown><TokenCounter /></ContextDropdown>')
    expect(CODEX_CODE).toContain('<ContextDropdown><TokenCounter /></ContextDropdown>')
  })

  it('keine Oberflaeche stellt die beiden nebeneinander', () => {
    for (const [name, code] of [['ChatView', VIEW_CODE], ['CodexView', CODEX_CODE]] as const) {
      // Ein selbststaendiges `<TokenCounter />` als Geschwister waere die alte
      // Doppelung. Erlaubt ist nur die geschachtelte Form.
      const solo = [...code.matchAll(/<TokenCounter \/>/g)].length
      const nested = [...code.matchAll(/<ContextDropdown><TokenCounter \/><\/ContextDropdown>/g)].length
      expect(solo, `${name}: TokenCounter-Vorkommen`).toBe(nested)
    }
  })

  it('der Knopf zeigt „ctx N" nur noch, wenn es keinen Fuellstand gibt', () => {
    expect(DROPDOWN).toMatch(/\{hasFill \? children : <span>ctx \{formatContextWindow\(ctx\.contextWindow\)\}<\/span>\}/)
  })

  it('und die beiden Schreibweisen koennen nicht gleichzeitig auf dem Schirm stehen', () => {
    // `hasFill` ist genau die Bedingung, unter der TokenCounter null liefert.
    // Faellt diese Zeile, stehen wieder zwei Zahlen nebeneinander.
    expect(DROPDOWN).toMatch(
      /const hasFill = useChatStore\(\s*\(s\) => \(s\.conversations\.find\(\(c\) => c\.id === s\.activeConversationId\)\?\.messages\.length \?\? 0\) > 0,/,
    )
    const counter = read('TokenCounter.tsx')
    expect(counter).toMatch(/if \(!activeConversationId \|\| messages\.length === 0\) return null/)
  })

  it('ein Cloud-Modell verliert seinen Fuellstand nicht, nur seinen Regler', () => {
    // Ohne diesen Zweig haette das Zusammenlegen den Fuellstand ueberall
    // mitgenommen, wo das Fenster nicht verstellbar ist.
    expect(DROPDOWN).toMatch(/if \(!activeModel \|\| !ctx\.adjustable\) return <>\{children\}<\/>/)
  })
})

describe('D-S18: was vor dem ersten Inhalt steht', () => {
  const strip = VIEW_CODE.indexOf('data-testid="chat-session-strip"')
  const list = VIEW_CODE.indexOf('<MessageList')
  const composer = VIEW_CODE.indexOf('<ChatInput')
  const plan = VIEW_CODE.indexOf('<PlanBar />')

  it('die Sitzungsleiste steht unter dem Transkript, nicht darueber', () => {
    expect(strip).toBeGreaterThan(-1)
    expect(list).toBeGreaterThan(-1)
    expect(strip).toBeGreaterThan(list)
  })

  it('und ueber dem Composer, bei den anderen Sitzungsanzeigen', () => {
    expect(composer).toBeGreaterThan(strip)
  })

  it('sie ist ein Geschwister der Promptbox, kein Inhalt darin', () => {
    // `composerAbove` rendert INNERHALB der Box (ChatInput.tsx:318). „Das
    // Promptfenster ist das Promptfenster" gilt auch fuer Statusanzeigen.
    const above = VIEW_CODE.slice(VIEW_CODE.indexOf('composerAbove={'))
    expect(above.slice(0, 200)).not.toContain('chat-session-strip')
  })

  it('der Plan bleibt oben — der ist das Einzige, was vor dem Inhalt gehoert', () => {
    expect(plan).toBeGreaterThan(-1)
    expect(list).toBeGreaterThan(plan)
    expect(VIEW_CODE.match(/<PlanBar\b/g)).toHaveLength(1)
  })
})
