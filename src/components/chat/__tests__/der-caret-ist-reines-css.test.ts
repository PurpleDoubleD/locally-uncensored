/**
 * Der Caret — und was sich an ihm ueberhaupt pruefen laesst.
 *
 * Audit §4, Befund 7: „Kein Caret-Element in `MessageBubble`/`MessageList`
 * (Screenshot 08 zeigt „PONG_BUILTIN_OK the bu" ohne Cursor) ... Das ist der
 * eine Moment, fuer den diese App existiert. Er hat keine Choreografie."
 * Bei der Re-Verifikation war das noch so: `isStreaming` existierte als Prop
 * und schaltete nur die Aktionsleiste ab, gerendert wurde nichts.
 *
 * EHRLICH ZUM GELTUNGSBEREICH. Diese Datei prueft NICHT, dass der Balken
 * sitzt. Ob er am Ende der letzten Zeile steht, ob 2px auf diesem Bildschirm
 * als Strich und nicht als Staubkorn lesbar sind, ob 300/300 ms sich neben
 * laufendem Text ruhig anfuehlen — das entscheidet ein Blick ins laufende
 * Fenster, und dieses Repo hat keinen Render-Harnisch (siehe den Kopf von
 * `long-transcripts-stay-cheap.test.ts`, gleiche Lage, gleiche Begruendung).
 *
 * Was sich pruefen LAESST, ist die eine Eigenschaft, an der dieser Posten
 * scheitern kann, ohne dass man es sieht: dass er nichts kostet. Der Balken
 * laeuft waehrend des Streamens, also bei JEDEM Token. Eine Loesung mit
 * `setInterval`, `useState` oder `requestAnimationFrame` wuerde die
 * teuerste Komponente der App zusaetzlich zum Tokenfluss takten — und man
 * saehe genau denselben blinkenden Strich. Deshalb steht hier, dass die
 * Bewegung in CSS liegt und in der Komponente kein Taktgeber dazukam.
 *
 * Run: npx vitest run src/components/chat/__tests__/der-caret-ist-reines-css.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrast, over } from '../../__tests__/wcag-contrast'

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf-8')

function ohneKommentare(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
}

const CSS = read('../../../index.css')
const BUBBLE = ohneKommentare(read('../MessageBubble.tsx'))
const LIST = ohneKommentare(read('../MessageList.tsx'))
const MARKDOWN = ohneKommentare(read('../MarkdownRenderer.tsx'))
const SHELL = ohneKommentare(read('../../layout/AppShell.tsx'))

/** Der `.lu-caret`-Block aus index.css. */
const REGEL = CSS.match(/^\.lu-caret [^{\n]*\{[^}]*\}/m)?.[0] ?? ''

describe('die Bewegung liegt in CSS, nicht in React', () => {
  it('es gibt eine Blink-Keyframe und eine Regel, die sie benutzt', () => {
    expect(CSS).toMatch(/@keyframes lu-caret-blink/)
    expect(REGEL).toMatch(/animation:\s*lu-caret-blink/)
  })

  it('der Balken haengt an einem Pseudoelement, nicht an einem eigenen Knoten', () => {
    // Das ist der Kern: ein `<span>`, das React pro Token neu einhaengt,
    // wuerde die Animation bei jedem Token neu starten. Ein ::after
    // gehoert React nicht und laeuft durch.
    expect(REGEL).toMatch(/::after\b/)
    expect(REGEL).toMatch(/content:\s*''/)
    expect(BUBBLE).not.toContain('lu-caret"')
    expect(BUBBLE).not.toMatch(/<span[^>]*lu-caret/)
  })

  it('die Komponente hat keinen Taktgeber dazubekommen', () => {
    // MessageBubble darf Timer haben (Loesch-Bestaetigung, Copy-Feedback),
    // aber keinen, der am Caret haengt — und keinen Animationsframe.
    expect(BUBBLE).not.toContain('setInterval')
    expect(BUBBLE).not.toContain('requestAnimationFrame')
    expect(BUBBLE).not.toMatch(/useState[^\n]*[Cc]aret/)
    expect(BUBBLE).not.toMatch(/useEffect[^\n]*[Cc]aret/)
    expect(LIST).not.toContain('setInterval')
  })

  it('die Klasse ist eine reine Funktion des vorhandenen isStreaming-Props', () => {
    // Kein neuer Store, kein neuer Prop, keine neue Subscription: der Wert
    // wird in MessageList schon berechnet und war schon da.
    expect(LIST).toMatch(/isStreaming=\{showTyping && message\.id === lastVisibleId/)
    const stellen = [...BUBBLE.matchAll(/isStreaming \? ' lu-caret' : ''|isStreaming && istSchluss \? ' lu-caret' : ''/g)]
    expect(stellen).toHaveLength(2)
  })

  it('und sie steht NUR waehrend des Streamens da', () => {
    // Ein Caret unter einer fertigen Antwort waere eine Falschaussage.
    for (const m of BUBBLE.matchAll(/lu-caret/g)) {
      const umfeld = BUBBLE.slice(Math.max(0, m.index - 60), m.index)
      expect(umfeld, 'lu-caret ohne isStreaming-Bedingung').toContain('isStreaming')
    }
  })
})

describe('der Anker, an dem der Balken haengt, existiert wirklich', () => {
  it('MarkdownRenderer setzt .markdown-content als Wurzel', () => {
    // Faellt diese Klasse weg, greift die Regel ins Leere und der Caret
    // verschwindet lautlos — deshalb steht sie hier festgenagelt.
    expect(MARKDOWN).toContain('className="markdown-content')
    expect(REGEL).toContain('.markdown-content')
  })

  it('er zielt auf den LETZTEN Block, also auf das Ende der letzten Zeile', () => {
    expect(REGEL).toMatch(/>\s*:last-child::after/)
  })

  it('beide Renderpfade der Antwort sind bedient', () => {
    // Normale Antwort (message.content) UND der letzte Antwortblock im
    // Agent-Modus, wo der Text nicht in content waechst.
    expect(BUBBLE).toMatch(/'text-\[0\.78rem\] leading-relaxed' \+ \(isStreaming \? ' lu-caret' : ''\)/)
    expect(BUBBLE).toMatch(/'text-\[0\.8rem\] leading-relaxed' \+ \(isStreaming && istSchluss \? ' lu-caret' : ''\)/)
    expect(BUBBLE).toMatch(/const istSchluss = gruppenIndex === gruppen\.length - 1/)
  })
})

describe('Geometrie und Takt kommen aus den vorhandenen Tokens', () => {
  it('2px breit, eine Zeilenhoehe hoch', () => {
    expect(REGEL).toMatch(/width:\s*2px/)
    // In em statt in px: der Balken steht in `text-[0.78rem]` auf einer
    // 18,4px-Wurzel, 1em ist dort 14,35px — die 14px, die der Audit nennt,
    // nur ohne die naechste Skalenaenderung zu verpassen.
    expect(REGEL).toMatch(/height:\s*1em/)
  })

  it('der Takt ist aus der Motion-Leiter gerechnet, keine fuenfte Zahl', () => {
    // Der Kommentar im Tokenblock sagt es selbst: „Vier Tokens, mehr
    // braucht die App nicht — wer eine fuenfte Dauer will, nimmt eine
    // dieser Stufen."
    expect(REGEL).toMatch(/calc\(var\(--motion-slow\) \* 2\)/)
    expect(CSS).toMatch(/--motion-slow:\s*300ms/)
  })

  it('„Bewegung reduzieren" haelt ihn an, ohne ihn zu loeschen', () => {
    // Der Balken IST die Auskunft „laeuft noch", sein Blinken ist Zierde.
    // Also faellt nur der Animationsname weg; `opacity: 1` aus der
    // Basisregel bleibt und der Balken steht sichtbar still.
    const reduce = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduce).toContain('.lu-caret .markdown-content > :last-child::after')
    const block = reduce.match(/\.lu-caret[^{]*\{[^}]*\}/)?.[0] ?? ''
    expect(block).toMatch(/animation-name:\s*none/)
    expect(block).not.toMatch(/display:\s*none/)
    // Die Keyframe faengt bei sichtbar an, nicht bei unsichtbar — sonst
    // stuende der Balken nach dem einen erlaubten Durchlauf auf 0.
    const keyframes = CSS.match(/@keyframes lu-caret-blink\s*\{[^}]*\}[^}]*\}/)?.[0] ?? ''
    expect(keyframes).toMatch(/0%,\s*49\.99%\s*\{\s*opacity:\s*1/)
  })
})

describe('die Farbe wird nicht neu erfunden, sondern geerbt', () => {
  it('der Balken traegt currentColor, fuehrt also keine neue Farbe ein', () => {
    expect(REGEL).toMatch(/background-color:\s*currentColor/)
  })

  it('und die geerbte Farbe traegt in beiden Modi weit ueber 3:1', () => {
    // `.markdown-content` ist `text-gray-800 dark:text-gray-200`; der Grund
    // ist die Chat-Flaeche aus AppShell. Beides aus den Dateien gelesen,
    // nicht angenommen.
    expect(MARKDOWN).toContain('markdown-content text-gray-800 dark:text-gray-200')
    const paneDark = SHELL.match(/dark:bg-\[(#[0-9a-fA-F]{6})\][^"]*ring-1/)?.[1]
    expect(paneDark).toBe('#1e1e1e')
    // WCAG 1.4.11 verlangt 3:1 fuer ein Nicht-Text-Signal dieser Art.
    expect(contrast('#e5e7eb', '#1e1e1e')).toBeGreaterThan(13)
    expect(contrast('#1f2937', '#ffffff')).toBeGreaterThan(14)
    // Und selbst halb durchsichtig ueber demselben Grund bliebe er drueber —
    // der Balken hat aber gar keine Deckungsangabe, das hier ist nur die
    // Reserve.
    expect(contrast(over('#e5e7eb', '#1e1e1e', 0.5), '#1e1e1e')).toBeGreaterThan(3)
  })
})
