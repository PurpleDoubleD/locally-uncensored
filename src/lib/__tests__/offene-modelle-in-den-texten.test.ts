// @vitest-environment jsdom
/**
 * Die Zahl der offenen Modelle, auf allen Flaechen dieselbe.
 *
 * Der Medienkatalog ist am 13.09.2026 von sechs auf zehn offene Videomodelle
 * gewachsen. Die Zahl stand als WORT auf drei Seiten in docs/ und einmal im
 * Was-ist-neu-Blatt, also an vier Stellen, die kein Waechter zusammenhielt:
 * `scripts/check-cloud-sales.mjs` zaehlt die Zeilen der Preistabelle, laeuft
 * aber nur von Hand und braucht einen zweiten Checkout. Ein ausgeschriebenes
 * Zahlwort kann nicht laut falsch sein, es steht einfach da, und genau so hat
 * es den Katalogumbau ueberlebt.
 *
 * Dieser Waechter laeuft bei jedem Commit und haelt die vier Stellen an
 * `CLOUD_PITCH.openVideoModels`.
 *
 * 22.09.2026, Entscheid des Inhabers: die Zaehlregel nimmt den Create-Studio-Katalog
 * auf. Gezaehlt wird jeder Katalogeintrag mit `adult: true` und der passenden
 * Gattung, auch der mit `ops: ['studio']`; heraus fallen die Werkzeuge, die
 * einen vorhandenen Clip fortsetzen, und die Studio-Zwillinge, die denselben
 * Endpunkt unter einem zweiten Namen fuehren. Aus zehn Videomodellen werden so
 * vierzehn und aus drei Bildmodellen sieben.
 *
 * Lauf: npx vitest run src/lib/__tests__/offene-modelle-in-den-texten.test.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLOUD_PITCH } from '../cloud-pitch'

const WURZEL = resolve(__dirname, '..', '..', '..')
const lies = (pfad: string) => readFileSync(resolve(WURZEL, pfad), 'utf8')
const SEITEN = ['docs/index.html', 'docs/cloud/index.html', 'docs/pricing/index.html'] as const

/**
 * Der CHANGELOG zaehlt mit, aber nur sein OBERSTER Abschnitt.
 *
 * Bis zum 22.09.2026 stand hier der 3.0.0-Abschnitt. Der ist eine Aussage zu
 * seinem Datum: am 13.09.2026 zaehlte der Katalog zehn, und wer das heute auf
 * vierzehn umschreibt, faelscht eine Versionsnotiz. Gehalten wird deshalb der
 * neueste Abschnitt, also der, in dem die heute gueltige Zahl steht. Aeltere
 * Abschnitte duerfen "six" und "ten" sagen, sie beschreiben aeltere Kataloge.
 *
 * Ein Kopf "## [Unreleased]" ist kein Versionsabschnitt: dort sammeln sich
 * einzelne Korrekturen bis zum naechsten Release, die Katalogzahl steht dort
 * nicht. Gehalten wird der oberste Abschnitt mit einer Versionsnummer.
 */
const CHANGELOG = 'CHANGELOG.md'
const neuesterAbschnitt = () => {
  const text = lies(CHANGELOG)
  const start = text.search(/\n## \[\d/)
  expect(start, 'im CHANGELOG fehlt jeder Versionsabschnitt').toBeGreaterThanOrEqual(0)
  const ende = text.indexOf('\n## [', start + 1)
  return ende === -1 ? text.slice(start) : text.slice(start, ende)
}
const ZAHLWORT: Record<number, string> = { 3: 'three', 6: 'six', 7: 'seven', 9: 'nine', 10: 'ten', 14: 'fourteen', 15: 'fifteen', 17: 'seventeen', 8: 'eight' }

/**
 * Die alte Aussage, an ihrer Form erkannt statt an einem festen Satz: ein
 * Zahlwort, das eine Gattung von Modellen zaehlt. "six seconds" und die
 * sechsstellige Kennzahl im Fernzugriff sind keine Modellzahlen.
 */
const nenntSechsModelle = (text: string) =>
  /\bsix\b[^.]{0,40}\b(?:video|image)(?:-to-video)?\s+(?:models|endpoints)/i.test(text)
  || /\bthese six\b/i.test(text)
  || /the six models/i.test(text)

const alsText = (html: string) =>
  new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''

/**
 * Die Ids, die ein Tabellenblock der Preisseite fuehrt, jede mit ihrem Preis
 * geprueft.
 *
 * DIE SPICY-REGEL UND IHRE AUSNAHME. Bis zum 22.09.2026 verlangte dieser
 * Waechter, dass jede Id der Videotabelle auf `spicy` endet. Die Regel war eine
 * Abkuerzung: im klassischen Katalog hiess jedes offene Videomodell so. Der
 * Create-Studio-Katalog fuehrt mit `open-video` und `open-video-lora` zwei
 * offene Endpunkte, die anders heissen. Sie tragen `adult: true` in derselben
 * Datei wie die zehn anderen und laufen ueber dieselbe Kontoeinstellung; die
 * Marke haengt seit acaa0c9d am Katalogfeld und nie am Namen. Die Ausnahme ist
 * deshalb NAMENTLICH und zaehlt genau diese zwei Ids auf, statt die Regel
 * still zu lockern: eine neue Zeile ohne "spicy" und ohne Eintrag hier faellt
 * weiter durch.
 *
 * Die Bildtabelle hatte diese Regel nie: `chroma`, `prefect-pony` und
 * `neta-lumina` heissen seit jeher ohne Zusatz.
 */
const OFFEN_OHNE_SPICY_IM_NAMEN = new Set(['open-video', 'open-video-lora', 'minimax-h3-singularity', 'minimax-h3-singularity-ref'])

const blatt = () => new DOMParser().parseFromString(lies('docs/pricing/index.html'), 'text/html')

const geprueftesTabellenblatt = (wahl: string, preisfeld: 'clipCredits' | 'imageCredits') => {
  const zeilen = [...blatt().querySelectorAll(wahl)]
  expect(zeilen.length, `${wahl} steht nicht auf der Preisseite`).toBeGreaterThan(0)
  return zeilen.map((zeile) => {
    const name = zeile.querySelector<HTMLElement>('[data-open-model-id]')
    expect(name, 'eine Zeile ohne Modellanker').toBeTruthy()
    const id = name!.dataset.openModelId!
    if (preisfeld === 'clipCredits' && !OFFEN_OHNE_SPICY_IM_NAMEN.has(id)) {
      expect(id, `${id} traegt kein spicy und steht in keiner Ausnahme`).toMatch(/spicy$/)
    }
    const preis = zeile.querySelector<HTMLElement>(`[data-${preisfeld === 'clipCredits' ? 'clip' : 'image'}-credits]`)
    expect(preis, `kein Preis fuer ${id}`).toBeTruthy()
    const credits = Number(preis!.dataset[preisfeld])
    expect(credits, `Preis 0 fuer ${id}`).toBeGreaterThan(0)
    // Der Leser sieht den Text, nicht das Attribut. Beide muessen stimmen.
    expect(preis!.textContent).toBe(credits.toLocaleString('en-US'))
    return id
  })
}

describe('die Zahl der offenen Modelle', () => {
  it('steht auf keiner Seite mehr als sechs', () => {
    for (const seite of SEITEN) {
      expect(nenntSechsModelle(alsText(lies(seite))), `${seite} zaehlt noch sechs`).toBe(false)
    }
    expect(nenntSechsModelle(neuesterAbschnitt()), `${CHANGELOG} zaehlt noch sechs`).toBe(false)
  })

  it('steht auf jeder Verkaufsflaeche als das gezaehlte Zahlwort', () => {
    const wort = ZAHLWORT[CLOUD_PITCH.openVideoModels]
    expect(wort, `fuer ${CLOUD_PITCH.openVideoModels} fehlt das Zahlwort`).toBeTruthy()
    for (const seite of SEITEN) {
      expect(alsText(lies(seite)), `${seite} nennt die offene Videozahl nicht`)
        .toMatch(new RegExp(`\\b${wort}\\b[^.]{0,40}\\b(?:video|image-to-video)`, 'i'))
    }
    expect(neuesterAbschnitt(), `${CHANGELOG} nennt die offene Videozahl nicht`)
      .toMatch(new RegExp(`\\b${wort}\\b[^.]{0,40}\\b(?:video|image-to-video)`, 'i'))
  })

  /**
   * Die Bildzahl stand bis zum 22.09.2026 auf denselben vier Flaechen, aber
   * ungehalten: nur die Videozahl hatte einen Waechter. Seit die Zaehlregel
   * beide Gattungen aus demselben Katalog holt, geht auch die Bildzahl bei
   * jedem Katalogumbau mit, und eine Flaeche, die sie vergisst, faellt hier.
   */
  it('und die Bildzahl ebenso', () => {
    const wort = ZAHLWORT[CLOUD_PITCH.openImageModels]
    expect(wort, `fuer ${CLOUD_PITCH.openImageModels} fehlt das Zahlwort`).toBeTruthy()
    for (const seite of SEITEN) {
      expect(alsText(lies(seite)), `${seite} nennt die offene Bildzahl nicht`)
        .toMatch(new RegExp(`\\b${wort}\\b[^.]{0,40}\\bimage`, 'i'))
    }
    expect(neuesterAbschnitt(), `${CHANGELOG} nennt die offene Bildzahl nicht`)
      .toMatch(new RegExp(`\\b${wort}\\b[^.]{0,40}\\bimage`, 'i'))
  })

  it('und die Preisseite fuehrt jede offene Videozeile genau einmal', () => {
    const ids = geprueftesTabellenblatt('[data-open-video-row]', 'clipCredits')
    expect(ids, 'die Preistabelle zaehlt anders als der Katalog')
      .toHaveLength(CLOUD_PITCH.openVideoModels)
    expect(new Set(ids).size, 'ein Modell steht zweimal in der Tabelle').toBe(ids.length)
  })

  it('und jede offene Bildzeile genau einmal', () => {
    const ids = geprueftesTabellenblatt('[data-open-image-row]', 'imageCredits')
    expect(ids, 'die Bildtabelle zaehlt anders als der Katalog')
      .toHaveLength(CLOUD_PITCH.openImageModels)
    expect(new Set(ids).size, 'ein Modell steht zweimal in der Tabelle').toBe(ids.length)
  })

  /**
   * DIE HERLEITUNG, und nicht nur die Summe.
   *
   * Die beiden Zahlen in `CLOUD_PITCH` sind getippt, weil der Katalog im
   * Web-Repo liegt (siehe den Kopf von `cloud-pitch.ts`). Eine getippte Zahl,
   * die nur gegen eine Zeilenzahl gehalten wird, laesst sich zu zweit falsch
   * machen: wer eine Zeile streicht und die Zahl mit, kommt durch. Dieser Test
   * rechnet deshalb die Herleitung nach, die im Kommentar steht: die
   * klassischen Zeilen plus genau die Zeilen, die auch im
   * Create-Studio-Abschnitt derselben Seite stehen, und zwar mit demselben
   * Preis. Der Studio-Abschnitt ist der Abzug des Studio-Katalogs auf dieser
   * Seite; er traegt `data-studio-model-id` und `data-studio-credits`.
   */
  it('rechnet beide Zahlen aus klassischen und Studio-Zeilen zusammen', () => {
    const seite = blatt()
    const studio = new Map(
      [...seite.querySelectorAll<HTMLElement>('[data-studio-model-id]')].map((name) => [
        name.dataset.studioModelId!,
        Number(name.closest('tr')!.querySelector<HTMLElement>('[data-studio-credits]')!.dataset.studioCredits),
      ]),
    )
    expect(studio.size, 'der Seite fehlt der Create-Studio-Abschnitt').toBeGreaterThan(0)

    const teile = (wahl: string, preisfeld: 'clipCredits' | 'imageCredits') => {
      let klassisch = 0
      let ausDemStudio = 0
      for (const zeile of seite.querySelectorAll<HTMLElement>(wahl)) {
        const id = zeile.querySelector<HTMLElement>('[data-open-model-id]')!.dataset.openModelId!
        const preis = Number(zeile.querySelector<HTMLElement>(`[data-${preisfeld === 'clipCredits' ? 'clip' : 'image'}-credits]`)!.dataset[preisfeld])
        if (studio.has(id)) {
          expect(studio.get(id), `${id} kostet im Studio-Abschnitt etwas anderes`).toBe(preis)
          ausDemStudio += 1
        } else {
          klassisch += 1
        }
      }
      return { klassisch, ausDemStudio }
    }

    // Die Herleitung aus dem Kommentar in cloud-pitch.ts, Zahl fuer Zahl.
    expect(teile('[data-open-video-row]', 'clipCredits')).toEqual({ klassisch: 11, ausDemStudio: 6 })
    expect(teile('[data-open-image-row]', 'imageCredits')).toEqual({ klassisch: 3, ausDemStudio: 5 })
    expect(CLOUD_PITCH.openVideoModels).toBe(11 + 6)
    expect(CLOUD_PITCH.openImageModels).toBe(3 + 5)
  })

  it('und das Blatt liest die Zahl, statt sie zu tippen', () => {
    const blatt = lies('src/lib/release-notes.ts')
    expect(blatt, 'das Blatt tippt die offene Videozahl').toContain(
      '${CLOUD_PITCH.openVideoModels} video models and ${CLOUD_PITCH.openImageModels} image models',
    )
    expect(nenntSechsModelle(blatt), 'das Blatt zaehlt noch sechs').toBe(false)
  })

  /**
   * NEGATIVKONTROLLE. Ohne sie waere dieser Waechter auch dann gruen, wenn er
   * gar nichts erkennt: die drei Seiten sagen "six" naemlich weiterhin, nur
   * nicht ueber Modelle.
   */
  it('erkennt die alte Aussage und verwechselt sie mit nichts', () => {
    expect(nenntSechsModelle('Six video models and three image models without a built-in restriction')).toBe(true)
    expect(nenntSechsModelle('Six image-to-video endpoints and three image models run without a restriction')).toBe(true)
    expect(nenntSechsModelle('there is no eight second option on these six.')).toBe(true)
    expect(nenntSechsModelle('Adult video: the six models and what a clip costs')).toBe(true)
    // Und die Stellen, die "six" aus einem anderen Grund sagen, bleiben in Ruhe.
    expect(nenntSechsModelle('It needs two clicks within six seconds.')).toBe(false)
    expect(nenntSechsModelle('The desktop panel displays a six-digit passcode.')).toBe(false)
    expect(nenntSechsModelle('Six Steps to a Flux 2 Dev Image')).toBe(false)
  })
})
