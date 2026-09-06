import type { CreateBackend, CreateIntent } from '../../../stores/createStore'
import { videoLaneModels } from '../../../api/comfyui'
import type { IntentMeta } from './intents'

/**
 * Wann die Buehne statt eines Motivs die Einrichtungskarte zeigt.
 *
 * Die Regel stand bis 2.6.7 nur inline in `Stage.tsx`. Sie steht jetzt hier,
 * weil ZWEI Stellen sie brauchen: die Buehne, die die Karte zeigt, und die
 * Kopfzeile in `CreateExperimental.tsx`, die ihren roten Balken zurueckhalten
 * muss, solange die Karte dieselbe Lage bereits vollstaendig erklaert.
 *
 * Der Befund dahinter (nachgestellt am 01.09.2026, Chromium 149): Balken und
 * Karte standen 40 px uebereinander und sagten dasselbe zweimal, mit
 * unterschiedlichem Ausgang.
 *
 *   Mac    Balken: „The local image engine is not set up on this Mac yet —
 *                   a one-time setup is needed before local generation works."
 *          Karte:  „Local image generation needs a one-time setup" + Knopf
 *          → derselbe Satz zweimal, einmal als roter Alarm mit Warndreieck,
 *            einmal als ruhiges Angebot mit „Download & install".
 *
 *   Windows Balken: „ComfyUI is not running. Start it from Settings or wait
 *                   for auto-start."
 *          Karte:  „This sets up everything for a fully local run: ComfyUI
 *                   itself if it's missing, plus …" + Knopf
 *          → hier zeigen die beiden AUSEINANDER: der Balken schickt in die
 *            Einstellungen oder ans Warten, die Karte direkt darunter hat den
 *            Knopf, der es erledigt.
 *
 * Beide Texte liegen ausserhalb dieses Pakets (`hooks/useCreate.ts` bzw. die
 * COPY-Tabellen in `Stage.tsx`), und keiner von beiden ist fuer sich genommen
 * falsch — falsch ist, dass sie gleichzeitig sprechen. Deshalb wird hier nicht
 * umformuliert, sondern entschieden, WER spricht: solange die Karte da ist,
 * gehoert ihr die Buehne allein. Echte Laufzeitfehler (`error`, mit
 * Schliesskreuz) bleiben davon unberuehrt — sie beschreiben etwas, das die
 * Karte nicht erklaert.
 *
 * Rein und ohne React, damit die Regel genau einmal existiert und geprueft
 * werden kann, ohne einen Renderer zu brauchen.
 */
export interface StageGateInput {
  backend: CreateBackend
  /** `meta.requiresModels` der aktuellen Spur (undefined = braucht keine). */
  requiresModels: IntentMeta['requiresModels']
  /** MLX-Mac: welche Gattungen dort nicht eingerichtet sind. null = kein Mac. */
  mlxMissing: { image: boolean; video: boolean } | null
  /** ComfyUI-Sonde: null solange sie laeuft. */
  connected: boolean | null
  modelsLoaded: boolean
  /** Wie viele Modelle diese Spur tatsaechlich anbieten kann. */
  laneModelCount: number
}

/**
 * `true`, wenn die Buehne fuer diese Spur die Einrichtungskarte zeigt.
 *
 * Die drei Faelle, unveraendert aus Stage.tsx uebernommen:
 *   • Mac (mlxMissing gesetzt): die Gattung ist dort nicht eingerichtet.
 *   • Windows/Linux, ComfyUI nicht erreichbar: derselbe Knopf installiert es.
 *   • Windows/Linux, ComfyUI da, Sonde fertig, aber die Spur hat kein Modell.
 * `connected === null` (Sonde laeuft noch) oeffnet nichts — sonst blitzte die
 * Karte bei jedem Start kurz auf.
 */
export function stageShowsSetupCard(i: StageGateInput): boolean {
  const macMissing =
    i.backend === 'local' && !!i.mlxMissing &&
    (i.requiresModels === 'image' ? i.mlxMissing.image
      : i.requiresModels === 'video' ? i.mlxMissing.video
        : false)
  if (macMissing) return true
  return (
    i.mlxMissing === null && i.backend === 'local' && !!i.requiresModels && (
      i.connected === false ||
      (i.connected === true && i.modelsLoaded && i.laneModelCount === 0)
    )
  )
}

/**
 * Wie viele Modelle die Spur dieses Intents anbieten kann.
 *
 * Steht hier und nicht in den Komponenten, weil BEIDE Aufrufer von
 * `stageShowsSetupCard` dieselbe Zahl brauchen und eine zweite Abschrift der
 * Zuordnung genau die Drift waere, gegen die die Funktion daneben gebaut ist.
 *
 * Die Videospur zaehlt ueber `videoLaneModels` und nicht ueber die rohe Liste:
 * SVD und FramePack koennen nur Bild-zu-Video, eine Kiste mit SVD als einzigem
 * Videomodell kam so durch eine blosse Laengenpruefung und bekam nie das
 * Starterpaket angeboten, waehrend die T2V-Auswahl daneben „No matches" zeigte
 * (David 2026-08-01).
 */
export function laneModelCount(
  intent: CreateIntent,
  requiresModels: IntentMeta['requiresModels'],
  lists: {
    image: unknown[]
    video: unknown[]
    audio: unknown[]
    lipsync: unknown[]
    motion: unknown[]
  },
): number {
  if (!requiresModels) return 0
  if (requiresModels === 'video') return videoLaneModels(lists.video as never, intent).length
  return lists[requiresModels].length
}
