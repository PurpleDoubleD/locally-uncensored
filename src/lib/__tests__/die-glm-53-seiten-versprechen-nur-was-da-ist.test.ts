/**
 * Die drei GLM-5.3-Seiten auf locallyuncensored.com, gegen die App gelesen.
 *
 * Die Ankuendigung auf lu-labs.ai ging mit drei falschen Zusagen los, und ein
 * Test dort hat sie gefangen: der Effort-Knopf habe ueberall vier Stufen (die
 * meisten Modelle haben drei), Low sei die Voreinstellung (High ist es), und
 * die Desktop-App habe den Knopf schon (er kommt mit 2.6.8). Dieselben drei
 * Saetze standen wortgleich auf den drei statischen Seiten hier, nur hatte
 * diese Seite keinen Test. Das ist die Luecke, die dieser Test schliesst.
 *
 * Die deutsche Seite kam ausserdem ganz ohne Umlaute an, weil die Hausregel
 * fuer Commit-Texte in die Webseite durchgesickert war. Die beiden anderen
 * deutschen Seiten der Site schreiben normal, also wird das hier festgehalten.
 *
 * Gelesen wird die echte Datei, nicht eine Kopie: eine Korrekturrunde am Text
 * darf die Zusage nicht unbemerkt wieder aufweichen.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SEITEN = {
  en: 'run-glm-5-3-locally.html',
  de: 'glm-5-3-lokal-nutzen.html',
  ru: 'glm-5-3-lokalno.html',
} as const

function roh(datei: string): string {
  return readFileSync(join(process.cwd(), 'docs', 'blog', datei), 'utf8')
}

/** Sichtbarer Text, ohne Skript, Stil und Markup. */
function text(datei: string): string {
  return roh(datei)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
}

describe('was die Seiten ueber den Effort-Knopf sagen', () => {
  it('nennt die Web-App als das, was den Knopf heute hat, und 2.6.8 fuer den Desktop', () => {
    // Der teure Fehler: "die Apps haben jetzt einen Effort-Knopf" schickt
    // Leute in eine Desktop-App, in der es ihn noch nicht gibt.
    expect(text(SEITEN.en)).toMatch(/in the LU Labs Cloud web app today; on the desktop app it arrives with the next update, 2\.6\.8/)
    expect(text(SEITEN.de)).toMatch(/Web-App von LU Labs Cloud ist er heute schon da, in die Desktop-App kommt er mit dem nächsten Update 2\.6\.8/)
    expect(text(SEITEN.ru)).toMatch(/веб-приложении LU Labs Cloud она уже есть, в настольное приложение придёт со следующим обновлением 2\.6\.8/)
  })

  it('sagt drei Stufen als Regel und Max als Ausnahme der beiden GLM-Modelle', () => {
    expect(text(SEITEN.en)).toMatch(/three settings, Low, Medium and High/)
    expect(text(SEITEN.en)).toMatch(/add a fourth above those, Max/)
    expect(text(SEITEN.de)).toMatch(/haben drei Stufen: Low, Medium und High/)
    expect(text(SEITEN.de)).toMatch(/darüber noch eine vierte, Max/)
    expect(text(SEITEN.ru)).toMatch(/три ступени: Low, Medium и High/)
    expect(text(SEITEN.ru)).toMatch(/сверху есть четвёртая, Max/)
  })

  it('nennt High als Startpunkt und verkauft Low als Ersparnis, nicht als Voreinstellung', () => {
    expect(text(SEITEN.en)).toMatch(/It starts on High\./)
    expect(text(SEITEN.en)).toMatch(/Low is the saving/)
    expect(text(SEITEN.en)).not.toMatch(/Low is the sensible default/)
    expect(text(SEITEN.de)).toMatch(/Er startet auf High\./)
    expect(text(SEITEN.de)).not.toMatch(/Low die vernünftige Voreinstellung/)
    expect(text(SEITEN.ru)).toMatch(/Стартует она на High\./)
    expect(text(SEITEN.ru)).not.toMatch(/Low это разумная настройка по умолчанию/)
  })
})

describe('Hausregeln auf den drei Seiten', () => {
  it('traegt nirgends einen Gedankenstrich', () => {
    // Beide Zeichen stehen als Codepunkt da: diese Datei ist die einzige im
    // Repo, die sie enthalten darf, und ein Sweep soll nicht hier anschlagen.
    for (const [sprache, datei] of Object.entries(SEITEN)) {
      const treffer = [...roh(datei)].filter((c) => c === '—' || c === '–')
      expect(treffer, `${treffer.length} Strich(e) auf ${sprache}`).toEqual([])
    }
  })

  it('schreibt die deutsche Seite mit Umlauten', () => {
    // Negativkontrolle im selben Test: die englische Seite hat keine, und das
    // ist richtig so. Nur die deutsche muss welche haben.
    const de = text(SEITEN.de)
    expect(de.match(/[äöüÄÖÜß]/g)?.length ?? 0).toBeGreaterThan(40)
    expect(de).not.toMatch(/\bfuer\b|\bueber\b|\bgroesse\b/i)
    expect(text(SEITEN.en).match(/[äöüÄÖÜß]/g)).toBeNull()
  })
})
