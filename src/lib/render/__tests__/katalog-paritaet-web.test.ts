/**
 * Der Notvorrat des Desktops gegen den Katalog des Webs.
 *
 * Zur Laufzeit ist /api/jobs/catalog die Wahrheit, CLOUD_MODEL_SEED ist nur
 * die Liste ohne Netz. Genau deshalb faellt ein Rueckstand hier nicht auf:
 * der Seed lag zehn Videomodelle hinter dem Web, ohne dass irgendetwas rot
 * wurde. Dieser Waechter haelt die Zeilen, die beide Seiten fuehren, Wort fuer
 * Wort und Zahl fuer Zahl gegeneinander.
 *
 * Verglichen werden Ids, Reihenfolge und Beschriftungen der klassischen Liste
 * (ohne `ops`), die Beschriftung jedes Sonderendpunkts, dazu bei den offenen
 * Videomodellen die Flags und der Preis aus der Tabelle des Webs. Eine
 * einzige Abweichung ist gewollt und hier beim Namen bekannt: das Wort der
 * Freigabe (siehe web-freigabe-wort.ts). Den Namen der App schickt das Web
 * seit dem 08.10.2026 selbst mit (`native_label`), und der Notvorrat muss ihm
 * gleichen. Die
 * fuenf alten Videomodelle fuehren im Seed bis heute keinen Preis, das ist
 * Altbestand und nicht Gegenstand dieses Laufs.
 *
 * Ohne LU_WEB_REPO wird uebersprungen, mit einer Zeile auf stderr. Ein
 * gesetzter Pfad, der kein Web-Checkout ist, laesst den Lauf scheitern.
 *
 * Run: LU_WEB_REPO=/pfad/zum/web npx vitest run \
 *   src/lib/render/__tests__/katalog-paritaet-web.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CLOUD_MODEL_SEED } from '../cloud-models'
import { CREATE_PRESETS } from '../create-presets'
import { webCheckout } from '../../__tests__/web-checkout'
import { DESKTOP_WORT, WEB_PLATZHALTER, alsDesktop, gezeigt, webNamen, webWort } from './web-freigabe-wort'

// Nur LU_WEB_REPO sagt, wo das Web liegt. Frueher wurden Nachbarordner
// probiert, und ein stehen gebliebener (lu-300-web auf release/3.0.1) hielt
// den Waechter am Mac dauerhaft rot. Siehe web-checkout.ts.
const WEB = webCheckout('katalog-paritaet', ['apps/web/lib/render/cloud-models.ts', 'apps/web/lib/render/retired-models.ts', 'apps/web/lib/billing/credits.ts'])

/** Rechnet eine Zeile der Preistabelle in Credits um. */
const CREDIT_USD = 1e-5

/** Kommentare raus, Zeilenumbrueche weg: danach ist jede Zeile ein Objekt. */
function ohneKommentare(text: string): string {
  return text
    .split('\n')
    .map((z) => z.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
}

interface WebZeile {
  id: string
  label: string
  kind: string
  t2v?: boolean
  i2v?: boolean
  adult?: boolean
  ops?: boolean
  tier?: string
  weights?: string
}

/** Die Modelle, die das Web aus seinen Waehlern genommen hat (24.10.2026).
 *  Das Web fuehrt sie in CLOUD_MODELS_WITH_RETIRED weiter, aber nicht in
 *  CLOUD_MODELS, und der Server listet sie nicht mehr. Gelesen aus der Datei
 *  des Webs; der Desktop traegt dieselbe Datei (studio-snapshot.mjs). */
function webRetired(): Set<string> {
  const datei = readFileSync(resolve(WEB!, 'apps/web/lib/render/retired-models.ts'), 'utf8')
  const start = datei.indexOf('export const RETIRED_MEDIA_MODELS')
  const rumpf = ohneKommentare(datei.slice(start, datei.indexOf('\n}', start)))
  const ids = [...rumpf.matchAll(/(?:'([^']+)'|([\w.-]+)): \{ since:/g)].map((m) => m[1] ?? m[2])
  if (ids.length === 0) throw new Error('No retired models read from the web')
  return new Set(ids)
}

/** Die Eintraege aus CLOUD_MODELS des Webs, ohne TypeScript zu laden. Die
 *  Liste steht im Web als CLOUD_MODELS_WITH_RETIRED; CLOUD_MODELS ist sie ohne
 *  die zurueckgezogenen Modelle. */
function webKatalog(): WebZeile[] {
  const datei = readFileSync(resolve(WEB!, 'apps/web/lib/render/cloud-models.ts'), 'utf8')
  const start = datei.indexOf('export const CLOUD_MODELS')
  const retired = webRetired()
  const ende = datei.indexOf('\n]', start)
  // Das Web baut die Namen der offenen Modelle aus seiner einen Konstante.
  // Der Platzhalter wird mit dem Wort des Webs gefuellt; jeder andere
  // Platzhalter ist unbekannt und faellt laut um, statt Zeilen zu verlieren.
  const rumpf = ohneKommentare(datei.slice(start, ende)).split(WEB_PLATZHALTER).join(webWort(WEB!))
  if (rumpf.includes('${')) throw new Error('Unknown placeholder in a web catalogue name')
  const out: WebZeile[] = []
  for (const treffer of rumpf.matchAll(/\{[^{}]*\}/g)) {
    const roh = treffer[0]
    const id = /id: '([^']+)'/.exec(roh)?.[1]
    const label = /label: (['`])([^'`]+)\1/.exec(roh)?.[2]
    const kind = /kind: '([^']+)'/.exec(roh)?.[1]
    if (!id || !label || !kind || retired.has(id)) continue
    out.push({
      id,
      label,
      kind,
      t2v: /t2v: (true|false)/.exec(roh)?.[1] === 'true' ? true : /t2v: false/.test(roh) ? false : undefined,
      i2v: /i2v: (true|false)/.exec(roh)?.[1] === 'true' ? true : /i2v: false/.test(roh) ? false : undefined,
      adult: /adult: true/.test(roh),
      ops: /ops: \[/.test(roh),
      tier: /tier: '(\w+)'/.exec(roh)?.[1],
      weights: /weights: '([\w-]+)'/.exec(roh)?.[1],
    })
  }
  return out
}

/** Die Preistabelle des Webs, je Lauf. */
function webPreise(): Record<string, { base: number; long?: number; lora?: number }> {
  const datei = readFileSync(resolve(WEB!, 'apps/web/lib/billing/credits.ts'), 'utf8')
  const start = datei.indexOf('export const MEDIA_MODEL_USD')
  const ende = datei.indexOf('\n}', start)
  const rumpf = ohneKommentare(datei.slice(start, ende))
  const out: Record<string, { base: number; long?: number; lora?: number }> = {}
  for (const treffer of rumpf.matchAll(/'([^']+)': \{([^}]*)\}/g)) {
    const zahl = (feld: string) => {
      const m = new RegExp(`${feld}: ([0-9.]+)`).exec(treffer[2])
      return m ? Number(m[1]) : undefined
    }
    const base = zahl('base')
    if (base === undefined) continue
    out[treffer[1]] = { base, long: zahl('long'), lora: zahl('lora') }
  }
  return out
}

const credits = (usd: number) => Math.ceil(usd / CREDIT_USD)

/**
 * Das Markenwort der offenen Endpunkte. Entscheid vom 08.10.2026: die
 * frueheren Woerter stehen in keinem Namen mehr. Der Desktop sagt
 * "Uncensored", das Web auf der Zahlungsdomain sein neutrales Wort. Vierzehn
 * Katalogeintraege tragen es, die drei Bildmodelle und zehn Videomodelle am
 * Ende des Namens, der Fortsetzer in der Mitte.
 *
 * Verglichen wird weiter Zeichen fuer Zeichen, nach genau einem Tausch: das
 * Wort des Webs gegen das Wort des Desktops. Beide Woerter werden zusaetzlich
 * gegen den Entscheid geprueft, damit ein Rueckfall einer Seite nicht als
 * blosse Abweichung durchgeht, sondern benennt, welche Seite recht hat.
 */
const MARKENWORT = DESKTOP_WORT
const WEB_WORT = WEB ? webWort(WEB) : ''
/** Ein Name des Webs, wie ihn der Desktop fuehren muss. */
const erwartet = (webName: string) => alsDesktop(webName, WEB_WORT)


describe.skipIf(!WEB)('Katalogparitaet Desktop gegen Web', () => {
  const klassischWeb = () => webKatalog().filter((m) => !m.ops)
  const klassischSeed = CLOUD_MODEL_SEED.filter((m) => !m.ops)

  it('liest den Web-Katalog ueberhaupt', () => {
    // Positivkontrolle: ginge der Ausdruck ins Leere, waere jeder Vergleich
    // unten ein Vergleich zweier leerer Listen.
    expect(webKatalog().length).toBeGreaterThan(40)
    expect(Object.keys(webPreise()).length).toBeGreaterThan(30)
  })

  it('fuehrt dieselben Bildmodelle, in derselben Reihenfolge und mit denselben Namen', () => {
    const web = klassischWeb().filter((m) => m.kind === 'image')
    const seed = klassischSeed.filter((m) => m.kind === 'image')
    expect(seed.map((m) => m.id)).toEqual(web.map((m) => m.id))
    expect(seed.map((m) => m.label)).toEqual(web.map((m) => erwartet(m.label)))
  })

  it('fuehrt dieselben Videomodelle, in derselben Reihenfolge und mit denselben Namen', () => {
    const web = klassischWeb().filter((m) => m.kind === 'video')
    const seed = klassischSeed.filter((m) => m.kind === 'video')
    expect(seed.map((m) => m.id)).toEqual(web.map((m) => m.id))
    expect(seed.map((m) => m.label)).toEqual(web.map((m) => erwartet(m.label)))
  })

  it('GEWOLLTE ABWEICHUNG: nur das Wort der Freigabe unterscheidet die Namen, und nur bei den offenen Eintraegen', () => {
    expect(MARKENWORT).toBe('Uncensored')
    expect(WEB_WORT).not.toBe(MARKENWORT)
    expect(WEB_WORT).not.toMatch(/uncensored|spicy|adult/i)
    // Der Umfang ist der ganze Katalog: die klassischen Listen und alle
    // Sonderendpunkte.
    const alle = webKatalog()
    const web = alle
    // Das Wort steht im ganzen Web-Katalog nur bei offenen Eintraegen.
    for (const w of alle) if (w.label.includes(WEB_WORT)) expect(w.adult, w.id).toBe(true)
    // Positivkontrolle: das Web fuehrt das Wort ueberhaupt, sonst pruefte der
    // Rest dieses Falls eine leere Menge.
    const traeger = web.filter((m) => m.label.includes(WEB_WORT))
    expect(traeger.length).toBeGreaterThan(10)
    for (const w of traeger) expect(w.adult, w.id).toBe(true)
    // Keine Seite fuehrt das Wort der anderen.
    for (const w of alle) expect(w.label, w.id).not.toContain(MARKENWORT)
    for (const s of CLOUD_MODEL_SEED) expect(s.label, s.id).not.toContain(WEB_WORT)
    // Wo sich ein Name unterscheidet, ist es genau ein Traeger des Wortes, und
    // jeder Traeger unterscheidet sich um genau dieses Wort.
    const abweichend: string[] = []
    for (const w of web) {
      const s = CLOUD_MODEL_SEED.find((m) => m.id === w.id)
      if (!s) continue
      expect(s.label, w.id).toBe(erwartet(w.label))
      if (s.label !== w.label) abweichend.push(w.id)
    }
    expect(abweichend.sort()).toEqual(traeger.map((m) => m.id).filter((id) => CLOUD_MODEL_SEED.some((m) => m.id === id)).sort())
    expect(abweichend.length).toBe(traeger.length)
  })

  it('ZUSATZFELD: der Name der App ist das native_label des Webs, und der Name des Webs der der App mit getauschtem Wort', async () => {
    // Online uebernimmt die App die Namen vom Server. Der schickt neben
    // `label` den Namen fuer die App; fehlte das, zeigte die App nach einem
    // Web-Deploy das Wort des Webs. Geladen wird die Ableitung des Webs
    // selbst, also genau das, was die Katalogroute ins Feld schreibt.
    const namen = await webNamen(WEB!)
    expect(namen.DESKTOP_MARK_LABEL).toBe(MARKENWORT)
    const alle = webKatalog()
    const mitFeld = alle.filter((w) => namen.desktopName(w.label) !== null)
    // Positivkontrolle: das Feld gibt es ueberhaupt, und nur bei offenen Eintraegen.
    expect(mitFeld.length).toBeGreaterThan(10)
    for (const w of mitFeld) expect(w.adult, w.id).toBe(true)
    // Jeder Eintrag, den beide Seiten fuehren, klassisch wie Sonderendpunkt:
    let verglichen = 0
    for (const w of alle) {
      const s = CLOUD_MODEL_SEED.find((m) => m.id === w.id)
      if (!s) continue
      verglichen++
      // Name der App gleich Zusatzfeld (oder gleich label, wo keines kommt).
      expect(s.label, w.id).toBe(gezeigt(namen, w.label))
      // Name des Webs gleich Name der App mit getauschtem Wort.
      expect(w.label, w.id).toBe(namen.webName(s.label))
      expect(w.label, w.id).toBe(s.label.split(MARKENWORT).join(WEB_WORT))
    }
    // Jeder Eintrag des Notvorrats ist dabei gewesen.
    expect(verglichen).toBe(CLOUD_MODEL_SEED.length)
  })

  it('fuehrt dieselben Presets unter denselben Titeln, mit demselben einen Tausch', async () => {
    // Die Presets reisen ueber keine Route: jede Seite liefert ihre eigene
    // Liste mit. Umso mehr gilt die Regel hier: Titel der App gleich dem, was
    // das Web fuer die App ableitet, Titel des Webs gleich dem der App mit
    // getauschtem Wort.
    const namen = await webNamen(WEB!)
    const quelle = readFileSync(resolve(WEB!, 'apps/web/lib/render/create-presets.ts'), 'utf8')
    const web = [...quelle.matchAll(/\{id:'([^']+)',title:(['`])([^'`]+)\2/g)].map((m) => ({
      id: m[1],
      title: m[3].split(WEB_PLATZHALTER).join(WEB_WORT),
    }))
    expect(web.length).toBeGreaterThan(10)
    for (const w of web) expect(w.title, w.id).not.toContain('${')
    expect(CREATE_PRESETS.map((p) => p.id)).toEqual(web.map((w) => w.id))
    expect(CREATE_PRESETS.map((p) => p.title)).toEqual(web.map((w) => gezeigt(namen, w.title)))
    expect(web.map((w) => w.title)).toEqual(CREATE_PRESETS.map((p) => namen.webName(p.title)))
    const traeger = web.filter((w) => namen.desktopName(w.title) !== null)
    expect(traeger.map((w) => w.id).sort()).toEqual(['long-spicy-cut', 'spicy-anime', 'spicy-character'])
    for (const p of CREATE_PRESETS) expect(p.title, p.id).not.toContain(WEB_WORT)
  })

  it('beschriftet JEDEN Sonderendpunkt wie das Web, nicht nur die offenen', () => {
    // Alter Drift, 08.10.2026 behoben: latentsync und lipsync-2 hiessen hier
    // "resync a clip", im Web "re-sync a clip", und kein Waechter sah hin,
    // weil nur die klassischen Listen und die offenen Sonderendpunkte
    // verglichen wurden. Die Schreibweise des veroeffentlichten Desktops gilt.
    const sonder = webKatalog().filter((m) => m.ops)
    const gemeinsam = sonder.filter((w) => CLOUD_MODEL_SEED.some((m) => m.id === w.id))
    expect(gemeinsam.length).toBeGreaterThan(15)
    for (const w of gemeinsam) {
      const s = CLOUD_MODEL_SEED.find((m) => m.id === w.id)!
      expect(s.ops, w.id).toBeDefined()
      expect(s.label, w.id).toBe(erwartet(w.label))
    }
    for (const id of ['latentsync', 'lipsync-2']) {
      const s = CLOUD_MODEL_SEED.find((m) => m.id === id)!
      expect(s.label, id).toContain('(resync a clip)')
      expect(sonder.find((w) => w.id === id)?.label, id).toBe(s.label)
    }
    // Und jeder Sonderendpunkt des Notvorrats steht im Web.
    for (const s of CLOUD_MODEL_SEED.filter((m) => m.ops)) expect(sonder.find((w) => w.id === s.id), s.id).toBeDefined()
  })

  it('fuehrt Stufe und Herkunft jedes klassischen und spezialisierten Eintrags wie das Web', () => {
    // Seit 02.10.2026 sortieren und beschriften die Waehler danach. Der Notvorrat
    // ist die Liste ohne Netz und darf hier nicht von der Wahrheit abweichen.
    const web = webKatalog().filter((m) => m.tier !== undefined)
    expect(web.length).toBeGreaterThan(40)
    for (const w of web) {
      const s = CLOUD_MODEL_SEED.find((m) => m.id === w.id)
      if (!s) continue
      expect({ tier: s.tier, weights: s.weights }, w.id).toEqual({ tier: w.tier, weights: w.weights })
    }
    // Und jeder Eintrag des Notvorrats steht im Web, mit beiden Feldern.
    for (const s of CLOUD_MODEL_SEED) {
      const w = web.find((m) => m.id === s.id)
      expect(w, s.id).toBeDefined()
    }
  })

  it('traegt bei den erwachsenenfaehigen Endpunkten das entschiedene Markenwort', () => {
    // Der Vergleich darueber haengt am Web. Dieser Fall haengt am Entscheid:
    // zoege das Web auf "Open" zurueck, waere der Vergleich oben gruen zu
    // machen, indem der Desktop mitzieht. Hier steht, welche Seite recht hat.
    const offen = CLOUD_MODEL_SEED.filter((m) => m.id.includes('spicy'))
    expect(offen.length).toBeGreaterThan(0)
    for (const m of offen) {
      expect(m.label, m.id).toContain(MARKENWORT)
      expect(m.label, m.id).not.toMatch(/\bOpen\b/)
    }
  })

  it('gibt den offenen Videomodellen dieselben Faehigkeiten und denselben Preis', () => {
    const preise = webPreise()
    const offenWeb = klassischWeb().filter((m) => m.kind === 'video' && m.adult)
    expect(offenWeb.length).toBeGreaterThan(0)
    for (const w of offenWeb) {
      const s = CLOUD_MODEL_SEED.find((m) => m.id === w.id)
      expect(s, w.id).toBeDefined()
      expect(s!.t2v, w.id).toBe(false)
      expect(s!.i2v, w.id).toBe(true)
      expect(preise[w.id], w.id).toBeDefined()
      expect(s!.credits?.base, w.id).toBe(credits(preise[w.id].base))
      // Kein 8-Sekunden-Satz im Web, also auch keiner hier.
      expect(preise[w.id].long, w.id).toBeUndefined()
      expect(s!.credits?.long, w.id).toBeUndefined()
      expect(s!.clip, w.id).toEqual({ short: 5 })
    }
  })

  it('beschriftet die offenen Sonderendpunkte wie das Web', () => {
    // Die Endpunkte mit `ops` stehen in keiner klassischen Liste, aber sehr
    // wohl im Waehler ihrer Kategorie. Auch hier gilt der eine Tausch und
    // sonst nichts: der Fortsetzer traegt das Wort in der Mitte des Namens.
    const sonder = webKatalog().filter((m) => m.ops && m.id.includes('spicy'))
    expect(sonder.length).toBeGreaterThan(0)
    for (const w of sonder) {
      const s = CLOUD_MODEL_SEED.find((m) => m.id === w.id)
      expect(s, w.id).toBeDefined()
      expect(s!.label, w.id).toBe(erwartet(w.label))
      expect(s!.label, w.id).toContain(MARKENWORT)
      expect(w.label, w.id).toContain(WEB_WORT)
      expect(s!.ops, w.id).toBeDefined()
    }
  })

  it('rechnet den LoRA-Satz mit denselben Zahlen wie das Web, und nur dort', () => {
    const preise = webPreise()
    // Ein zurueckgezogenes Modell behaelt im Web seinen Preis (alte Laeufe),
    // steht aber in keinem Waehler und darum auch nicht im Notvorrat.
    const retired = webRetired()
    const webMitLora = Object.entries(preise).filter(([id, p]) => p.lora !== undefined && !retired.has(id))
    expect(webMitLora.length).toBeGreaterThan(0)
    for (const [id, p] of webMitLora) {
      const s = CLOUD_MODEL_SEED.find((m) => m.id === id)
      expect(s, id).toBeDefined()
      expect(s!.credits?.base, id).toBe(credits(p.base))
      expect(s!.credits?.lora, id).toBe(credits(p.lora!))
    }
    // Und in die andere Richtung: kein erfundener Satz im Seed.
    for (const m of CLOUD_MODEL_SEED) {
      if (m.credits?.lora === undefined) continue
      expect(preise[m.id]?.lora, m.id).toBeDefined()
      expect(m.credits.lora, m.id).toBe(credits(preise[m.id].lora!))
    }
  })

  it('kennt dieselben offenen Bildmodelle wie das Web', () => {
    // Der Desktop traegt die Marke nicht selbst (die Katalogroute liefert das
    // Feld nicht). Welche Bildmodelle offen sind, sagt also das Web, und der
    // Seed muss sie als klassische Bildmodelle fuehren.
    const offenBild = klassischWeb().filter((m) => m.kind === 'image' && m.adult)
    expect(offenBild.length).toBeGreaterThan(0)
    for (const w of offenBild) {
      const s = CLOUD_MODEL_SEED.find((m) => m.id === w.id)
      expect(s, w.id).toBeDefined()
      expect(s!.kind, w.id).toBe('image')
      expect(s!.ops, w.id).toBeUndefined()
      // Auch sie tragen das Markenwort, am Ende des Namens, jede Seite ihres.
      expect(s!.label.endsWith(` ${MARKENWORT}`), w.id).toBe(true)
      expect(w.label.endsWith(` ${WEB_WORT}`), w.id).toBe(true)
      expect(s!.label, w.id).not.toMatch(/\bOpen\b/)
    }
  })
})
