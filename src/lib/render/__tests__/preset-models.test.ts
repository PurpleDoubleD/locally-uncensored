// Ein Modell, das in einem Preset-Schritt auswaehlbar ist, muss diesen Schritt
// auch wirklich rechnen koennen.
//
// 19.09.2026, Entscheid des Inhabers: der Kunde waehlt im Preset selbst, welches
// Modell den Schritt faehrt. Damit ist jede Liste hier ein Versprechen. Der
// Fall unten loest es ein: fuer jedes Mitglied gibt es einen Preis auf beiden
// Seiten und einen Op, den die Submit-Route annimmt.
//
// Desktop port (P2): zwei Web-Faelle sind gestrichen, nicht angepasst.
// "Der Worker hat fuer jedes Mitglied eine Route" liest
// the render worker, eine Serverdatei, die es
// im Desktop-Checkout gar nicht gibt (Portplan Abschnitt 2.3: Worker NICHT
// portiert). "jedes Mitglied hat einen Preis, und der klassische ist der der
// Route" vergleicht gegen creditCost aus app/api/jobs/route.ts, ebenfalls
// Server, ebenfalls nicht im Desktop. Die verbleibenden Faelle pruefen die
// Vertraege, die der Desktop wirklich hat: die Rollenlisten und den Preis aus
// der lebenden cloudCatalogStore-Bruecke (classicCredits).
//
// Zwei weitere Faelle sind gegenueber dem Web angepasst statt uebernommen:
// der Notvorrat CLOUD_MODEL_SEED fuehrt fuer mehrere klassische Videomodelle
// bewusst noch keinen Preis (katalog-paritaet-web.test.ts nennt das
// "Altbestand"; erst die lebende Katalogantwort liefert ihn). Ein Test, der
// hier "hat immer einen Preis" verlangt, wuerde eine Vollstaendigkeit
// behaupten, die die Testumgebung ohne Netz gar nicht hat.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ALL_ROLES, SWAP_ROLES, classicCredits, presetModels, requiredRoleInputs, roleForModel,
  roleHasChoice, roleInputs,
} from '../preset-models'
import { CREATE_PRESETS } from '../create-presets'
import { STUDIO_MODELS } from '../studio-contract'
import { cloudModelById, cloudModelSupportsOp, useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { videoDurations } from '../video-duration'
import { neuerServer } from './fixtures/test-catalogs'

// Review B1 (Runde 2): `presetModels()` is what the Preset Workshop (P6)
// calls directly, and the workshop is only ever reachable when the live
// catalog already announces Studio (`quote_required`, PresetShelf.tsx hides
// itself otherwise). This whole file tests that reachable state, so it
// seeds the catalog of the newest server (every studio model listed, with
// tier and weights), the same way create-studio.test.ts does for the
// Composer's OWN gate. Studio members are offered per model since 02.10.2026
// (`studioKnown`): a catalog that lacks one hides it, and the "a classic id
// yields to its live studio twin" skip only fires for a twin the server lists.
// alter-server.test.ts holds the opposite state.
beforeEach(() => {
  useCloudCatalogStore.setState({ models: neuerServer() })
})

// Die Ops, die die Submit-Route pro Art annimmt. Spiegel von SUPPORTED_OPS in
// app/api/jobs/route.ts (Server): was dort fehlt, wird vor dem Abbuchen
// abgelehnt.
const SUPPORTED_OPS: Record<string, readonly string[]> = {
  image: ['studio', 'generate', 'edit', 'removebg', 'eraser', 'upscale', 'lora-train'],
  video: ['studio', 'generate', 'animate', 'upscale', 'lipsync', 'extend', 'motion', 'lora-train'],
  audio: ['studio', 'music', 'tts'],
  // 3.1.0: 3D runs as a studio model only (SUPPORTED_OPS['3d'] on the server).
  '3d': ['studio'],
}

describe('jedes waehlbare Modell faehrt seinen Schritt', () => {
  it('jede Rolle hat Mitglieder, und jedes Mitglied steht genau einmal drin', () => {
    for (const role of ALL_ROLES) {
      const list = presetModels(role)
      expect(list.length, role).toBeGreaterThan(0)
      expect(new Set(list.map((m) => m.id)).size, role).toBe(list.length)
    }
  })

  it('kein Endpunkt steht zweimal in derselben Rolle', () => {
    for (const role of ALL_ROLES) {
      // Ein Studio-Eintrag verdraengt seinen klassischen Zwilling. Stuende
      // beides drin, waehlte der Kunde zweimal dasselbe unter einem Namen.
      const twins = presetModels(role)
        .map((m) => STUDIO_MODELS[m.id]?.sourceModel ?? m.id)
      expect(new Set(twins).size, role).toBe(twins.length)
    }
  })

  it('die Submit-Route nimmt den Op jedes Mitglieds an', () => {
    for (const role of ALL_ROLES) {
      for (const m of presetModels(role)) {
        expect(SUPPORTED_OPS[m.kind], `${role}/${m.id}`).toContain(m.op)
        if (m.op !== 'studio') {
          const catalog = cloudModelById(m.id)
          expect(catalog, `${role}/${m.id}`).toBeDefined()
          expect(cloudModelSupportsOp(catalog!, m.op), `${role}/${m.id}`).toBe(true)
        }
      }
    }
  })

  it('jedes klassische Mitglied hat entweder einen Preis, oder der Notvorrat fuehrt wirklich keinen', () => {
    for (const role of ALL_ROLES) {
      for (const m of presetModels(role)) {
        if (STUDIO_MODELS[m.id] || m.op === 'studio') continue
        const seconds = m.kind === 'video' ? (videoDurations(m.id)[0] ?? 5) : undefined
        const params = m.kind === 'video' && role === 'animate'
          ? { frames: seconds! * 16, fps: 16 }
          : {}
        const ours = classicCredits(m.kind, m.id, m.op, params)
        if (ours === null) {
          // Kein Wiring-Fehler: dieses Mitglied traegt im Notvorrat wirklich
          // kein `credits`-Feld, erst die lebende Katalogantwort liefert es.
          expect(cloudModelById(m.id)?.credits, `${role}/${m.id}`).toBeUndefined()
        } else {
          expect(ours, `${role}/${m.id}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('eine laengere Sekunde kostet mehr, wenn der Katalog eine lange Rate fuehrt', () => {
    // Positivkontrolle fuer die Abbildung frames/fps auf runCredits: nimmt sie
    // die Dauer nicht an, bleibt der Preis gleich und der Fall faellt um. Der
    // Notvorrat fuehrt heute bei keinem klassischen Videomodell eine
    // gesonderte Langrate (nur `base`), deshalb steht hier ein synthetischer
    // Katalogeintrag statt eines echten Notvorrat-Modells, das den Fall gar
    // nicht ausloesen wuerde.
    const before = useCloudCatalogStore.getState().models
    useCloudCatalogStore.setState({
      models: [
        ...before,
        { id: 'p2-test-scaling-clip', label: 'Test scaling clip', kind: 'video', t2v: true, i2v: true, credits: { base: 1000, long: 3000 } },
      ],
    })
    try {
      const kurz = classicCredits('video', 'p2-test-scaling-clip', 'generate', { frames: 5 * 16, fps: 16 })
      const lang = classicCredits('video', 'p2-test-scaling-clip', 'generate', { frames: 8 * 16, fps: 16 })
      expect(kurz).not.toBeNull()
      expect(lang).not.toBeNull()
      expect(lang ?? 0).toBeGreaterThan(kurz ?? 0)
    } finally {
      useCloudCatalogStore.setState({ models: before })
    }
  })

  it('jedes Studio-Modell gehoert zu genau einer Rolle', () => {
    // Ein noch nicht gemessenes Modell (studio-contract.ts, unmeasuredHidden)
    // gehoert zu keiner, solange der Server es nicht fuer die Messung freigibt.
    for (const id of Object.keys(STUDIO_MODELS).filter((id) => STUDIO_MODELS[id].unmeasured)) {
      expect(ALL_ROLES.filter((r) => presetModels(r).some((m) => m.id === id)), id).toEqual([])
    }
    for (const id of Object.keys(STUDIO_MODELS).filter((id) => !STUDIO_MODELS[id].unmeasured)) {
      // Swap Character uses SCAIL 2 of Motion on purpose (SWAP_ROLES, as on
      // the web). The rule holds for every other role; a model that is only
      // in a swap role belongs to that one.
      const others = ALL_ROLES.filter((r) => !SWAP_ROLES.includes(r) && presetModels(r).some((m) => m.id === id))
      const roles = others.length ? others : ALL_ROLES.filter((r) => presetModels(r).some((m) => m.id === id))
      expect(roles, id).toHaveLength(1)
      expect(roleForModel(id), id).toBe(roles[0])
    }
  })

  it('eine Eingrenzung nennt nur Mitglieder der eigenen Rolle, und nie eine leere Liste', () => {
    // Ein Schritt darf seine Auswahl verkleinern, aber nicht erfinden: stuende
    // dort eine Id, die die Rolle nicht kennt, zeigte das Fenster eine leere
    // Auswahl und der Schritt waere nicht mehr zu starten.
    const eingegrenzt = CREATE_PRESETS.flatMap((p) => p.steps).filter((s) => s.models)
    expect(eingegrenzt.length).toBeGreaterThan(0)
    for (const step of eingegrenzt) {
      const rolle = presetModels(step.role).map((m) => m.id)
      expect(step.models!.length, step.title).toBeGreaterThan(0)
      for (const id of step.models!) expect(rolle, `${step.title}/${id}`).toContain(id)
      expect(step.models, step.title).toContain(step.model)
    }
  })

  it('eine Eingrenzung in einem freigegebenen Preset nennt nur offene Modelle', () => {
    // 19.09.2026: die Horrorschritte grenzen ein. Stuende dort ein gefilterter
    // Endpunkt, lehnte er die Szene ab und der Kunde haette trotzdem gezahlt.
    for (const preset of CREATE_PRESETS.filter((p) => p.adult)) {
      for (const step of preset.steps.filter((s) => s.models)) {
        const offen = presetModels(step.role, true).map((m) => m.id)
        for (const id of step.models!) expect(offen, `${preset.id}/${id}`).toContain(id)
      }
    }
  })

  it('jeder Preset-Schritt startet auf einem Modell seiner eigenen Rolle', () => {
    for (const preset of CREATE_PRESETS) {
      for (const step of preset.steps) {
        expect(presetModels(step.role).map((m) => m.id), `${preset.id}/${step.title}`).toContain(step.model)
      }
    }
  })

  it('die noetigen Eingaben eines Mitglieds sind eine Teilmenge dessen, was es liest', () => {
    for (const role of ALL_ROLES) {
      for (const m of presetModels(role)) {
        const reads = new Set(Object.values(roleInputs(role, m.id)))
        for (const key of requiredRoleInputs(role, m.id)) expect(reads, `${role}/${m.id}`).toContain(key)
      }
    }
  })

  it('genau die Rollen ohne Alternative zeigen keine Auswahl', () => {
    const ohne = ALL_ROLES.filter((r) => !roleHasChoice(r))
    expect(ohne.sort()).toEqual(['angles', 'presenter'])
  })
})
