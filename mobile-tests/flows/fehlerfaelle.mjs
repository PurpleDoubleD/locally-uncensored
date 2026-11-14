// Die sieben Fehlerfaelle (MOBILE-ZIEL.md, Abschnitt 3, Punkt 4):
//
//   1 kein Netz, oder das Netz bricht mitten im Stream ab     kein-netz, kein-netz-cloud, netz-bricht-im-stream
//   2 Speicher voll                                           speicher-voll
//   3 Modell zu gross fuer das Geraet                         modell-zu-gross
//   4 Download abgebrochen                                    download-abgebrochen, download-app-abschuss
//   5 App im Hintergrund vom System beendet                   hintergrund-beendet, abschuss-in-der-antwort
//   6 Guthaben leer                                           guthaben-leer
//   7 Sitzung abgelaufen                                      sitzung-abgelaufen
//
// Je Fall dieselbe Erwartung: Die App bleibt bedienbar UND nennt den naechsten
// Schritt. Geprueft wird das mit erwarteHinweis (Meldung mit Text, dazu ein
// sichtbarer Knopf fuer den naechsten Schritt) und bleibtBedienbar (die Reiter
// reagieren noch, mit echten Tipps).
//
// Mittel: Netz, Abschuss und Hintergrund kommen vom Treiber (adb, simctl).
// Guthaben leer, Sitzung abgelaufen und ein zu kleines Geraet lassen sich von
// aussen nicht herstellen und brauchen den Testhaken window.__LU_TEST__
// (lib/haken.mjs). Fehlt er, ist der Schritt "offen". Speicher voll braucht
// einen wirklich vollen Speicher (SPEICHER_ECHT=1): Die Frage vor dem Download
// beantwortet die native Seite, der Haken erreicht sie nicht.
//
// Aufruf:  PLATFORM=android LAUF_DIR=<lauf> node flows/fehlerfaelle.mjs
//   NUR=kein-netz,modell-zu-gross     nur diese Schritte
//   ALLOW_PAID=1                      erlaubt die EINE Cloud-Nachricht fuer "Netz bricht im Stream"
//   SPEICHER_ECHT=1                   nur Android: fuellt den Speicher des Geraets wirklich (fallocate)
//                                     und raeumt danach auf. Nur auf einem Geraet, das einem allein gehoert.
//   SITZUNG_ABLAUFEN=1                erlaubt Fall 7. Danach muss David neu anmelden.
//
// Voraussetzung: Das Geraet hat das Onboarding hinter sich und ein lokales Modell (Kundenfluss davor).

import { ablauf, starte, tid } from './lib.mjs'
import { S } from './selektoren.mjs'
import { istHauptmodul } from '../lib/lauf.mjs'

const MIN = 60 * 1000
const OHNE_ANMELDUNG = 'nicht pruefbar ohne Anmeldung: Auf dem Geraet ist keine angemeldete Sitzung. Kein Agent meldet an, das macht David.'

export const FAELLE = [
  'kein-netz', 'kein-netz-cloud', 'netz-bricht-im-stream', 'speicher-voll', 'modell-zu-gross', 'download-abgebrochen',
  'download-app-abschuss', 'hintergrund-beendet', 'abschuss-in-der-antwort', 'guthaben-leer', 'sitzung-abgelaufen',
]

export async function fehlerfaelle({ d, config, laufDir }, env = process.env) {
  const f = await ablauf('fehlerfaelle', { d, laufDir, config })
  const m = config.billigsteModelle
  const nur = env.NUR ? env.NUR.split(',').map((s) => s.trim()) : null
  const schritt = (id, titel, fn) => {
    if (!FAELLE.includes(id)) throw new Error(`Fall ${id} fehlt in FAELLE`)
    return !nur || nur.includes(id) ? f.schritt(id, titel, fn) : null
  }
  // Das Modell, an dem die Download-Faelle spielen: eines, das der Kundenfluss nicht geladen hat.
  const fehlerModell = env.FEHLER_MODELL ?? 'qwen3.5-0.8b'

  // ---------- Bausteine ----------

  // Die Meldung ist zu sehen, sagt etwas, und es gibt einen Knopf fuer den naechsten Schritt.
  async function erwarteHinweis(meldung, aktion, timeoutMs = 15000) {
    await f.sieht(meldung, timeoutMs)
    const text = await f.text(meldung)
    if (text.length < 12) throw new Error(`Die Meldung sagt nichts: "${text}"`)
    if (aktion) {
      await f.sieht(aktion, 4000)
      const knopf = await f.element(aktion)
      if (knopf.deaktiviert) throw new Error(`Der naechste Schritt "${knopf.name}" ist gesperrt`)
      f.notiz(`Meldung: "${text.slice(0, 160)}". Naechster Schritt: "${knopf.name}"`)
    } else f.notiz(`Meldung: "${text.slice(0, 160)}"`)
    return text
  }

  // Wartet, bis eines der genannten Ziele zu sehen ist, und sagt welches. Wirft nach timeoutMs.
  async function erstesVon(ziele, timeoutMs) {
    const ende = Date.now() + timeoutMs
    for (;;) {
      for (const [name, s] of Object.entries(ziele)) if (await f.istDa(s)) return name
      if (Date.now() >= ende) throw new Error(`nach ${Math.round(timeoutMs / 1000)} s weder ${Object.keys(ziele).join(' noch ')} zu sehen`)
      await d.sleep(500)
    }
  }

  async function bleibtBedienbar() {
    await f.reiter('settings')
    await f.sieht(S.einstellungen.screen, 6000)
    await f.reiter('chat')
    await f.sieht(S.chats.screen, 6000)
  }

  async function mitNetzAus(fn) {
    try {
      await d.network(false)
      await fn()
    } finally {
      await d.network(true)
      await d.sleep(1500)
    }
  }

  async function oeffneChat({ neu = false } = {}) {
    await f.reiter('chat')
    await f.tap(S.chats.handy)
    if (!neu && (await f.istDa(S.chats.oeffnen))) await f.tap(S.chats.oeffnen)
    else await f.tap(S.chats.neu)
    await f.sieht(S.chat.screen)
    await f.ruhig()
  }

  async function brauchtLokalesModell() {
    if (await f.istDa(S.chat.ohneModell)) f.nichtPruefbar('Auf dem Geraet ist kein lokales Modell. Erst den Kundenfluss laufen lassen.')
    if (await f.istDa(S.chat.cloudChip)) {
      await f.tap(S.chat.optionen)
    await f.tap(S.optionen.modell)
      await f.sieht(S.modellBlatt.blatt)
      await f.tap(S.modellBlatt.lokal)
      await f.tap(S.modellBlatt.zeileLokal)
      await f.schliesse()
    }
  }

  // Stellt den Chat auf das guenstigste Cloud-Modell. Ohne Anmeldung oder Plan: nicht pruefbar.
  async function waehleCloudBillig() {
    await oeffneChat({ neu: true })
    await f.tap(S.chat.optionen)
    await f.tap(S.optionen.modell)
    await f.sieht(S.modellBlatt.blatt)
    await f.tap(S.modellBlatt.cloud)
    await d.sleep(1200)
    if (await f.istDa(S.modellBlatt.anmeldenNoetig)) {
      await f.schliesse()
      f.nichtPruefbar(OHNE_ANMELDUNG)
    }
    if (await f.istDa(S.modellBlatt.planNoetig)) {
      await f.schliesse()
      f.nichtPruefbar('Die Sitzung ist angemeldet, hat aber keinen Plan mit Cloud-Modellen')
    }
    await f.sieht(S.modellBlatt.zeileCloudBillig, 20000)
    const modell = await f.attribut(S.modellBlatt.zeileCloudBillig, 'data-m-id')
    await f.tap(S.modellBlatt.zeileCloudBillig)
    await d.sleep(600)
    if (await f.istDa(tid('m-dialog-cloud-switch'))) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Rueckfrage "Switch to Cloud?": Der Wechsel selbst kostet nichts')
    await f.schliesse()
    await f.sieht(S.chat.cloudChip)
    return modell
  }

  async function einwilligungFallsGefragt() {
    await d.sleep(800)
    // Gesperrt (lib/sperre.mjs): Die Einwilligung bleibt nach dem Lauf stehen. Hier bewusst, der Fluss sendet danach an die Cloud.
    if (await f.istDa(S.einwilligung.blatt)) await f.tapBewusst(S.einwilligung.zustimmen, 'Einwilligung fuer LU Cloud: Der Fehlerfall sendet danach bewusst an die Cloud. Sie bleibt erteilt, widerrufen wird in Settings, Privacy')
  }

  // Oeffnet Models und stellt die Karte des Fehler-Modells ein. Wirft "nicht pruefbar", wenn es schon installiert ist.
  async function zurKarte(id) {
    await f.reiter('models')
    await f.sieht(S.modelle.screen)
    await f.tap(S.modelle.neu)
    await f.sieht(S.modelle.karte(id), 20000)
    const status = await f.attribut(S.modelle.karte(id), 'data-state')
    if (status === 'installed' || status === 'loaded') f.nichtPruefbar(`Das Modell ${id} ist schon installiert. Mit FEHLER_MODELL ein anderes nennen.`)
    return status
  }

  // Speicher voll (Gegenpruefung 4 Android, A 25): Der Fall braucht nur irgendeine Karte, die "Download" anbietet.
  // Ist das Fehler-Modell schon installiert, nimmt er die erste andere, statt "nicht pruefbar" zu melden.
  // Mit FEHLER_MODELL gilt genau das genannte.
  async function karteMitDownload(id) {
    await f.reiter('models')
    await f.sieht(S.modelle.screen)
    await f.tap(S.modelle.neu)
    await f.sieht(S.modelle.karte(id), 20000)
    const frei = (await f.attribut(S.modelle.karte(id), 'data-state').then((st) => st !== 'installed' && st !== 'loaded')) && (await f.istDa(S.modelle.inKarte(id, S.modelle.laden)))
    if (frei || env.FEHLER_MODELL) return frei ? id : f.nichtPruefbar(`Das Modell ${id} ist schon installiert. Mit FEHLER_MODELL ein anderes nennen.`)
    const andere = await d.evalJs(`(() => { const k = [...document.querySelectorAll('[data-testid="m-models-item"][data-m-id]')].find((e) => e.getAttribute('data-state') !== 'installed' && e.getAttribute('data-state') !== 'loaded' && e.querySelector('[data-testid="m-models-download"]:not([disabled])')); return k ? k.getAttribute('data-m-id') : null })()`)
    if (!andere) f.nichtPruefbar(`Das Modell ${id} ist schon installiert, und keine andere Karte bietet einen Download an.`)
    f.notiz(`Das Modell ${id} ist schon installiert, der Fall nimmt ${andere}`)
    return andere
  }

  async function fortschritt(id) {
    const sel = S.modelle.inKarte(id, S.modelle.fortschritt).sel
    return await d.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const p = e.matches('[role="progressbar"]') ? e : e.querySelector('[role="progressbar"]'); const v = p ? Number(p.getAttribute('aria-valuenow')) : NaN; return { wert: Number.isFinite(v) ? v : null, text: e.innerText.slice(0, 80) } })()`)
  }

  // Verwirft den Testdownload und wartet, bis die Karte wieder "Download" anbietet. Gibt zurueck, ob sie das tut.
  // "Cancel" fragt erst nach (m-dialog-download-cancel). Ohne die Bestaetigung schloss f.schliesse() die
  // Rueckfrage mit "Keep", und der Download lief in den naechsten Schritt hinein (Nachabnahme iOS klein, IK-H2).
  async function raeumeDownloadAuf(id) {
    await f.schliesse().catch(() => {})
    await f.reiter('models').catch(() => {})
    if (await f.istDa(S.modelle.neu)) await f.tap(S.modelle.neu).catch(() => {})
    const frei = S.modelle.inKarte(id, S.modelle.laden)
    for (let runde = 0; runde < 3; runde++) {
      if (await f.istDa(frei)) return true
      for (const s of [S.modelle.abbrechen, S.modelle.entfernen]) {
        const ziel = S.modelle.inKarte(id, s)
        if (!(await f.istDa(ziel))) continue
        await f.tapBewusst(ziel, 'Aufraeumen: den Testdownload verwerfen, damit der naechste Schritt frisch beginnt').catch(() => {})
        await d.sleep(500)
        if (await f.istDa(tid('m-dialog-download-cancel'))) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Aufraeumen: Rueckfrage "Download verwerfen" am Testdownload bestaetigen').catch(() => {})
        break
      }
      await f.sieht(frei, 10000).catch(() => {})
    }
    await f.schliesse().catch(() => {})
    return await f.istDa(frei)
  }

  // Jeder Download-Fall beginnt an einer Karte, die "Download" anbietet. Liegt dort noch ein Download
  // (ein frueherer Schritt oder Lauf hat ihn hinterlassen), wird er zuerst verworfen: Kein Schritt
  // haengt davon ab, wie der davor geendet ist.
  async function zurFrischenKarte(id) {
    await zurKarte(id)
    if (await f.istDa(S.modelle.inKarte(id, S.modelle.laden))) return
    f.notiz(`An der Karte von ${id} lag noch ein Download von vorher, er wird zuerst verworfen`)
    if (!(await raeumeDownloadAuf(id))) throw new Error(`Die Karte von ${id} bietet auch nach dem Verwerfen keinen Download an`)
  }

  // Ob "Netz aus" des Treibers auch einen laufenden Download trifft. Auf Android schaltet der Treiber
  // WLAN und Mobilfunk des Geraets. Auf iOS faengt er nur die Anfragen der WebView ab: Den Download
  // traegt das System (URLSession), er laeuft weiter, solange die App keinen Haken netz(bool) anbietet.
  async function netzAusTrifftDownloads() {
    if (d.plattform !== 'ios') return true
    return !!(await d.evalJs(`!!(window.__LU_TEST__ && typeof window.__LU_TEST__.netz === 'function')`).catch(() => false))
  }

  // ---------- 1 Netz ----------

  await schritt('kein-netz', '1a Kein Netz: Die App sagt es, und lokal geht es weiter', async () => {
    await oeffneChat()
    await brauchtLokalesModell()
    await mitNetzAus(async () => {
      // R6 (Abnahme android-knoepfe): Der lokale Chat braucht kein Netz und zeigt die Offline-Zeile mit Absicht
      // nicht. Dass die App "kein Netz" sagt, wird dort verlangt, wo Netz gebraucht wird: am Katalog, weiter unten.
      await d.sleep(2500)
      f.notiz(`Offline-Zeile im lokalen Chat: ${(await f.istDa(S.system.offline)) ? 'zu sehen' : 'nicht zu sehen (so gewollt, der Chat laeuft ohne Netz)'}`)
      // Lokal chatten muss ohne Netz gehen.
      const vorher = await f.zahl(S.chat.antwortFertig)
      await f.tippe(S.chat.eingabe, 'Reply with one word: offline')
      await f.tapBewusst(S.chat.senden, 'lokales Modell und Netz aus, kostet nichts', { kostenlosWeil: 'lokal' })
      const ende = Date.now() + 3 * MIN
      while ((await f.zahl(S.chat.antwortFertig)) <= vorher) {
        if (await f.istDa(S.chat.fehler)) throw new Error(`Der lokale Chat scheitert ohne Netz: "${(await f.text(S.chat.fehler)).slice(0, 160)}"`)
        if (Date.now() >= ende) throw new Error('keine lokale Antwort ohne Netz nach 3 Minuten')
        await d.sleep(1000)
      }
      // Der Katalog braucht Netz: Die Seite sagt es und bietet "nochmal".
      await f.reiter('models')
      await f.tap(S.modelle.neu)
      await erwarteHinweis(S.modelle.offline, S.modelle.offlineNochmal)
      await bleibtBedienbar()
    })
    await f.siehtNicht(S.system.offline, 20000)
  })

  await schritt('kein-netz-cloud', '1b Kein Netz beim Senden an LU Cloud', async () => {
    await waehleCloudBillig()
    await mitNetzAus(async () => {
      await f.sieht(S.system.offline, 20000)
      await f.tippe(S.chat.eingabe, 'hello')
      // Entweder sperrt die App das Senden und sagt warum, oder die Anfrage scheitert mit einer Meldung.
      if ((await f.istDa(S.chat.senden)) && !(await f.element(S.chat.senden)).deaktiviert) {
        await f.tapBewusst(S.chat.senden, 'Netz ist aus, die Anfrage erreicht die Cloud nicht und kostet nichts', { kostenlosWeil: 'netz-aus' })
        await erwarteHinweis(S.chat.fehler, S.chat.fehlerAktion, 30000)
        await f.sieht(S.chat.fehlerAndererWeg, 3000)
      } else f.notiz('Senden ist ohne Netz gesperrt. Der Hinweis oben nennt den Grund.')
      if (!(await f.istDa(S.chat.frage)) && !(await f.wert(S.chat.eingabe))) throw new Error('Die getippte Nachricht ist weg: weder im Verlauf noch im Feld')
      await bleibtBedienbar()
    })
  })

  await schritt('netz-bricht-im-stream', '1c Netz bricht mitten in der Cloud-Antwort ab', async () => {
    const modell = await waehleCloudBillig()
    await f.tippe(S.chat.eingabe, 'Count slowly from 1 to 200, one number per line.')
    await f.tapBezahlt(S.chat.senden, 'chat', { modell: m.chat, zweck: `Fehlerfall Netz bricht im Stream, Zeile ${modell}` })
    await einwilligungFallsGefragt()
    await f.sieht(S.chat.antwortLaeuft, 60000)
    await d.sleep(1500)
    await mitNetzAus(async () => {
      await erwarteHinweis(S.chat.fehler, S.chat.fehlerAktion, 60000)
      // Der schon empfangene Teil der Antwort bleibt stehen.
      const teil = await d.evalJs(`(() => { const a = [...document.querySelectorAll('${S.chat.antwort.sel} ${S.chat.antwortText.sel}')]; return a.length ? a[a.length - 1].innerText : '' })()`)
      if (!teil.trim()) throw new Error('Der schon empfangene Teil der Antwort ist nach dem Abbruch weg')
      f.notiz(`Vom Abbruch blieben ${teil.trim().length} Zeichen stehen`)
      await bleibtBedienbar()
    })
  })

  // ---------- 2 Speicher voll ----------

  await schritt('speicher-voll', '2 Speicher voll: Der Download startet nicht und die App sagt, was zu tun ist', async () => {
    let echt = null
    if (env.SPEICHER_ECHT === '1' && d.plattform === 'android') {
      // Echt fuellen: bis auf rund 30 MB. Die Datei wird im finally wieder geloescht.
      const frei = Number((await d.shell("df -k /data | tail -1 | awk '{print $4}'")).trim())
      if (!Number.isFinite(frei) || frei < 100000) throw new Error(`freier Speicher nicht lesbar oder schon knapp (${frei} kB)`)
      echt = '/data/local/tmp/lu-harness-fuellung.bin'
      await d.shell(`fallocate -l ${frei - 30000}k ${echt}`, { timeoutMs: 120000 })
      f.notiz(`Speicher echt gefuellt: ${Math.round((frei - 30000) / 1024)} MB in ${echt}`)
    } else {
      // R7 (Abnahme android-knoepfe, am Geraet gemessen): Der Haken speicherVoll legt 0 Byte ueber das, was die
      // WebView fragt (Anzeige, Diagnose). Die Frage vor dem Download beantwortet die native Platzpruefung
      // (checkDownloadSpace), und die erreicht kein Skript. Ein Tipp auf Download wuerde hier wirklich laden.
      // Deshalb: ohne wirklich vollen Speicher ist dieser Fall nicht pruefbar, und es wird nichts getippt.
      f.nichtPruefbar('Speicher voll vor einem Download braucht einen wirklich vollen Speicher: SPEICHER_ECHT=1 auf einem eigenen Android-Geraet. Der Testhaken speicherVoll erreicht die native Platzpruefung nicht.')
    }
    let id = fehlerModell
    try {
      id = await karteMitDownload(fehlerModell)
      await f.tapBewusst(S.modelle.inKarte(id, S.modelle.laden), 'Die Platzpruefung muss den Download ablehnen, es wird nichts geladen')
      await d.sleep(800)
      // Vor der Platzpruefung fragt die App je nach Geraet und Netz zurueck ("ueber Mobilfunk laden", "Close to
      // the limit" auf 4 GB). Der Fluss kannte die zweite nicht und wartete vergeblich auf den Fehlerkasten.
      if (await f.istDa(tid('m-dialog-mobile-data'))) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Rueckfrage "ueber Mobilfunk laden": am Testgeraet ja, die Platzpruefung lehnt danach ab')
      if (await f.istDa(S.modelle.knapp)) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Rueckfrage "passt knapp": am Testgeraet ja, die Platzpruefung lehnt danach ab')
      await d.sleep(600)
      // Vorschau: Ohne native Seite gibt es keinen Download-Ordner, die App bricht davor ab (Toast download-failed).
      if (await f.istDa(tid('m-toast-download-failed'))) f.brauchtNativ('Die Platzpruefung (sie fragt den Download-Ordner des Geraets)')
      // G9: Rueckfrage "storage-full" mit dem Weg zur Speicherverwaltung. Oder der Fehlerkasten an der Karte.
      const dialog = await f.sieht(S.modelle.speicherVoll, 10000).then(() => true, () => false)
      if (dialog) {
        await erwarteHinweis(S.modelle.speicherVoll, S.rueckfrage.abbrechen)
        await f.sieht(S.rueckfrage.bestaetigen)
        await f.tap(S.rueckfrage.abbrechen)
      } else await erwarteHinweis(S.modelle.inKarte(id, S.modelle.fehler), S.modelle.inKarte(id, S.modelle.fehlerSpeicher))
      await d.sleep(1500)
      const p = await fortschritt(id)
      if (p && p.wert) throw new Error(`Trotz vollem Speicher laeuft ein Download (${p.text})`)
      await bleibtBedienbar()
    } finally {
      if (echt) await d.shell(`rm -f ${echt}`).catch(() => {})
      await raeumeDownloadAuf(id).catch(() => {})
    }
  })

  // ---------- 3 Modell zu gross ----------

  await schritt('modell-zu-gross', '3 Modell zu gross fuer das Geraet: gesperrt, mit Begruendung', async () => {
    await f.reiter('models')
    await f.sieht(S.modelle.screen)
    await f.tap(S.modelle.neu)
    await f.sieht(S.modelle.katalog, 20000)
    let vorgetaeuscht = false
    // R8 (Abnahme android-knoepfe): Der Filter "Fits this phone" ist auf einer frischen Installation an und
    // blendet genau die Karten aus, um die es hier geht. Fuer diesen Schritt aus, am Ende wieder an.
    let filterWarAn = false
    if ((await f.istDa(S.modelle.filterPasst)) && (await f.attribut(S.modelle.filterPasst, 'aria-pressed')) === 'true') {
      await f.tap(S.modelle.filterPasst)
      filterWarAn = true
      await d.sleep(600)
    }
    if (!(await f.zahl(S.modelle.zuGross))) {
      // Dieses Geraet ist gross genug fuer den ganzen Katalog. Dann ein kleines vortaeuschen.
      await f.haken('geraet', { ramBytes: 3 * 1024 ** 3 })
      vorgetaeuscht = true
      await d.sleep(800)
      await f.reiter('models')
    }
    try {
      await f.sieht(S.modelle.zuGross, 10000)
      const hinweis = await erwarteHinweis(S.modelle.zuGrossHinweis)
      // Die Sperre muss halten: In einer zu grossen Karte gibt es keinen bedienbaren Download.
      const laden = await d.evalJs(`[...document.querySelectorAll('${S.modelle.zuGross.sel} ${S.modelle.laden.sel}')].filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true').length`)
      if (laden) throw new Error(`${laden} zu grosse Karte(n) bieten trotzdem einen bedienbaren Download`)
      // Der naechste Schritt: Es gibt Modelle, die passen (Filter "Fits this phone").
      await f.sieht(S.modelle.filterPasst)
      f.notiz(`${await f.zahl(S.modelle.zuGross)} Karte(n) zu gross${vorgetaeuscht ? ' (Geraet ueber den Testhaken auf 3 GB gestellt)' : ''}. Hinweis: "${hinweis.slice(0, 120)}"`)
      await bleibtBedienbar()
    } finally {
      if (vorgetaeuscht) await f.haken('geraet', null).catch(() => {})
      if (filterWarAn) {
        await f.reiter('models').catch(() => {})
        await f.tap(S.modelle.neu).catch(() => {})
        if ((await f.attribut(S.modelle.filterPasst, 'aria-pressed').catch(() => null)) === 'false') await f.tap(S.modelle.filterPasst).catch(() => {})
      }
    }
  })

  // ---------- 4 Download abgebrochen ----------

  await schritt('download-abgebrochen', '4a Download: Netz faellt weg, danach geht es an derselben Stelle weiter', async () => {
    const id = fehlerModell
    await zurFrischenKarte(id)
    try {
      await f.sieht(S.modelle.inKarte(id, S.modelle.laden))
      f.brauchtNativ('Ein Download')
      // Vor dem Start gefragt: Wo der Treiber das Netz des Downloads nicht kappen kann, beginnt auch keiner.
      if (!(await netzAusTrifftDownloads())) {
        f.nichtPruefbar('nicht pruefbar auf iOS: Der Treiber kappt nur das Netz der WebView, den Download traegt das System und er laeuft weiter. Eine Fehlermeldung kann so nicht kommen. Von Hand am Geraet: Download starten, Flugmodus an, Meldung und "Resume" ansehen, Flugmodus aus, fortsetzen.')
      }
      await f.tapBewusst(S.modelle.inKarte(id, S.modelle.laden), `Testdownload von ${id}, wird nach wenigen Sekunden unterbrochen und am Ende verworfen`)
      await d.sleep(600)
      if (await f.istDa(tid('m-dialog-mobile-data'))) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Rueckfrage "ueber Mobilfunk laden": am Testgeraet ja')
      if (await f.istDa(S.modelle.knapp)) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Rueckfrage "passt knapp": am Testgeraet ja')
      await f.sieht(S.modelle.inKarte(id, S.modelle.fortschritt), 30000)
      await d.sleep(4000)
      const vor = await fortschritt(id)
      // Zwei richtige Bilder (Nachpruefung Android 8 GB, H2): Die App wartet auf das Netz und setzt von selbst fort
      // (die Zeile zeigt "Waiting for network", data-state="waiting-network", kein Fehlerkasten), oder sie zeigt den
      // Kasten mit "Resume". Der Schritt wartete nur auf den Kasten und scheiterte an einer App, die es besser macht.
      const wartet = S.modelle.inKarte(id, S.modelle.wartetAufNetz)
      const kasten = S.modelle.inKarte(id, S.modelle.fehler)
      let bild = null
      await mitNetzAus(async () => {
        bild = await erstesVon({ wartet, kasten }, 60000)
        if (bild === 'kasten') await erwarteHinweis(kasten, S.modelle.inKarte(id, S.modelle.fortsetzen), 4000)
        else {
          const text = await f.text(S.modelle.inKarte(id, S.modelle.transfer))
          if (text.length < 12) throw new Error(`Die Zeile des Downloads sagt nichts: "${text}"`)
          f.notiz(`Ohne Netz zeigt die Zeile: "${text.replace(/\s+/g, ' ').slice(0, 160)}". Kein Fehlerkasten, die App wartet auf das Netz.`)
        }
        await bleibtBedienbar()
      })
      await f.reiter('models')
      if (bild === 'kasten' && (await f.istDa(S.modelle.inKarte(id, S.modelle.fortsetzen)))) await f.tapBewusst(S.modelle.inKarte(id, S.modelle.fortsetzen), 'Fortsetzen nach dem Netzabbruch')
      // Von selbst oder nach dem Tipp: Die Zeile muss wieder laufen. Bleibt sie stehen, ist das der Fund.
      await f.sieht(S.modelle.inKarte(id, S.modelle.laeuftWieder), 90000)
      await d.sleep(2500)
      const nach = await fortschritt(id)
      f.notiz(`${bild === 'kasten' ? 'Fehlerkasten mit "Resume"' : 'Die App hat auf das Netz gewartet und von selbst fortgesetzt'}. Fortschritt vor dem Abbruch: ${vor?.text ?? '?'}, nach dem Fortsetzen: ${nach?.text ?? '?'}`)
      if (vor?.wert != null && nach?.wert != null && nach.wert + 1 < vor.wert) throw new Error(`Der Download hat nach dem Fortsetzen von vorn begonnen (${vor.wert} vorher, ${nach.wert} nachher)`)
    } finally {
      const frei = await raeumeDownloadAuf(id).catch(() => false)
      if (!frei && d.plattform !== 'vorschau') f.notiz(`Aufraeumen: Die Karte von ${id} bietet danach keinen Download an. Der naechste Download-Schritt verwirft den Rest selbst.`)
    }
  })

  await schritt('download-app-abschuss', '4b Download: App wird mittendrin abgeschossen, danach ist der Download noch da', async () => {
    const id = fehlerModell
    await zurFrischenKarte(id)
    try {
      await f.sieht(S.modelle.inKarte(id, S.modelle.laden))
      f.brauchtNativ('Ein Download')
      await f.tapBewusst(S.modelle.inKarte(id, S.modelle.laden), `Testdownload von ${id}, die App wird nach wenigen Sekunden abgeschossen, am Ende wird er verworfen`)
      await d.sleep(600)
      if (await f.istDa(tid('m-dialog-mobile-data'))) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Rueckfrage "ueber Mobilfunk laden": am Testgeraet ja')
      if (await f.istDa(S.modelle.knapp)) await f.tapBewusst(S.rueckfrage.bestaetigen, 'Rueckfrage "passt knapp": am Testgeraet ja')
      await f.sieht(S.modelle.inKarte(id, S.modelle.fortschritt), 30000)
      await d.sleep(5000)
      const vor = await fortschritt(id)
      await d.kill()
      await d.launch()
      await f.sieht(S.system.app, 30000)
      // Die App muss von selbst sagen, dass da noch etwas liegt: Hinweis nach der Rueckkehr oder an Models.
      const meldet = (await f.istDa(S.system.wiederDa)) || (await f.istDa(S.modelle.downloadHinweis))
      await f.reiter('models')
      await f.tap(S.modelle.neu)
      await f.sieht(S.modelle.karte(id), 20000)
      const status = await f.attribut(S.modelle.karte(id), 'data-state')
      const laeuft = await f.istDa(S.modelle.inKarte(id, S.modelle.fortschritt))
      const fortsetzbar = await f.istDa(S.modelle.inKarte(id, S.modelle.fortsetzen))
      if (!laeuft && !fortsetzbar) throw new Error(`Nach dem Abschuss ist der Download weg: Karte steht auf "${status}", weder Fortschritt noch "Resume"`)
      if (fortsetzbar) await f.tapBewusst(S.modelle.inKarte(id, S.modelle.fortsetzen), 'Fortsetzen nach dem Abschuss')
      await f.sieht(S.modelle.inKarte(id, S.modelle.fortschritt), 30000)
      await d.sleep(2500)
      const nach = await fortschritt(id)
      f.notiz(`Vor dem Abschuss: ${vor?.text ?? '?'}. Danach: Karte "${status}", ${laeuft ? 'lief von selbst weiter' : 'wartete auf "Resume"'}, jetzt ${nach?.text ?? '?'}. Hinweis nach der Rueckkehr: ${meldet ? 'ja' : 'nein'}`)
      if (vor?.wert != null && nach?.wert != null && nach.wert + 1 < vor.wert) throw new Error(`Der Download hat nach dem Abschuss von vorn begonnen (${vor.wert} vorher, ${nach.wert} nachher)`)
      await bleibtBedienbar()
    } finally {
      const frei = await raeumeDownloadAuf(id).catch(() => false)
      if (!frei && d.plattform !== 'vorschau') f.notiz(`Aufraeumen: Die Karte von ${id} bietet danach keinen Download an. Der naechste Download-Schritt verwirft den Rest selbst.`)
    }
  })

  // ---------- 5 App im Hintergrund vom System beendet ----------

  await schritt('hintergrund-beendet', '5a Im Hintergrund beendet: Die App kommt zurueck, nichts Gespeichertes fehlt', async () => {
    await f.reiter('chat')
    await f.tap(S.chats.handy)
    const chatsVorher = await f.zahl(S.chats.zeile)
    await oeffneChat()
    const entwurf = `Entwurf ${Date.now().toString(36)}, noch nicht gesendet`
    await f.tippe(S.chat.eingabe, entwurf)
    await d.sleep(600)
    if (typeof d.backgroundKill !== 'function') throw new Error('Der Treiber kann die App nicht im Hintergrund beenden')
    const r = await d.backgroundKill()
    if (!r.beendet) throw new Error('Der Prozess liess sich im Hintergrund nicht beenden')
    await d.launch()
    await f.sieht(S.system.app, 30000)
    const l = await f.lage()
    if (l.fatal) throw new Error('Nach der Rueckkehr zeigt die App den Fehlerschirm')
    if (l.route === '/welcome' || l.alter === 'ask') throw new Error('Nach der Rueckkehr beginnt die App wieder beim ersten Start')
    await f.reiter('chat')
    await f.tap(S.chats.handy)
    const chatsNachher = await f.zahl(S.chats.zeile)
    if (chatsNachher < chatsVorher) throw new Error(`Chats verloren: vorher ${chatsVorher}, nachher ${chatsNachher}`)
    await oeffneChat()
    // Der ungesendete Entwurf: MOBILE-ZIEL.md verlangt nicht ausdruecklich, dass er ueberlebt. Der Lauf
    // haelt fest, was er sieht, und David entscheidet, ob das ein Mangel ist.
    const jetzt = await f.wert(S.chat.eingabe)
    const da = jetzt.includes(entwurf.slice(0, 16))
    f.notiz(`Nach der Rueckkehr stand die App auf ${l.route}, ${chatsNachher} Chat(s) wie vorher. Ungesendeter Entwurf: ${da ? 'noch da' : 'WEG (Beobachtung, kein Fehler dieses Schritts)'}`)
    // Aufraeumen: Feld leeren, damit der naechste Schritt nicht darauf aufbaut.
    if (jetzt) {
      await d.tap(S.chat.eingabe.sel)
      for (let i = 0; i < jetzt.length + 2; i++) await d.key('Backspace')
    }
    await bleibtBedienbar()
  })

  await schritt('abschuss-in-der-antwort', '5b Abschuss mitten in der Antwort: Frage und Teilantwort bleiben, die App sagt, wie es weitergeht', async () => {
    await oeffneChat()
    await brauchtLokalesModell()
    const fragen = await f.zahl(S.chat.frage)
    await f.tippe(S.chat.eingabe, 'Write a long story about a lighthouse keeper. At least 600 words.')
    await f.tapBewusst(S.chat.senden, 'lokales Modell, kostet nichts', { kostenlosWeil: 'lokal' })
    await f.sieht(S.chat.antwortLaeuft, 2 * MIN)
    // Der Fall heisst "mitten in der Antwort": Abgeschossen wird erst, wenn Text der Antwort dasteht.
    // Kommt in zwei Minuten kein Zeichen (langsames Geraet, Modell laedt noch), belegt ein Abschuss
    // nur "vor der Antwort". Das ist dann nicht dieser Fall und wird nicht gruen (Nachabnahme Android, H5).
    const laufendeAntwort = `(() => { const a = document.querySelectorAll('[data-testid="m-chat-message"][data-m-role="assistant"][data-state="streaming"] [data-testid="m-chat-answer"]'); return a.length ? (a[a.length - 1].innerText || '').trim().length : 0 })()`
    let zeichenVorher = 0
    const bis = Date.now() + 2 * MIN
    while (Date.now() < bis) {
      zeichenVorher = Number(await d.evalJs(laufendeAntwort).catch(() => 0)) || 0
      if (zeichenVorher >= 20) break
      await d.sleep(1000)
    }
    if (zeichenVorher < 20) {
      if (await f.istDa(S.chat.stopp)) await f.tap(S.chat.stopp)
      f.nichtPruefbar(`Der Abschuss waere vor dem ersten Text der Antwort gekommen (${zeichenVorher} Zeichen nach 2 Minuten). Der Fall "mitten in der Antwort" ist so nicht belegt. Von Hand pruefen oder mit einem schnelleren Modell wiederholen.`)
    }
    await d.kill()
    await d.launch()
    await f.sieht(S.system.app, 30000)
    const meldet = await f.istDa(S.system.wiederDa)
    if (meldet) {
      // R6: Kommt die App im betroffenen Chat selbst wieder hoch, hat der Hinweis keinen Knopf "Open chat"
      // (der Chat ist schon offen). Der Knopf wird nur verlangt, wenn die App woanders steht.
      await erwarteHinweis(S.system.wiederDa, null)
      if (await f.istDa(S.system.wiederDaOeffnen)) await f.tap(S.system.wiederDaOeffnen)
      else if (!(await f.istDa(S.chat.screen))) throw new Error('Der Hinweis nach der Rueckkehr nennt keinen Weg zum Chat ("Open chat" fehlt), und der Chat ist nicht offen')
    } else await oeffneChat()
    await f.sieht(S.chat.screen)
    await d.sleep(1500)
    if ((await f.zahl(S.chat.frage)) <= fragen) throw new Error('Die Frage, die vor dem Abschuss gesendet wurde, steht nicht mehr im Chat')
    // Die Teilantwort selbst: Was vor dem Abschuss dastand, steht noch da (ein paar Zeichen duerfen fehlen, die noch nicht geschrieben waren).
    const zeichenNachher = Number(await d.evalJs(`(() => { const a = document.querySelectorAll('[data-testid="m-chat-answer"]'); return a.length ? (a[a.length - 1].innerText || '').trim().length : 0 })()`).catch(() => 0)) || 0
    if (zeichenNachher === 0) throw new Error(`Die Teilantwort ist weg: vor dem Abschuss ${zeichenVorher} Zeichen, danach keine`)
    f.notiz(`Teilantwort: ${zeichenVorher} Zeichen vor dem Abschuss, ${zeichenNachher} danach`)
    // Die unterbrochene Antwort: Entweder steht ihr Anfang da und ein Kasten bietet "Continue", oder die App hat sie von selbst fortgesetzt.
    const haengt = await f.istDa(S.chat.antwortLaeuft)
    const kasten = await f.istDa(S.chat.fehler)
    if (kasten) await erwarteHinweis(S.chat.fehler, S.chat.fehlerAktion)
    else if (!haengt && !meldet) throw new Error('Nach dem Abschuss sagt die App nichts ueber die unterbrochene Antwort: kein Hinweis nach der Rueckkehr, kein Kasten an der Antwort')
    if (haengt && !(await f.istDa(S.chat.stopp))) throw new Error('Eine Antwort steht auf "streaming", aber es laeuft nichts (kein Stopp-Knopf): Der Chat haengt')
    f.notiz(`Hinweis nach der Rueckkehr: ${meldet ? 'ja' : 'nein'}, Kasten an der Antwort: ${kasten ? 'ja' : 'nein'}, laeuft wieder: ${haengt ? 'ja' : 'nein'}`)
    if (haengt) await f.tap(S.chat.stopp)
    await bleibtBedienbar()
  })

  // ---------- 6 Guthaben leer ----------

  await schritt('guthaben-leer', '6 Guthaben leer: Blatt mit Grund und zwei Wegen', async () => {
    if (!(await f.hakenHat('guthabenLeer'))) await f.haken('guthabenLeer')
    await waehleCloudBillig()
    await f.tippe(S.chat.eingabe, 'hello')
    // Der Haken stellt den Zaehler der App auf 0 und meldet ihr, ein bezahlter Aufruf sei abgelehnt worden.
    // Gesendet wird hier NICHT: Das echte Konto hat Guthaben, eine gesendete Nachricht wuerde berechnet.
    await f.haken('guthabenLeer', true)
    try {
      await f.sieht(S.guthaben.blatt, 30000)
      await erwarteHinweis(S.guthaben.grund, S.guthaben.nichtJetzt)
      // Der zweite Weg: auf dem Handy weitermachen. Ein Kaufweg je nach Store-Preset (Knopf, Satz oder nichts).
      await f.sieht(S.guthaben.aufDemGeraet, 3000)
      const kauf = (await f.istDa(S.guthaben.plaene)) ? 'Knopf zur Preisseite' : (await f.istDa(S.guthaben.plaeneText)) ? 'ein Satz ohne Link' : 'keine Kaufflaeche'
      f.notiz(`Kaufweg im Blatt: ${kauf} (haengt am Store-Preset). Ob die App mit leerem Zaehler noch sendet, prueft dieser Schritt nicht, das koennte Geld kosten.`)
      await f.tap(S.guthaben.aufDemGeraet)
      await f.siehtNicht(S.guthaben.blatt)
      if (!(await f.wert(S.chat.eingabe))) throw new Error('Die getippte Nachricht ist weg')
      await bleibtBedienbar()
    } finally {
      await f.haken('guthabenLeer', false).catch(() => {})
    }
  })

  // ---------- 7 Sitzung abgelaufen ----------

  await schritt('sitzung-abgelaufen', '7 Sitzung abgelaufen: Meldung, erneut anmelden oder auf dem Handy weiter', async () => {
    if (!(await f.hakenHat('sitzungAblaufen'))) await f.haken('sitzungAblaufen')
    if (env.SITZUNG_ABLAUFEN !== '1') f.mensch('Der Haken beendet die Sitzung in der App, danach muss David neu anmelden. Nur mit SITZUNG_ABLAUFEN=1.')
    await waehleCloudBillig()
    await f.tippe(S.chat.eingabe, 'hello')
    // Der Haken schreibt in die App, was die Logikschicht schreibt, wenn der Server das Token endgueltig ablehnt.
    // Gesendet wird hier NICHT: Ob das Token am Server noch gilt, weiss der Rahmen nicht, eine Nachricht koennte berechnet werden.
    await f.haken('sitzungAblaufen')
    // Die App muss es von selbst sagen (Blatt G6), ohne dass der Kunde erst etwas abschickt.
    await f.sieht(S.sitzung.blatt, 20000)
    await f.sieht(S.sitzung.anmelden)
    await f.sieht(S.sitzung.aufDemGeraet)
    // Der Weg ohne Anmeldung: auf dem Handy weitermachen.
    await f.tap(S.sitzung.aufDemGeraet)
    await f.toast('session-on-device')
    await f.siehtNicht(S.sitzung.blatt)
    if (!(await f.wert(S.chat.eingabe))) f.notiz('Der getippte Text steht nach dem Blatt nicht mehr im Feld')
    await bleibtBedienbar()
  })

  return f.ende()
}

if (istHauptmodul(import.meta.url)) {
  const k = await starte('fehlerfaelle')
  let e
  await k.d.connect(k.d.plattform === 'vorschau' ? {} : { pkg: k.config.pkg, urlFilter: k.config.urlFilter, start: true })
  const vorher = await k.d.snapshotSettings()
  try {
    e = await fehlerfaelle(k)
  } finally {
    await k.d.restoreSettings(vorher).catch(() => {})
    await k.d.disconnect()
  }
  console.log(JSON.stringify(e.zahlen), e.abgebrochen ?? '', '\n' + k.laufDir)
  for (const s of e.schritte) console.log(String(s.nr).padStart(2), s.status.padEnd(14), s.id.padEnd(24), (s.grund ?? '').slice(0, 150))
}
