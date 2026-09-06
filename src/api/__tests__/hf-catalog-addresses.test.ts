/**
 * T-70, die Haelfte, die ohne Netz laeuft.
 *
 * Der Befund lautet: der Katalog haelt ueber hundert von Hand getippte
 * HuggingFace-Adressen, und nichts hat je nachgefragt, ob es die Dateien noch
 * gibt. Die Antwort dieses Zweigs ist bewusst KEINE Pruefung zur Laufzeit
 * (Begruendung steht im Kopf des Abschnitts "The catalog against reality" in
 * discover.ts), sondern ein Tor, das der Entwickler faehrt. Das Tor selbst
 * haengt am Netz und steht in `hf-catalog-addresses.live.test.ts`.
 *
 * Hier steht, was das Tor traegt und was ohne Netz beweisbar ist:
 *
 *   1. Das Tor kann nicht veralten. Jede fest getippte `/resolve/`-Adresse in
 *      discover.ts UND in model-bundles.ts muss durch `catalogAddresses()`
 *      erreichbar sein. Waere die Liste im Testordner von Hand gefuehrt, waere
 *      sie ein zweiter Katalog zum Vergessen — genau der Fehler aus T-67.
 *   2. "Ich konnte nicht fragen" ist nicht "die Antwort ist nein". Ein 429 darf
 *      das Tor nicht rot machen, ein 404 muss.
 *   3. Tor und Download-Pfad streiten nicht darueber, was "kaputt" heisst:
 *      beide lesen `PERMANENT_HTTP_STATUSES`.
 *
 * Lauf: npx vitest run src/api/__tests__/hf-catalog-addresses.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  catalogAddresses,
  classifyAddressProbe,
  isPermanentDownloadError,
  PERMANENT_HTTP_STATUSES,
  COMPONENT_REGISTRY,
} from '../discover'

const quelle = (datei: string) =>
  readFileSync(fileURLToPath(new URL(`../${datei}`, import.meta.url)), 'utf8')

/**
 * Alle fest getippten Download-Adressen aus dem Quelltext, direkt aus den
 * Zeichenketten gelesen.
 *
 * Zwei Schreibweisen, beide erfasst:
 *
 *   · die ausgeschriebene Adresse, wie sie in COMPONENT_REGISTRY und in den
 *     Buendeln steht;
 *   · der Aufruf `HF('repo', 'datei')`, mit dem der Text-Katalog seine
 *     Adressen baut. Ohne diesen zweiten Fall waere der gesamte Text-Katalog
 *     — und damit jeder Vision-Projektor — ausserhalb des Waechters, und
 *     genau dort steckte der 404, den das Tor am 01.09.2026 gefunden hat.
 *
 * `/resolve/` ist die Grenze mit Absicht: eine huggingface.co-Adresse OHNE
 * diesen Teil ist die Modellseite fuer den "mehr dazu"-Link, kein Download.
 * Uebrige Vorlagen mit `${...}` fallen raus — der Rumpf des `HF()`-Helfers
 * selbst und die beiden Adressen, die zur Laufzeit aus der HF-Baum-API gebaut
 * werden, sind keine getippten Konstanten, sondern Ergebnisse.
 */
function getippteAdressen(datei: string): string[] {
  const text = quelle(datei)
  const wortwoertlich = (text.match(/https:\/\/huggingface\.co\/[^'"`\s)]+/g) ?? [])
    .filter((u) => u.includes('/resolve/') && !u.includes('${'))
  const ueberHelfer = [...text.matchAll(/\bHF\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)]
    .map(([, repo, datei]) => `https://huggingface.co/${repo}/resolve/main/${datei}`)
  return [...new Set([...wortwoertlich, ...ueberHelfer])]
}

describe('T-70 · das Katalog-Tor kann nicht veralten', () => {
  it('jede getippte /resolve/-Adresse ist durch catalogAddresses() erreichbar', () => {
    const erfasst = new Set(catalogAddresses().map((a) => a.url))
    const uebersehen: string[] = []
    for (const datei of ['discover.ts', 'model-bundles.ts']) {
      for (const url of getippteAdressen(datei)) {
        if (!erfasst.has(url)) uebersehen.push(`${datei}: ${url}`)
      }
    }
    expect(
      uebersehen,
      `Diese Adressen stehen im Quelltext, aber das Tor sieht sie nicht:\n${uebersehen.join('\n')}`,
    ).toEqual([])
  })

  it('der Quelltext-Scan findet ueberhaupt etwas — sonst beweist der Test oben nichts', () => {
    // Ein Scan, der nichts findet, ist gruen und wertlos. Beide Dateien MUESSEN
    // getippte Adressen enthalten, sonst ist das Auslesen kaputt und nicht der
    // Katalog leer.
    expect(getippteAdressen('discover.ts').length).toBeGreaterThan(10)
    expect(getippteAdressen('model-bundles.ts').length).toBeGreaterThan(10)
  })

  it('die Komponenten-Adressen sind vollstaendig, Slot fuer Slot', () => {
    // COMPONENT_REGISTRY geht den Weg ueber die Komponenten-Vervollstaendigung
    // und steht in keinem Buendel.
    //
    // Geprueft wird die HERKUNFT, nicht nur die Adresse. Mehrere dieser Slots
    // nennen dieselbe Datei wie ein Buendel — `clip_l.safetensors` etwa —, und
    // dann bleibt die URL auch dann im Tor, wenn der Slot im Sammler fehlt.
    // Eine Pruefung auf die blosse URL waere also gruen geblieben, waehrend
    // die Fehlermeldung des Tores den Schuldigen nicht mehr haette nennen
    // koennen. Genau daran ist diese Zeile beim Sondieren aufgefallen.
    const nachHerkunft = new Set(catalogAddresses().flatMap((a) => a.where))
    const fehlend: string[] = []
    for (const [typ, req] of Object.entries(COMPONENT_REGISTRY)) {
      for (const [slot, spec] of [['vae', req.vae], ['clip', req.clip], ['clipSecondary', req.clipSecondary]] as const) {
        if (spec?.downloadUrl && !nachHerkunft.has(`COMPONENT_REGISTRY.${typ}.${slot}`)) fehlend.push(`${typ}.${slot}`)
      }
    }
    expect(fehlend, `Slots ohne Eintrag im Tor: ${fehlend.join(', ')}`).toEqual([])
  })

  it('geteilte Adressen nennen alle ihre Opfer, jeden genau einmal', () => {
    // Mehrere Modelltypen laden denselben grossen Text-Encoder — dieselbe
    // Wan-VAE steht in vier Buendeln. Faellt die Adresse aus, ist nicht ein
    // Eintrag kaputt, sondern jeder, der sie nennt; die Meldung muss sie alle
    // aufzaehlen koennen, ohne denselben Namen viermal zu wiederholen.
    const geteilt = catalogAddresses().filter((a) => a.where.length > 1)
    expect(geteilt.length).toBeGreaterThan(0)
    for (const a of geteilt) expect(new Set(a.where).size).toBe(a.where.length)
    // Und mindestens eine Adresse wird wirklich von zwei Quellen genannt:
    // COMPONENT_REGISTRY steht in keinem Buendel, taucht aber mit denselben
    // Text-Encodern auf. Ohne diese Zeile koennte der Sammler die halbe
    // Herkunft verlieren und der Test bliebe gruen.
    expect(geteilt.some((a) => a.where.some((w) => w.startsWith('COMPONENT_REGISTRY.'))
      && a.where.some((w) => !w.startsWith('COMPONENT_REGISTRY.')))).toBe(true)
  })

  it('jede Adresse hat eine Herkunft und ist eine https-Adresse', () => {
    for (const a of catalogAddresses()) {
      expect(a.where.length).toBeGreaterThan(0)
      expect(a.url.startsWith('https://')).toBe(true)
    }
  })
})

describe('T-70 · "konnte nicht fragen" ist nicht "die Antwort ist nein"', () => {
  it('eine tote Adresse heisst tot', () => {
    for (const s of PERMANENT_HTTP_STATUSES) expect(classifyAddressProbe(s)).toBe('dead')
  })

  it('ein Erfolg heisst erreichbar', () => {
    for (const s of [200, 206, 301, 302, 307]) expect(classifyAddressProbe(s)).toBe('reachable')
  })

  it('ein schlechter Moment beim Anbieter macht das Tor nicht rot', () => {
    // Genau hier liegt der Unterschied zum Groessen-Waechter nebenan, der jede
    // Nicht-OK-Antwort gleich behandelt (`if (echt === null) continue`) und
    // deshalb ueber einen 404 hinweggeht.
    for (const s of [0, 408, 429, 500, 502, 503, 504]) expect(classifyAddressProbe(s)).toBe('unclear')
  })

  it('kein Status wird stillschweigend zu "erreichbar"', () => {
    // Die eine Eigenschaft, an der alles haengt: was nicht als Erfolg
    // ankommt, darf das Tor nie gruen faerben.
    for (let s = 100; s < 600; s++) {
      if (s >= 200 && s < 400) continue
      expect(classifyAddressProbe(s), `HTTP ${s}`).not.toBe('reachable')
    }
  })
})

describe('T-70 · Tor und Download-Pfad meinen dasselbe mit "kaputt"', () => {
  it('was die Fehlermeldung dauerhaft nennt, nennt das Tor tot — und umgekehrt', () => {
    // Zwei Leser, eine Liste. Haette einer eine eigene Kopie, wuerde der Streit
    // still bleiben: das Tor liesse eine Adresse durch, die der Download-Pfad
    // als endgueltig tot behandelt.
    const uneins: number[] = []
    for (let s = 100; s < 600; s++) {
      const ausDerMeldung = isPermanentDownloadError(`ae.safetensors ist weg (HTTP ${s}).`)
      const ausDerProbe = classifyAddressProbe(s) === 'dead'
      if (ausDerMeldung !== ausDerProbe) uneins.push(s)
    }
    expect(uneins, `Uneinig bei: ${uneins.join(', ')}`).toEqual([])
  })
})
