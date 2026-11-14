// Kundenfluss (MOBILE-ZIEL.md, Abschnitt 3, Punkt 3): ein fremder Mensch auf
// einem frisch installierten Geraet, vom ersten Start bis zum Wiederoeffnen.
// Das Drehbuch dazu, in Worten und mit dem, was die Persona je Schritt ansieht,
// steht in PERSONA-DREHBUCH.md. Schritt-Kennungen dort und hier sind dieselben.
//
// Jeder Bedienschritt ist ein echter Touch (f.tap, f.tippe). Der Testhaken
// window.__LU_TEST__ wird nur gelesen (Preset, Anmeldung), nie zum Bedienen benutzt.
//
// Aufruf:
//   PLATFORM=android LAUF_DIR=out/android/<zeit> FRISCH=1 node flows/kundenfluss.mjs
//
//   FRISCH=1           vorher App-Daten loeschen. Nur auf einem Geraet, das einem allein gehoert.
//   ALLOW_PAID=1       bezahlte Schritte ausfuehren: 1 Cloud-Chat, 1 Bild, 1 STT, 1 TTS.
//                      Nur wenn das Geraet schon angemeldet ist, sonst "nicht pruefbar".
//   ABMELDEN=1         am Ende wirklich abmelden und die Maske pruefen. Danach muss David neu anmelden.
//   OHNE_ZWEITES_MODELL=1   kein zweiter Download, der Schritt Modellwechsel ist dann "nicht pruefbar".
//   STORE_PRESET=open|play|appstore   was der Bau traegt, falls der Testhaken es nicht sagt.
//   AB=<schritt>, BIS=<schritt>       nur einen Ausschnitt laufen lassen (zum Nachstellen)
//
// Was dieser Fluss NIE tut: ein Passwort tippen, eine Anmeldung abschicken, ein
// Konto loeschen, eine Meldung absenden, eine Kopplung abschicken.

import { join } from 'node:path'
import { ablauf, starte, tid, NichtPruefbar } from './lib.mjs'
import { S } from './selektoren.mjs'
import { istHauptmodul, WURZEL } from '../lib/lauf.mjs'
import { legeDateiAb, entferneDatei, waehleDatei, nativesFensterOffen, schliesseNativ, tippeNativ, NativFehlt } from '../lib/nativ.mjs'
import { dokPortBelegt, dokPortSatz } from '../lib/dokport.mjs'

const MIN = 60 * 1000
const TESTDATEI = join(WURZEL, 'fixture', 'dateien', 'lu-test.txt')
const OHNE_ANMELDUNG = 'nicht pruefbar ohne Anmeldung: Auf dem Geraet ist keine angemeldete Sitzung. Kein Agent meldet an, das macht David.'

export const SCHRITTE = [
  'frisch', 'altersabfrage', 'onboarding-willkommen', 'startmodell-laden', 'onboarding-dokumente', 'onboarding-fertig',
  'erster-chat', 'anhang', 'chat-optionen', 'persona', 'dokument', 'memory', 'modellwechsel', 'agent',
  'einstellungen', 'sicherung', 'konto-maske', 'cloud-chat', 'bild', 'sprache-rein', 'sprache-raus',
  'remote', 'melden', 'konto-loeschen', 'abmelden', 'beenden-wiederoeffnen',
]

// Pruefung iOS Paket 15, F-R4: ein Lauf ab "erster-chat" auf einem Geraet, das den Fluss schon einmal lief,
// scheiterte an zwei Stellen. Die Erinnerung hatte einen festen Text, die App lehnt denselben Text zu Recht
// ab ("This memory is already saved."). Und der Modellwechsel suchte den Download-Knopf eines Modells, das
// schon da war. Beide Schritte sind jetzt wiederholbar; der Selbsttest Teil 0 spielt sie zweimal hintereinander.

/**
 * Der Name, unter dem ein Lauf die Testdatei ablegt: je Lauf und Zweck ein neuer. Pruefung iOS Paket 17,
 * D1-Rest: Der Fluss legte "lu-test.txt" direkt vor der Wahl erneut ab, ueberschrieb damit die Datei vom
 * letzten Lauf, und zweimal war sie beim ersten Lesen schon weg (2 von 26 mit Ueberschreiben, 0 von 39 mit
 * frischen Namen). Das loeste den Rest kuenstlich aus.
 */
export function testdateiName(lauf, zweck) {
  return `lu-test-${String(lauf).replace(/[^\w-]/g, '')}-${zweck}.txt`
}

/**
 * Den Schritt "dokument" laufen lassen, mit dem Blick auf den Port des Dokumentenmodells (F-R9). Haelt ein
 * fremdes Programm auf dem Mac den Port, steht das in der Notiz; scheitert der Schritt dann, ist er "nicht
 * pruefbar" mit diesem Grund statt "fehler" (Umgebung, kein App-Fund).
 */
export async function mitDokPort({ f, d, pruefe = dokPortBelegt }, fn) {
  const befund = await pruefe({ plattform: d.plattform }).catch(() => null)
  if (befund) f.notiz(dokPortSatz(befund))
  try {
    await fn()
  } catch (e) {
    if (befund && !(e instanceof NichtPruefbar)) f.nichtPruefbar(`${dokPortSatz(befund)} Der Schritt scheiterte mit: ${e.message}`)
    throw e
  }
  if (befund) f.notiz('Trotz belegtem Port gruen: die App ist auf einen freien Port ausgewichen (Runde 46)')
}

/** Titel und Text der Erinnerung dieses Laufs. Beide tragen die Kennung des Laufs, also legt jeder Lauf einen neuen Eintrag an. */
export function memoryEintrag(lauf) {
  return { titel: `Harness ${lauf}`, text: `The user prefers short answers. Harness run ${lauf}.` }
}

export async function schrittMemory({ f, d, ctx, einstellung }) {
  const { titel, text } = ctx.memory
  await einstellung(S.einstellungen.memory, S.memory.screen)
  await f.tap(S.memory.neu)
  await f.sieht(S.memory.detail)
  await f.tippe(S.memory.titel, titel)
  await f.tippe(S.memory.text, text)
  await f.tap(S.memory.speichern)
  await f.toast('memory-saved')
  if (!(await f.istDa(S.memory.screen))) await f.zurueck()
  await f.sieht(S.memory.liste)
  const da = await d.evalJs(`[...document.querySelectorAll('${S.memory.liste.sel}')].some((l) => l.innerText.includes(${JSON.stringify(titel)}))`)
  if (!da) throw new Error(`Der Eintrag "${titel}" steht nicht in der Liste`)
}

/**
 * Zweites Modell laden und im Chat wechseln. Ist es schon da (ein frueherer Lauf), wird nichts geladen;
 * laeuft sein Download noch, wird gewartet; ist es schon das Chatmodell, entfaellt "Use in chat".
 */
export async function schrittModellwechsel({ f, d, env, id, oeffneChat, sendeLokal, benachrichtigungFallsGefragt }) {
  if (env.OHNE_ZWEITES_MODELL === '1') f.nichtPruefbar('OHNE_ZWEITES_MODELL=1: Ohne zweites Modell auf dem Geraet gibt es nichts zu wechseln')
  await f.reiter('models')
  await f.sieht(S.modelle.screen)
  await f.tap(S.modelle.neu)
  await f.sieht(S.modelle.karte(id), 20000)
  const da = () => f.istDa(S.modelle.inKarte(id, S.modelle.istInstalliert))
  if (await da()) {
    f.notiz(`${id} war schon installiert (frueherer Lauf), kein Download`)
  } else {
    if (await f.istDa(S.modelle.inKarte(id, S.modelle.transfer))) {
      f.notiz(`Der Download von ${id} lief schon, es wird nur gewartet`)
    } else {
      await f.sieht(S.modelle.inKarte(id, S.modelle.laden))
      f.brauchtNativ('Der Download des zweiten Modells')
      await f.tapBewusst(S.modelle.inKarte(id, S.modelle.laden), 'zweitkleinstes Modell des Katalogs, genau ein Download, fuer den Modellwechsel')
      await d.sleep(800)
      if (await f.istDa(tid('m-dialog-mobile-data'))) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Rueckfrage "ueber Mobilfunk laden": am Testgeraet ja, kostet kein Geld')
      if (await f.istDa(S.modelle.knapp)) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Rueckfrage "passt knapp": am Testgeraet ja, es ist das zweitkleinste Modell')
      await benachrichtigungFallsGefragt()
    }
    const ende = Date.now() + 15 * MIN
    for (;;) {
      if (await da()) break
      if (await f.istDa(S.modelle.inKarte(id, S.modelle.fehler))) throw new Error(`Download gescheitert: "${(await f.text(S.modelle.inKarte(id, S.modelle.fehler))).slice(0, 200)}"`)
      if (Date.now() >= ende) throw new Error('Download nach 15 Minuten nicht fertig')
      await d.sleep(3000)
      if (!(await f.istDa(S.modelle.karte(id)))) await f.tap(S.modelle.installiert).catch(() => {})
    }
  }
  if (await f.istDa(S.modelle.inKarte(id, S.modelle.benutzen))) await f.tap(S.modelle.inKarte(id, S.modelle.benutzen))
  else f.notiz(`${id} war schon das Modell des Chats, "Use in chat" entfaellt`)
  await oeffneChat()
  const mit2 = await f.text(S.chat.modellChip)
  await sendeLokal('Reply with one word: ready')
  // Und zurueck ueber das Modell-Blatt, so wie ein Kunde wechselt.
  await f.tap(S.chat.optionen)
    await f.tap(S.optionen.modell)
  await f.sieht(S.modellBlatt.blatt)
  await f.tap(S.modellBlatt.lokal)
  const zeilen = await f.zahl(S.modellBlatt.zeileLokal)
  if (zeilen < 2) throw new Error(`Das Modell-Blatt zeigt ${zeilen} Modell(e) auf dem Handy, erwartet mindestens 2`)
  await f.tap(tid('m-chat-model-local', ':not([aria-checked="true"])'))
  await f.schliesse()
  const mit1 = await f.text(S.chat.modellChip)
  if (mit1 === mit2) throw new Error(`Der Modell-Chip zeigt nach dem Wechsel dasselbe: "${mit1}"`)
  await sendeLokal('Reply with one word: back')
  f.notiz(`Chip mit dem zweiten Modell: "${mit2}", nach dem Wechsel: "${mit1}"`)
}

export async function kundenfluss({ d, config, laufDir }, env = process.env) {
  const f = await ablauf('kundenfluss', { d, laufDir, config })
  const m = config.billigsteModelle
  const lauf = Date.now().toString(36)
  const ctx = { angemeldet: null, thema: null, lauf, memory: memoryEintrag(lauf), chats: 0 }
  const ab = env.AB ? SCHRITTE.indexOf(env.AB) : 0
  const bis = env.BIS ? SCHRITTE.indexOf(env.BIS) : SCHRITTE.length - 1
  if (ab < 0 || bis < 0) throw new Error(`AB und BIS muessen Schritte sein: ${SCHRITTE.join(', ')}`)
  const schritt = (id, titel, fn) => {
    const i = SCHRITTE.indexOf(id)
    if (i < 0) throw new Error(`Schritt ${id} fehlt in SCHRITTE`)
    return i >= ab && i <= bis ? f.schritt(id, titel, fn) : null
  }

  // ---------- Bausteine ----------

  // Wartet auf eine neue fertige Antwort. Bricht frueh ab, wenn die App einen Fehler zeigt.
  async function warteAntwort(vorher, timeoutMs) {
    const ende = Date.now() + timeoutMs
    for (;;) {
      if ((await f.zahl(S.chat.antwortFertig)) > vorher) return
      if (await f.istDa(S.chat.fehler)) throw new Error(`Die App zeigt einen Fehler statt einer Antwort: "${(await f.text(S.chat.fehler)).slice(0, 200)}"`)
      if (await f.istDa(S.chat.engineFehler)) throw new Error(`Engine-Fehler: "${(await f.text(S.chat.engineFehler)).slice(0, 200)}"`)
      if (Date.now() >= ende) throw new Error(`keine fertige Antwort nach ${Math.round(timeoutMs / 1000)} s`)
      await d.sleep(1000)
    }
  }

  async function sendeLokal(text, timeoutMs = 3 * MIN) {
    if (await f.istDa(S.chat.cloudChip)) throw new Error('Der Chat steht auf einem Cloud-Modell. Dieser Schritt sendet nur lokal.')
    const vorher = await f.zahl(S.chat.antwortFertig)
    await f.tippe(S.chat.eingabe, text)
    await f.sieht(S.chat.senden)
    f.brauchtNativ('Eine lokale Antwort (Engine und Modell)')
    // Senden ist gesperrt, weil es im Cloud-Modus Geld kostet. Hier lokal: geprueft und begruendet.
    await f.tapBewusst(S.chat.senden, 'lokales Modell gewaehlt, der Chat zeigt keinen Cloud-Chip', { kostenlosWeil: 'lokal' })
    await warteAntwort(vorher, timeoutMs)
    return await d.evalJs(`(() => { const a = [...document.querySelectorAll('${S.chat.antwortFertig.sel} ${S.chat.antwortText.sel}')]; return a.length ? a[a.length - 1].innerText : '' })()`)
  }

  // Das Preset des App Stores hat keine Umschaltung Handy/Remote auf der Chatliste: dann gibt es nur die Liste auf dem Handy.
  async function tippeHandy() {
    if (await f.istDa(S.chats.handy)) await f.tap(S.chats.handy)
  }

  // Oeffnet den zuletzt benutzten Chat auf dem Handy (oder einen neuen, wenn es keinen gibt).
  async function oeffneChat({ neu = false } = {}) {
    await f.reiter('chat')
    await tippeHandy()
    if (!neu && (await f.istDa(S.chats.oeffnen))) await f.tap(S.chats.oeffnen)
    else await f.tap(S.chats.neu)
    await f.sieht(S.chat.screen)
    await f.ruhig()
  }

  async function einstellung(zeile, screen) {
    await f.reiter('settings')
    await f.tap(zeile)
    await f.sieht(screen)
    await f.ruhig()
  }

  // Liest die Anmeldung: erst der Testhaken, sonst die Kontoseite.
  async function istAngemeldet() {
    if (ctx.angemeldet !== null) return ctx.angemeldet
    if (await f.hakenHat('zustand')) {
      const z = await f.haken('zustand').catch(() => null)
      // Version 2 des Hakens nennt den Zustand des Kontos als Wort (account), aeltere Fassungen gar nicht.
      if (z && typeof z.account === 'string' && z.account !== 'loading') return (ctx.angemeldet = z.account === 'signed-in')
      if (z && typeof z.signedIn === 'boolean') return (ctx.angemeldet = z.signedIn)
    }
    await einstellung(S.einstellungen.konto, S.konto.screen)
    await d.sleep(1500)
    ctx.angemeldet = await f.istDa(S.konto.angemeldet)
    return ctx.angemeldet
  }

  async function brauchtAnmeldung() {
    if (!(await istAngemeldet())) f.nichtPruefbar(OHNE_ANMELDUNG)
  }

  // Vor dem ersten Download fragt die App auf Android einmal nach Benachrichtigungen (F9). Der Fluss sagt "Not now":
  // Der Download laeuft trotzdem, und es erscheint kein Dialog des Systems, den der Lauf beantworten muesste.
  async function benachrichtigungFallsGefragt() {
    await d.sleep(600)
    if (await f.istDa(S.rueckfrage.benachrichtigung)) {
      await f.tap(S.rueckfrage.abbrechen)
      f.notiz('Frage nach Benachrichtigungen vor dem ersten Download gezeigt und mit "Not now" beantwortet')
    }
  }

  // Die Einwilligung "LU Cloud processes your content" kommt einmal vor dem ersten Senden an die Cloud.
  async function einwilligungFallsGefragt() {
    await d.sleep(800)
    if (await f.istDa(S.einwilligung.blatt)) {
      const text = await f.text(S.einwilligung.text)
      if (text.length < 40) throw new Error(`Einwilligung sagt zu wenig: "${text}"`)
      // Gesperrt (lib/sperre.mjs): Die Einwilligung bleibt nach dem Lauf stehen. Hier bewusst, der Schritt sendet danach an die Cloud.
      await f.tapBewusst(S.einwilligung.zustimmen, 'Einwilligung fuer LU Cloud: Der Kundenfluss sendet danach bewusst an die Cloud. Sie bleibt erteilt, widerrufen wird in Settings, Privacy')
      f.notiz('Einwilligung vor dem ersten Cloud-Aufruf gezeigt und angenommen. Sie bleibt nach dem Lauf erteilt (Settings, Privacy widerruft sie)')
    }
  }

  // ---------- 1 bis 6: Installation und Onboarding ----------

  await schritt('frisch', 'Frische Installation: erster Start', async () => {
    // Direkt nach dem Einspielen ist die Seite noch nicht aufgebaut: Die Lage hat dann
    // weder Route noch Altersabfrage (gesehen am iPhone SE 3, 09.10.2026). Erst warten.
    let l = await f.lage()
    for (let i = 0; i < 40 && !l.fatal && !l.alter && !l.route; i++) {
      await d.sleep(500)
      l = await f.lage()
    }
    if (l.fatal) throw new Error('Die App zeigt den Fehlerschirm (m-fatal-screen)')
    if (l.alter !== 'ask' && l.route !== '/welcome') {
      throw new Error(`Das ist kein erster Start: Die App steht auf ${l.route ?? 'keiner Route'} (${l.screen ?? l.alter}). Mit FRISCH=1 laufen lassen oder die App neu installieren.`)
    }
    f.notiz(env.FRISCH === '1' ? 'App-Daten vor dem Start geloescht (FRISCH=1)' : 'ohne FRISCH=1 gestartet, das Geraet war schon frisch')
  })

  await schritt('altersabfrage', 'Altersabfrage je Store-Preset', async () => {
    let preset = config.storePreset
    if (await f.hakenHat('zustand')) {
      const z = await f.haken('zustand').catch(() => null)
      preset = z?.storePreset ?? z?.preset ?? preset
    }
    const l = await f.lage()
    let gesehen
    if (l.alter === 'ask') {
      gesehen = 'frage'
      const frage = await f.text(S.alter.frage)
      if (!/18/.test(frage)) throw new Error(`Die Altersabfrage nennt die Grenze nicht: "${frage.slice(0, 120)}"`)
      await f.sieht(S.alter.nein)
      await f.tap(S.alter.ja)
      await f.sieht(S.onboarding.willkommen)
    } else if (l.alter) {
      throw new Error(`Das Geraet steht nicht auf der Altersfrage, sondern auf der Rueckfrage oder der Seite "LU is for adults" (data-age="${l.alter}"). App-Daten loeschen.`)
    } else {
      gesehen = 'keine'
      await f.sieht(S.onboarding.willkommen)
    }
    f.notiz(`Preset ${preset ?? 'unbekannt'}, Altersabfrage: ${gesehen}`)
    if (!preset) f.notiz('Welches Preset der Bau traegt, sagt weder der Testhaken noch STORE_PRESET. Die Erwartung ist nicht geprueft.')
    else {
      const soll = preset === 'open' ? 'keine' : 'frage'
      if (soll !== gesehen) throw new Error(`Preset ${preset} verlangt ${soll === 'frage' ? 'die Altersabfrage' : 'keine Altersabfrage'}, gesehen: ${gesehen}`)
    }
  })

  await schritt('onboarding-willkommen', 'Onboarding: Willkommen', async () => {
    await f.sieht(S.onboarding.willkommen)
    await f.sieht(S.onboarding.konto)
    await f.tap(S.onboarding.weiter)
    await f.sieht(S.onboarding.modellSeite)
    await f.sieht(S.onboarding.modellListe, 20000)
  })

  await schritt('startmodell-laden', `Startmodell laden (kleinstes: ${config.kleinstesModell})`, async () => {
    const id = config.kleinstesModell
    await f.sieht(S.onboarding.modellKarte(id), 20000)
    const empfohlen = await f.zahl(S.onboarding.modellEmpfohlen)
    f.notiz(`Die App empfiehlt ${empfohlen} Modell(e). Der Lauf nimmt bewusst das kleinste, um Datenvolumen zu sparen.`)
    await f.tap(S.onboarding.modellWahl(id))
    const status = await f.attribut(S.onboarding.modellKarte(id), 'data-state')
    if (status !== 'selected') throw new Error(`Die Karte ${id} ist nach dem Tipp nicht gewaehlt (data-state="${status}")`)
    // Runde 57: ein Lauf auf einem Geraet, das das Startmodell schon hat (ein frueherer Lauf ohne FRISCH, langsames Netz),
    // laedt nicht noch einmal. Die App sagt dann "<Modell> is installed." und bietet gleich "Continue".
    if (await f.istDa(S.onboarding.modellBereit)) {
      f.notiz(`${id} ist schon installiert, kein zweiter Download`)
      await f.tap(S.onboarding.weiter)
      await f.sieht(S.onboarding.dokumenteSeite)
      return
    }
    // Der Download kostet kein Geld, aber Datenvolumen und Platz. Deshalb gesperrt und hier freigegeben.
    await f.sieht(S.onboarding.modellLaden)
    f.brauchtNativ('Der Download des Startmodells')
    await f.tapBewusst(S.onboarding.modellLaden, 'kleinstes Modell des Katalogs, genau ein Download je Lauf')
    await benachrichtigungFallsGefragt()
    await f.sieht(S.onboarding.fortschritt, 30000)
    const ende = Date.now() + 15 * MIN
    for (;;) {
      if (await f.istDa(S.onboarding.modellBereit)) break
      if (await f.istDa(S.onboarding.fehler)) throw new Error(`Download gescheitert: "${(await f.text(S.onboarding.fehler)).slice(0, 200)}"`)
      if (Date.now() >= ende) throw new Error('Download nach 15 Minuten nicht fertig')
      await d.sleep(3000)
    }
    await f.tap(S.onboarding.weiter)
    await f.sieht(S.onboarding.dokumenteSeite)
  })

  // Nur Vorschau: Ohne Download geht "Continue" nicht auf. Die naechste Seite kommt ueber den Entwicklerschalter.
  if (f.vorschau) await d.launch({ schalter: { route: '/setup/documents' } })

  await schritt('onboarding-dokumente', 'Onboarding: Dokumenten-Chat anbieten, spaeter einrichten', async () => {
    await f.sieht(S.onboarding.dokumenteSeite)
    // Das Angebot muss da sein. Eingerichtet wird es im Schritt "dokument", dort wo der Kunde es braucht.
    await f.sieht(S.onboarding.dokumenteInstallieren)
    await f.tap(S.onboarding.ueberspringen)
    await f.sieht(S.onboarding.fertigSeite)
  })

  await schritt('onboarding-fertig', 'Onboarding: fertig, weiter in den Chat', async () => {
    const status = await f.attribut(S.onboarding.fertigStatus, 'data-state')
    f.notiz(`Abschlussseite meldet data-state="${status}"`)
    await f.tap(S.onboarding.fertig)
    await f.sieht(S.chat.screen, 15000)
    if (await f.istDa(S.chat.ohneModell)) f.brauchtNativ('Ein installiertes Modell')
    if (await f.istDa(S.chat.ohneModell)) throw new Error('Nach dem Onboarding sagt der Chat, es sei kein Modell installiert')
  })

  // Nur Vorschau: Dort gibt es keine Engine und keinen Download, das Onboarding kommt also nie
  // ans Ziel. Damit der Trockenlauf auch die Schritte danach durchgeht, beginnt die Shell hier
  // neu mit dem Entwicklerschalter onboarding=skip. Am Geraet gibt es diesen Weg nicht.
  if (f.vorschau && !(await f.lage()).route?.startsWith('/chat')) {
    d.schalter.onboarding = 'skip'
    await d.launch()
  }

  // ---------- 7 bis 14: lokal arbeiten ----------

  await schritt('erster-chat', 'Erster lokaler Chat', async () => {
    await f.sieht(S.chat.screen)
    const antwort = await sendeLokal('Say hello in five words.')
    if (!antwort.trim()) throw new Error('Die Antwort ist leer')
    f.notiz(`Antwort: "${antwort.trim().slice(0, 120)}"`)
    ctx.chats++
  })

  // Legt die Testdatei unter einem frischen Namen ab und nimmt sie nach dem Schritt wieder weg.
  async function mitTestdatei(zweck, fn) {
    const name = await legeDateiAb(d, TESTDATEI, { als: testdateiName(ctx.lauf, zweck) }).catch((e) => {
      if (e instanceof NativFehlt) f.nichtPruefbar(`nicht pruefbar in der Vorschau: ${e.message}`)
      throw e
    })
    try {
      await fn(name)
    } finally {
      await entferneDatei(d, name).catch(() => {})
    }
  }

  await schritt('anhang', 'Datei anhaengen und danach fragen', () => mitTestdatei('anhang', async (name) => {
    await oeffneChat()
    const vorher = typeof d.foreground === 'function' ? await d.foreground() : null
    await f.tap(S.chat.anhaengen)
    await f.sieht(S.anhangBlatt.blatt)
    await f.sieht(S.anhangBlatt.kamera)
    await f.sieht(S.anhangBlatt.fotos)
    await f.tap(S.anhangBlatt.datei)
    await d.sleep(1500)
    // iOS 26 zeigt nach dem Tipp erst ein Menue der WebView ("Photo Library", "Choose Files"), die Dateiauswahl
    // kommt erst nach dem zweiten Tipp. Das Menue zaehlt nicht als natives Fenster, also wird es hier bedient.
    let menue = null
    if (d.plattform === 'ios' && !(await nativesFensterOffen(d, vorher))) {
      for (const t of ['Choose Files', 'Dateien auswählen']) {
        try {
          await tippeNativ(d, t, { timeoutMs: 2500 })
          menue = t
          break
        } catch (e) {
          if (!(e instanceof NativFehlt)) throw e
        }
      }
      if (menue) {
        f.notiz(`Nach "File" kam erst das Menue der WebView, "${menue}" getippt (ein Tipp mehr fuer den Kunden)`)
        await d.sleep(1500)
      }
    }
    if (!menue && !(await nativesFensterOffen(d, vorher))) throw new Error('Nach "Choose file" ist keine Dateiauswahl des Systems erschienen')
    await waehleDatei(d, name)
    await f.sieht(S.chat.anhangChip, 20000)
    const antwort = await sendeLokal('What is the secret word in the attached file? Answer with the word only.', 4 * MIN)
    f.notiz(`Antwort: "${antwort.trim().slice(0, 160)}". Geheimwort HARLEKIN ${/harlekin/i.test(antwort) ? 'kommt vor' : 'kommt NICHT vor (bei einem sehr kleinen Modell moeglich, am Screenshot beurteilen)'}`)
  }))

  await schritt('chat-optionen', 'Chat-Optionen oeffnen, eine Unterseite, wieder schliessen', async () => {
    await oeffneChat()
    await f.tap(S.chat.optionen)
    await f.sieht(S.optionen.blatt)
    await f.sieht(S.optionen.agent)
    await f.sieht(S.optionen.kontext)
    await f.tap(S.optionen.sampling)
    await f.sieht(S.optionen.temperatur)
    await f.tap(S.blatt.zurueck)
    await f.sieht(S.optionen.sampling)
    await f.tap(S.optionen.fertig)
    await f.siehtNicht(S.optionen.blatt)
    await f.sieht(S.chat.eingabe)
  })

  await schritt('persona', 'Persona waehlen und damit chatten', async () => {
    await oeffneChat()
    await f.tap(S.chat.optionen)
    await f.sieht(S.optionen.blatt)
    await f.tap(S.optionen.persona)
    await f.sieht(S.optionen.personaListe)
    const zeile = S.optionen.personaWahl('coder')
    if ((await f.element(zeile)).deaktiviert) {
      // Personas sind global aus: Der Schalter auf dieser Seite schaltet sie ein.
      await f.tap(S.optionen.personaSchalter)
      await d.sleep(400)
    }
    await f.tap(zeile)
    const gewaehlt = await f.attribut(zeile, 'aria-checked')
    if (gewaehlt !== 'true') throw new Error(`Persona "coder" ist nach dem Tipp nicht gewaehlt (aria-checked="${gewaehlt}")`)
    await f.schliesse()
    const antwort = await sendeLokal('Who are you? One sentence.')
    f.notiz(`Antwort mit Persona: "${antwort.trim().slice(0, 160)}"`)
  })

  await schritt('dokument', 'Dokument in den Chat laden und befragen', () => mitDokPort({ f, d }, () => mitTestdatei('dokument', async (name) => {
    await oeffneChat()
    await f.tap(S.chat.menue)
    await f.sieht(S.chatMenue.blatt)
    await f.tap(S.chatMenue.dokumente)
    await f.sieht(S.dokumente.screen)
    if (await f.istDa(S.dokumente.installStart)) {
      await f.tapBewusst(S.dokumente.installStart, 'Dokumentenmodell (rund 80 MB), genau ein Download je Lauf, ohne ihn gibt es keinen Dokumenten-Chat')
      await benachrichtigungFallsGefragt()
      const ende = Date.now() + 10 * MIN
      while (await f.istDa(S.dokumente.installKarte)) {
        if (Date.now() >= ende) throw new Error('Dokumentenmodell nach 10 Minuten nicht installiert')
        await d.sleep(3000)
      }
    }
    const vorher = typeof d.foreground === 'function' ? await d.foreground() : null
    await f.tap(S.dokumente.hinzufuegen)
    // Unter Last braucht die Auswahl laenger als anderthalb Sekunden.
    let auswahlDa = false
    for (let i = 0; i < 10 && !auswahlDa; i++) {
      await d.sleep(1000)
      auswahlDa = await nativesFensterOffen(d, vorher)
    }
    if (!auswahlDa) throw new Error('Nach "Add document" ist keine Dateiauswahl des Systems erschienen')
    await waehleDatei(d, name)
    // Ohne Dokumentenmodell wartet die erste Datei, und die Karte "Install" erscheint erst jetzt.
    await d.sleep(2500)
    if (await f.istDa(S.dokumente.installStart)) {
      await f.tapBewusst(S.dokumente.installStart, 'Dokumentenmodell (rund 80 MB), genau ein Download je Lauf, die erste Datei wartet darauf')
      await benachrichtigungFallsGefragt()
      const ende = Date.now() + 10 * MIN
      while (await f.istDa(S.dokumente.installKarte)) {
        if (Date.now() >= ende) throw new Error('Dokumentenmodell nach 10 Minuten nicht installiert')
        await d.sleep(3000)
      }
    }
    await f.sieht(S.dokumente.zeile, 3 * MIN)
    if (await f.istDa(S.dokumente.gescheitert)) throw new Error('Das Dokument ist als gescheitert gelistet')
    await f.zurueck()
    await f.sieht(S.chat.screen)
    const antwort = await sendeLokal('According to the document, what are the opening hours?', 4 * MIN)
    f.notiz(`Antwort: "${antwort.trim().slice(0, 200)}". "nine to five" ${/nine|9/i.test(antwort) ? 'kommt vor' : 'kommt NICHT vor (am Screenshot beurteilen)'}`)
  })))

  await schritt('memory', 'Memory: Eintrag anlegen und wiederfinden', () => schrittMemory({ f, d, ctx, einstellung }))

  await schritt('modellwechsel', `Zweites Modell laden (${config.zweitesModell}) und im Chat wechseln`, () =>
    schrittModellwechsel({ f, d, env, id: config.zweitesModell, oeffneChat, sendeLokal, benachrichtigungFallsGefragt }),
  )

  await schritt('agent', 'Agent: ein Werkzeug benutzen', async () => {
    await oeffneChat()
    await f.tap(S.chat.optionen)
    await f.sieht(S.optionen.blatt)
    const agent = await f.element(S.optionen.agent)
    if (agent.deaktiviert) {
      const warum = (await f.istDa(S.optionen.ohneWerkzeuge)) ? await f.text(S.optionen.ohneWerkzeuge) : agent.name
      await f.schliesse()
      f.nichtPruefbar(`Die Modelle dieses Laufs koennen keine Werkzeuge (die kleinsten des Katalogs). Die App sagt: "${warum.slice(0, 160)}". Belegbar mit einem Modell ab qwen3-1.7b oder ueber Cloud.`)
    }
    if ((await f.attribut(S.optionen.agent, 'aria-checked')) !== 'true') await f.tap(S.optionen.agent)
    await f.schliesse()
    const vorher = await f.zahl(S.chat.antwortFertig)
    await f.tippe(S.chat.eingabe, 'What time is it right now? Use a tool.')
    await f.tapBewusst(S.chat.senden, 'lokales Modell gewaehlt, der Chat zeigt keinen Cloud-Chip', { kostenlosWeil: 'lokal' })
    // Der Agent fragt vor einem Werkzeug um Erlaubnis (Blatt approval). Der Kunde erlaubt es.
    const ende = Date.now() + 3 * MIN
    for (;;) {
      if (await f.istDa(S.agent.erlaubnisBlatt)) await f.tap(S.agent.erlauben)
      if (await f.istDa(S.agent.werkzeugAufruf)) break
      if ((await f.zahl(S.chat.antwortFertig)) > vorher) throw new Error('Die Antwort ist fertig, ohne dass ein Werkzeug gelaufen ist')
      if (Date.now() >= ende) throw new Error('kein Werkzeugaufruf nach 3 Minuten')
      await d.sleep(1500)
    }
    await warteAntwort(vorher, 3 * MIN)
  })

  // ---------- 15 bis 17: Einstellungen, Sicherung, Konto ----------

  await schritt('einstellungen', 'Einstellungen: Design umstellen', async () => {
    await einstellung(S.einstellungen.design, S.aussehen.screen)
    const klasse = () => d.evalJs(`document.documentElement.classList.contains('light') ? 'light' : document.documentElement.classList.contains('dark') ? 'dark' : 'keine'`)
    await f.tap(S.aussehen.hell)
    await d.sleep(500)
    if ((await klasse()) !== 'light') throw new Error(`Nach "Light" traegt die Seite das Thema "${await klasse()}"`)
    await f.tap(S.aussehen.dunkel)
    await d.sleep(500)
    if ((await klasse()) !== 'dark') throw new Error(`Nach "Dark" traegt die Seite das Thema "${await klasse()}"`)
    await f.tap(S.aussehen.hell)
    await d.sleep(500)
    ctx.thema = 'light'
    await f.zurueck()
    await f.sieht(S.einstellungen.screen)
  })

  await schritt('sicherung', 'Sicherung anlegen', async () => {
    await einstellung(S.einstellungen.daten, S.daten.screen)
    await f.sieht(S.daten.wiederherstellen)
    const vorher = typeof d.foreground === 'function' ? await d.foreground() : null
    // Die Zeile heisst "Share backup", darunter steht "Send the file to another app". Das Wort "send" sperrt der
    // Rahmen nach Namen. Hier wird nichts verschickt und nichts bezahlt: Es oeffnet das Teilen-Blatt des Geraets.
    await f.tapBewusst(S.daten.sichern, 'Sicherung teilen oeffnet nur das Teilen-Blatt des Geraets, der Lauf schliesst es wieder')
    await d.sleep(2000)
    if (await nativesFensterOffen(d, vorher)) {
      f.notiz('Das Teilen-Blatt des Systems ist erschienen (dort waehlt der Kunde das Ziel). Der Lauf schliesst es wieder.')
      await schliesseNativ(d, vorher)
      return
    }
    const l = await f.lage()
    const t = l.toast.map((x) => x.id)
    if (t.includes('m-toast-backup-failed')) throw new Error(`Sicherung gescheitert: "${l.toast[0]?.text}"`)
    if (t.includes('m-toast-backup-none') && !ctx.chats) {
      f.notiz('Die App sagt, es gebe nichts zu sichern. Das stimmt: In diesem Lauf ist kein Chat mit Antwort entstanden.')
      return
    }
    if (t.includes('m-toast-backup-none')) throw new Error('Die App sagt, es gebe nichts zu sichern, obwohl dieser Lauf Chats angelegt hat')
    // Nach dem Teilen-Blatt gibt es keinen Toast mehr (N14), der Satz auf der Seite sagt, was geschah.
    if (await f.istDa(S.daten.sichernHinweis)) {
      f.notiz('Die Seite sagt nach dem Teilen, wohin die Datei ging.')
      return
    }
    if (!t.includes('m-toast-backup-done') && !t.includes('m-toast-backup-cancelled')) throw new Error(`Nach "Back up" weder Teilen-Blatt noch Rueckmeldung (Toasts: ${t.join(', ') || 'keine'})`)
    f.notiz(`Rueckmeldung: ${l.toast.map((x) => x.text).join(' / ')}`)
  })

  await schritt('konto-maske', 'Konto: Anmeldemaske bzw. angemeldete Sitzung ansehen', async () => {
    await einstellung(S.einstellungen.konto, S.konto.screen)
    await d.sleep(1500)
    ctx.angemeldet = await f.istDa(S.konto.angemeldet)
    if (ctx.angemeldet) {
      await f.sieht(S.konto.abmelden)
      await f.sieht(S.konto.loeschen)
      f.notiz(`Angemeldet. Plan laut Seite: "${(await f.text(S.konto.plan).catch(() => '')).slice(0, 80)}". Abmelden ist zu sehen und wird hier nicht ausgeloest (ABMELDEN=1 tut es am Ende).`)
      return
    }
    // Nicht angemeldet: bis zur Maske, nicht weiter. Kein Feld wird ausgefuellt, nichts abgeschickt.
    await f.sieht(S.konto.email)
    await f.sieht(S.konto.passwort)
    await f.sieht(S.konto.anmelden)
    await f.sieht(S.konto.vergessen)
    await f.tap(S.konto.modusRegistrieren)
    await f.sieht(S.konto.passwort)
    await f.tap(S.konto.modusAnmelden)
    if ((await f.wert(S.konto.passwort)) !== '' || (await f.wert(S.konto.email)) !== '') throw new Error('In der Anmeldemaske steht etwas, das dieser Lauf nicht getippt hat')
    f.notiz('Nicht angemeldet. Die Maske ist da, kein Feld ausgefuellt, nichts abgeschickt. Die Cloud-Schritte sind damit nicht pruefbar.')
  })

  // ---------- 18 bis 21: LU Cloud, nur angemeldet und nur ueber den Kostenwaechter ----------

  await schritt('cloud-chat', 'Ueber LU Cloud chatten (billigstes Modell, eine Nachricht)', async () => {
    await brauchtAnmeldung()
    await oeffneChat({ neu: true })
    await f.tap(S.chat.optionen)
    await f.tap(S.optionen.modell)
    await f.sieht(S.modellBlatt.blatt)
    await f.tap(S.modellBlatt.cloud)
    if (await f.istDa(S.modellBlatt.planNoetig)) {
      await f.schliesse()
      f.nichtPruefbar('Die Sitzung ist angemeldet, hat aber keinen Plan mit Cloud-Modellen')
    }
    await f.sieht(S.modellBlatt.zeileCloudBillig, 20000)
    const modell = await f.attribut(S.modellBlatt.zeileCloudBillig, 'data-m-id')
    await f.tap(S.modellBlatt.zeileCloudBillig)
    await d.sleep(600)
    if (await f.istDa(tid('m-dialog-cloud-switch'))) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Rueckfrage "Switch to Cloud?": Der Wechsel selbst kostet nichts, bezahlt wird erst das Senden')
    await f.schliesse()
    await f.sieht(S.chat.cloudChip)
    const vorher = await f.zahl(S.chat.antwortFertig)
    await f.tippe(S.chat.eingabe, 'Reply with the single word: ok')
    await f.tapBezahlt(S.chat.senden, 'chat', { modell: m.chat, zweck: `Kundenfluss Cloud-Chat, Zeile ${modell}` })
    await einwilligungFallsGefragt()
    await warteAntwort(vorher, 2 * MIN)
    f.notiz(`Cloud-Modell laut Zeile: ${modell}`)
  })

  await schritt('bild', 'Ein Bild erzeugen (flux-schnell, genau eines)', async () => {
    await brauchtAnmeldung()
    await f.reiter('create')
    await f.sieht(S.bild.screen)
    if (await f.istDa(S.bild.tor)) f.nichtPruefbar(`Create zeigt das Tor (data-state="${await f.attribut(S.bild.tor, 'data-state')}"): Die Sitzung hat keinen Zugang zu Create`)
    await f.tap(S.bild.einstellungen)
    await f.tap(S.bild.modell)
    await f.sieht(S.bild.modellBlatt)
    const zeile = tid('m-create-model-cheapest', '[data-m-id*="schnell"]')
    const andere = tid('m-create-model-row', '[data-m-id*="schnell"]')
    const ziel = (await f.istDa(zeile)) ? zeile : (await f.istDa(andere)) ? andere : null
    if (!ziel) {
      await f.schliesse()
      f.nichtPruefbar('Im Modell-Blatt von Create steht kein Modell mit "schnell" in der Kennung. Ohne flux-schnell erzeugt dieser Lauf kein Bild.')
    }
    const modell = await f.attribut(ziel, 'data-m-id')
    await f.tap(ziel)
    await f.schliesse()
    await f.tippe(S.bild.prompt, 'a red apple on a white table')
    const preis = (await f.istDa(S.bild.preis)) ? await f.text(S.bild.preis) : ''
    // Der Waechter prueft, dass die Kennung "flux" und "schnell" enthaelt. Sonst bricht der ganze Lauf ab.
    await f.tapBezahlt(S.bild.erzeugen, 'bild', { modell, zweck: `Kundenfluss Bild, Preis laut App: ${preis || 'nicht gezeigt'}` })
    await einwilligungFallsGefragt()
    const ende = Date.now() + 4 * MIN
    for (;;) {
      if (await f.istDa(S.bild.ergebnis)) break
      if (await f.istDa(S.bild.fehler)) throw new Error(`Create meldet: "${(await f.text(S.bild.fehler)).slice(0, 200)}"`)
      if (Date.now() >= ende) throw new Error('kein Bild nach 4 Minuten')
      await d.sleep(2000)
    }
    f.notiz(`Modell ${modell}, Preis laut App: ${preis || 'nicht gezeigt'}`)
  })

  await schritt('sprache-rein', 'Sprache rein: diktieren (einmal)', async () => {
    await brauchtAnmeldung()
    await oeffneChat()
    await f.sieht(S.chat.mikro)
    // Der erste Tipp startet die Aufnahme, der zweite schickt sie zur Umschrift. Gezaehlt wird beim ersten.
    await f.tapBezahlt(S.chat.mikro, 'stt', { modell: m.stt, zweck: 'Kundenfluss Diktat' })
    await d.sleep(1000)
    if (await f.istDa(S.stimme.torBlatt)) {
      await f.tap(S.stimme.torCloud)
      await einwilligungFallsGefragt()
      if (await f.istDa(tid('m-dialog-cloud-switch'))) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Diktat braucht LU Cloud, der Aufruf ist schon gezaehlt')
      await f.schliesse()
      await f.tapBewusst(S.chat.mikro, 'Aufnahme starten, der bezahlte Aufruf ist schon gezaehlt', { kostenlosWeil: 'schon-gezaehlt' })
    }
    await f.sieht(S.chat.diktat, 15000)
    await d.sleep(4000)
    await f.tapBewusst(S.chat.mikro, 'Aufnahme beenden, der bezahlte Aufruf ist schon gezaehlt', { kostenlosWeil: 'schon-gezaehlt' })
    await f.siehtNicht(S.chat.diktat, 30000)
    const text = await f.wert(S.chat.eingabe)
    f.notiz(text ? `Umschrift im Feld: "${text.slice(0, 120)}"` : 'Das Feld ist leer. Im Emulator kommt ohne eingespielten Ton nur Stille an, am Screenshot beurteilen.')
  })

  await schritt('sprache-raus', 'Sprache raus: eine Antwort vorlesen (einmal)', async () => {
    await brauchtAnmeldung()
    await oeffneChat()
    await f.sieht(S.chat.antwortFertig)
    await f.tapBezahlt(S.chat.vorlesen, 'tts', { modell: m.tts, zweck: 'Kundenfluss Vorlesen' })
    await d.sleep(800)
    if (await f.istDa(S.stimme.torBlatt)) {
      await f.tap(S.stimme.torCloud)
      await einwilligungFallsGefragt()
      await f.schliesse()
      await f.tapBewusst(S.chat.vorlesen, 'Vorlesen starten, der bezahlte Aufruf ist schon gezaehlt', { kostenlosWeil: 'schon-gezaehlt' })
    }
    await f.sieht(S.chat.vorlesenLaeuft, 30000)
    await f.tapBewusst(S.chat.vorlesenLaeuft, 'haelt das Vorlesen an, loest nichts Neues aus', { kostenlosWeil: 'schon-gezaehlt' })
  })

  // ---------- 22 bis 24: Remote, Melden, Konto loeschen ----------

  await schritt('remote', 'Remote: bis zur Kopplungsmaske', async () => {
    await f.reiter('chat')
    if (!(await f.istDa(S.chats.remote))) f.nichtPruefbar('Im Preset dieses Pakets gibt es keine Remote-Seite (Umschaltung Handy/Remote fehlt auf der Chatliste, Store-Regel)')
    await f.tap(S.chats.remote)
    await f.sieht(S.remote.start)
    await f.sieht(S.remote.einfuehrung)
    await f.tap(S.remote.hilfe)
    await f.sieht(S.remote.hilfeSeite)
    await f.zurueck()
    await f.tap(S.remote.eingeben)
    await f.sieht(S.remote.koppelSeite)
    await f.sieht(S.remote.adresse)
    await f.sieht(S.remote.code)
    await f.sieht(S.remote.koppeln)
    // Bis hierher und nicht weiter: Es wird keine Adresse getippt und nichts abgeschickt.
    if ((await f.wert(S.remote.adresse)) !== '') f.notiz(`Im Adressfeld steht schon "${await f.wert(S.remote.adresse)}" (gemerkter Desktop)`)
    await f.zurueck()
    await tippeHandy()
  })

  await schritt('melden', 'Eine Antwort melden: bis zum Blatt, nicht absenden', async () => {
    await oeffneChat()
    if (!(await f.istDa(S.chat.antwortFertig))) f.brauchtNativ('Eine Antwort, die man melden kann,')
    await f.sieht(S.chat.antwortFertig)
    await f.tap(S.chat.antwortMehr)
    await f.sieht(S.nachrichtBlatt.blatt)
    await f.tap(S.nachrichtBlatt.melden)
    await f.sieht(S.melden.blatt)
    await f.sieht(S.melden.gruende)
    if (!(await f.element(S.melden.senden)).deaktiviert) throw new Error('"Send report" ist ohne gewaehlten Grund schon bedienbar')
    await f.tap(S.melden.grund('other'))
    if ((await f.element(S.melden.senden)).deaktiviert) throw new Error('"Send report" bleibt nach der Wahl eines Grundes gesperrt')
    // Nicht absenden: Eine Testmeldung soll nicht beim Betreiber ankommen.
    await f.schliesse()
    await f.siehtNicht(S.melden.blatt)
  })

  await schritt('konto-loeschen', 'Konto loeschen: bis vor die Bestaetigung', async () => {
    await einstellung(S.einstellungen.konto, S.konto.screen)
    await d.sleep(1200)
    if (!(await f.istDa(S.konto.angemeldet))) {
      await f.sieht(S.konto.loeschenOhneAnmeldung)
      await f.sieht(S.konto.loeschenWebseite)
      f.nichtPruefbar(`Das Blatt "Delete account" ist ${OHNE_ANMELDUNG} Ohne Anmeldung zeigt die Kontoseite den Hinweis und den Weg ueber die Webseite: beides gesehen.`)
    }
    await f.tapBewusst(S.konto.loeschen, 'oeffnet nur das Blatt "Delete account". Der Knopf darin wird nicht getippt.')
    await f.sieht(S.kontoLoeschen.blatt)
    const text = await f.text(S.kontoLoeschen.erklaerung)
    if (text.length < 40) throw new Error(`Das Blatt erklaert nicht, was geloescht wird: "${text}"`)
    await f.sieht(S.kontoLoeschen.loeschen)
    // Hier ist Schluss. "Delete my account" wird nicht getippt.
    await f.tap(S.kontoLoeschen.behalten)
    await f.siehtNicht(S.kontoLoeschen.blatt)
    await f.sieht(S.konto.angemeldet)
  })

  await schritt('abmelden', 'Abmelden und die Maske sehen (nur mit ABMELDEN=1)', async () => {
    if (!(await istAngemeldet())) f.nichtPruefbar(`Abmelden ist ${OHNE_ANMELDUNG} Die Maske selbst ist im Schritt konto-maske belegt.`)
    if (env.ABMELDEN !== '1') f.mensch('Abmelden wuerde die Sitzung beenden, die David angelegt hat. Nur mit ABMELDEN=1, danach meldet David neu an.')
    await einstellung(S.einstellungen.konto, S.konto.screen)
    await f.tapBewusst(S.konto.abmelden, 'ABMELDEN=1: ausdruecklich gewuenscht, letzter Schritt vor dem Neustart')
    await d.sleep(800)
    if (await f.istDa(tid('m-dialog-signout-unsynced'))) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Rueckfrage beim Abmelden: ja, ABMELDEN=1')
    await f.toast('signed-out', 15000)
    await f.sieht(S.konto.email)
    await f.sieht(S.konto.passwort)
    ctx.angemeldet = false
  })

  // ---------- 26: beenden und wieder oeffnen ----------

  await schritt('beenden-wiederoeffnen', 'App hart beenden und wieder oeffnen: nichts ist weg', async () => {
    await f.reiter('chat')
    await tippeHandy()
    const vorher = await f.zahl(S.chats.zeile)
    if (!vorher) f.brauchtNativ('Ein Chat mit einer Antwort')
    if (!vorher) throw new Error('Vor dem Beenden steht kein Chat in der Liste, es gibt nichts zu vergleichen')
    await d.kill()
    await d.launch()
    await f.sieht(S.system.app, 30000)
    const l = await f.lage()
    if (l.route === '/welcome' || l.alter === 'ask') throw new Error('Nach dem Neustart beginnt die App wieder beim ersten Start: Onboarding oder Altersangabe sind nicht gespeichert')
    await f.reiter('chat')
    await tippeHandy()
    const nachher = await f.zahl(S.chats.zeile)
    if (nachher < vorher) throw new Error(`Chats verloren: vorher ${vorher}, nachher ${nachher}`)
    await f.tap(S.chats.oeffnen)
    await f.sieht(S.chat.antwortFertig, 15000)
    if (ctx.thema) {
      const jetzt = await d.evalJs(`document.documentElement.classList.contains('light') ? 'light' : 'dark'`)
      if (jetzt !== ctx.thema) throw new Error(`Das Design ist nach dem Neustart "${jetzt}", gewaehlt war "${ctx.thema}"`)
    }
    f.notiz(`${nachher} Chat(s) nach dem Neustart, Design ${ctx.thema ?? 'nicht geprueft'}`)
  })

  return f.ende()
}

if (istHauptmodul(import.meta.url)) {
  const k = await starte('kundenfluss')
  let e
  try {
    if (k.d.plattform === 'vorschau') {
      // Vorschau: ohne den Schalter onboarding=skip beginnt die Shell wie auf einem frischen Geraet.
      k.d.schalter.onboarding = process.env.FRISCH === '1' ? null : 'skip'
      if (process.env.STORE_PRESET && process.env.STORE_PRESET !== 'open') k.d.schalter.store = process.env.STORE_PRESET
      await k.d.connect()
    } else if (process.env.FRISCH !== '1') await k.d.connect({ pkg: k.config.pkg, urlFilter: k.config.urlFilter, start: true })
    if (process.env.FRISCH === '1') {
      await k.d.clearData()
      await k.d.launch()
    }
    e = await kundenfluss(k)
  } finally {
    await k.d.disconnect()
  }
  console.log(JSON.stringify(e.zahlen), e.abgebrochen ?? '', '\n' + k.laufDir)
  for (const s of e.schritte) console.log(String(s.nr).padStart(2), s.status.padEnd(14), s.id.padEnd(24), (s.grund ?? '').slice(0, 150))
}
