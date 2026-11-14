// N1: die Modelldatei des gewaehlten Chatmodells fehlt (Pruefung iOS Paket 11, N1; Paket 17, F-R10).
//
// Erwartet: ein Satz mit dem Namen des Modells ("The model file "SmolLM2 360M" is not on this device. Open
// Models and download it again."), ein Weg hinaus, und nirgends ein Pfad. Die App merkt das erst, wenn sie
// das Modell laedt. Ist das Zielmodell schon geladen, antwortet die Engine weiter aus dem Speicher und die
// Pruefung sieht nichts (F-R10: der erste Versuch an Paket 17 war deshalb ungueltig). Darum laedt der Fluss
// vorher ein anderes Chatmodell, wenn das Ziel gerade in der Engine steht, und nimmt erst dann dem Ziel
// seine Datei. Gewaehlt wird es danach im Modell-Blatt, wie ein Kunde es tut.
//
// Die Datei wird nur umbenannt (<datei>.n1-geparkt) und am Ende in jedem Fall zurueckbenannt.
// iOS (Simulator): der Pfad der App liegt auf dem Mac. Android: `run-as` im Ordner der App.
//
// Aufruf:  PLATFORM=ios IOS_SIM=<eigener> node flows/n1.mjs      (Umgebung: N1_MODELL=<Teil des Dateinamens>, Standard SmolLM2)
// Voraussetzung: zwei Chatmodelle auf dem Geraet (Kundenfluss mit Modellwechsel davor).

import { rename } from 'node:fs/promises'
import { ablauf, starte, tid } from './lib.mjs'
import { S } from './selektoren.mjs'
import { istHauptmodul } from '../lib/lauf.mjs'

const MIN = 60 * 1000
const EINBETTUNG = /embed|nomic-|bge-|e5-|gte-|sentence-/i
const PFAD = /\/Users\/|\/private\/|\/var\/mobile|\/data\/(?:user|data)\/|Library\/|Application Support|CoreSimulator|\.gguf\b/

const stamm = (name) => String(name ?? '').split('/').pop().replace(/\.gguf$/i, '')
const gleich = (a, b) => !!a && !!b && String(a).replace(/\\/g, '/') === String(b).replace(/\\/g, '/')

/**
 * Welches Modell seine Datei verliert, und welches vorher geladen werden muss.
 * modelle: [{ name, path }] aus list_bundled_models, geladen: model_path der Engine (oder null).
 * Antwort: { ziel, zuerst } oder { grund }, wenn die Pruefung auf diesem Geraet nicht geht.
 */
export function n1Plan({ modelle, geladen, wunsch = /smollm2/i }) {
  const chat = (modelle ?? []).filter((m) => m && typeof m.path === 'string' && !EINBETTUNG.test(m.name ?? m.path))
  if (chat.length < 2) return { grund: `braucht zwei Chatmodelle auf dem Geraet, es sind ${chat.length}. Erst den Kundenfluss mit dem Schritt modellwechsel laufen lassen.` }
  const ziel = chat.find((m) => wunsch.test(m.name ?? m.path)) ?? chat.find((m) => !gleich(m.path, geladen)) ?? chat[0]
  // F-R10: steht das Ziel in der Engine, faellt seine fehlende Datei nicht auf. Erst ein anderes laden.
  const zuerst = gleich(ziel.path, geladen) ? chat.find((m) => m !== ziel) : null
  return { ziel, zuerst }
}

/** Ist der Text der Satz von N1: Name des Modells, "is not on this device", kein Pfad. */
export function n1Urteil(text, ganzeSeite) {
  const satz = /The model file "[^"]+" is not on this device\. Open Models and download it again/.test(text ?? '')
  const pfad = PFAD.test(ganzeSeite ?? '')
  return { ok: satz && !pfad, satz, pfad }
}

export async function n1({ d, config, laufDir }, env = process.env) {
  const f = await ablauf('n1', { d, laufDir, config })
  const wunsch = new RegExp(String(env.N1_MODELL ?? 'smollm2').replace(/[^\w.-]/g, ''), 'i')

  const lies = (befehl) => d.evalJs(`(async () => { try { return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(befehl)}) } catch (e) { return { fehler: String(e) } } })()`)

  async function neuerChat() {
    await f.reiter('chat')
    if (await f.istDa(S.chats.handy)) await f.tap(S.chats.handy)
    await f.tap(S.chats.neu)
    await f.sieht(S.chat.screen)
    await f.ruhig()
  }

  async function waehle(modell) {
    await f.tap(S.chat.optionen)
    await f.tap(S.optionen.modell)
    await f.sieht(S.modellBlatt.blatt)
    await f.tap(S.modellBlatt.lokal)
    await f.tap(tid('m-chat-model-local', `[data-m-id*="${stamm(modell.name ?? modell.path).replace(/"/g, '')}"]`))
    await f.schliesse()
  }

  async function sende(text) {
    const vorher = await f.zahl(S.chat.antwortFertig)
    await f.tippe(S.chat.eingabe, text)
    await f.sieht(S.chat.senden)
    f.brauchtNativ('Eine lokale Antwort (Engine und Modell)')
    await f.tapBewusst(S.chat.senden, 'lokales Modell gewaehlt, keine Kosten', { kostenlosWeil: 'lokal' })
    return vorher
  }

  async function parke(pfad, hin) {
    const von = hin ? pfad : `${pfad}.n1-geparkt`
    const nach = hin ? `${pfad}.n1-geparkt` : pfad
    if (d.plattform === 'ios') return rename(von, nach)
    if (d.plattform === 'android') return d.shell(`run-as ${d.pkg} mv "${von}" "${nach}"`)
    throw new Error(`parke: Plattform ${d.plattform} hat keine Dateien der App`)
  }

  await f.schritt('modelldatei-fehlt', 'N1: Modelldatei weg, Satz mit Namen, kein Pfad, unabhaengig vom geladenen Modell', async () => {
    if (d.plattform === 'vorschau') f.nichtPruefbar('nicht pruefbar in der Vorschau: keine Dateien und keine Engine')
    const liste = await lies('list_bundled_models')
    const status = await lies('bundled_engine_status')
    const modelle = Array.isArray(liste?.models) ? liste.models : Array.isArray(liste) ? liste : []
    const plan = n1Plan({ modelle, geladen: status?.running ? status.model_path : null, wunsch })
    if (plan.grund) f.nichtPruefbar(plan.grund)
    f.notiz(`Ziel: ${stamm(plan.ziel.name ?? plan.ziel.path)}${plan.zuerst ? `, war geladen, deshalb erst ${stamm(plan.zuerst.name ?? plan.zuerst.path)} geladen (F-R10)` : ', war nicht geladen'}`)
    await neuerChat()
    if (plan.zuerst) {
      await waehle(plan.zuerst)
      const vorher = await sende('Reply with one word: ready')
      const ende = Date.now() + 4 * MIN
      while ((await f.zahl(S.chat.antwortFertig)) <= vorher) {
        if (Date.now() >= ende) throw new Error('Das andere Modell hat in 4 Minuten nicht geantwortet')
        await d.sleep(1000)
      }
      const jetzt = await lies('bundled_engine_status')
      if (gleich(jetzt?.model_path, plan.ziel.path)) throw new Error('Das Ziel ist nach dem Wechsel noch geladen')
      await neuerChat()
    }
    await parke(plan.ziel.path, true)
    try {
      await waehle(plan.ziel)
      await sende('Say hi once.')
      const ende = Date.now() + 90 * 1000
      let text = ''
      while (Date.now() < ende) {
        text = await d.evalJs(`[...document.querySelectorAll('[data-testid="m-chat-engine-error"], [data-testid="m-chat-error"], [role="alert"]')].filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.innerText.replace(/\\n+/g, ' / ')).join(' || ')`)
        if (/is not on this device/.test(text ?? '')) break
        await d.sleep(1500)
      }
      const seite = await d.evalJs('document.body.innerText')
      const u = n1Urteil(text, seite)
      f.notiz(`Meldung: "${String(text ?? '').slice(0, 240)}"`)
      if (!u.satz) throw new Error(`Kein Satz "is not on this device" nach 90 s. Zu sehen: "${String(text ?? '').slice(0, 200)}"`)
      if (u.pfad) throw new Error('Die Seite zeigt einen Pfad oder eine Dateiendung')
    } finally {
      await parke(plan.ziel.path, false).catch((e) => f.notiz(`Zurueckbenennen gescheitert, von Hand: ${e.message}`))
    }
  })

  return f.ende()
}

if (istHauptmodul(import.meta.url)) {
  const k = await starte('n1')
  let e
  try {
    await k.d.connect(k.d.plattform === 'vorschau' ? undefined : { pkg: k.config.pkg, urlFilter: k.config.urlFilter, start: true })
    e = await n1(k)
  } finally {
    await k.d.disconnect()
  }
  console.log(JSON.stringify(e.zahlen), '\n' + k.laufDir)
  for (const s of e.schritte) console.log(String(s.nr).padStart(2), s.status.padEnd(14), s.id.padEnd(24), (s.grund ?? '').slice(0, 150))
}
