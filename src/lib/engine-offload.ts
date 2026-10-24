/**
 * Where the LU Engine actually computes, said out loud.
 *
 * Commit ccdc2d14 (3.0.0, bugs u and a) taught the engine two things: to
 * measure free graphics memory and buy a layer count with it instead of
 * demanding all of them, and to run the SECOND start attempt on the processor
 * when the first one died with layers on the card. Both are real repairs and
 * neither had a surface. `start_bundled_engine` answered `cpuOnly: true` once,
 * in the return value of the call that started it, and every caller read
 * `.port` out of that object and dropped the rest on the floor. The layer
 * count existed only inside the argv and the log file.
 *
 * So a user whose card could not hold the model got exactly what the reports
 * described before the fix, minus the crash: an engine that looks ordinary,
 * says nothing, and answers at a tenth of the speed. "Why is it suddenly slow"
 * had no answer anywhere in the window.
 *
 * Two statements, because the two facts have different lifetimes:
 *
 *   - the fallback is an EVENT. It happened at a moment, to this engine, and
 *     the user has something to do about it (read the log, close whatever is
 *     holding the card, pick a smaller model). It goes to the standing line
 *     above the composer, once per engine.
 *   - the layer count is a CONDITION. It stays true for as long as the process
 *     runs, so it belongs where the app already says which model, which
 *     context and which port: the Built-in Engine panel in Settings.
 *
 * Quiet tone for both. lib/hinweis.ts allows exactly two, and this is not an
 * error: the engine is serving, the chat works, it is slower than it could be.
 */

import { useUIStore } from '../stores/uiStore'
import { useLuEngineSwitchStore } from '../stores/luEngineSwitchStore'

/** What a `bundled_engine_status` answer says about offload. */
export interface EngineOffloadStatus {
  running?: boolean
  port?: number | null
  model_path?: string | null
  /** The app took the graphics card away by itself after a start died. NOT a
   *  GPU Layers of 0 that the user typed into Settings. */
  cpuOnly?: boolean
  /** The `-ngl` the process really carries, null when it asked for all of
   *  them. Rust withholds the 999 sentinel rather than making every surface
   *  know what it means (`gpu_layers_reported`). */
  gpuLayers?: number | null
  /** The engine's actual argv requests its fitter; the final count is unknown. */
  gpuLayerMode?: 'auto' | 'all' | 'explicit' | null
  /** Bug a: the sentence the start-time sanity probe left on this process
   *  (restarted without Flash Attention, restarted on the processor, or
   *  unreadable on the processor too). Written in Rust, shown as it is. The
   *  flash attention rung keeps the card, so this can be set with `cpuOnly`
   *  false and a real layer count. */
  sanityNote?: string | null
  /** Why this model came up WITHOUT its image part although one is
   *  installed: the graphics memory had no room for it next to the model, or
   *  the engine refused the part (engine.rs IMAGE_PART_NO_ROOM_NOTE and
   *  IMAGE_PART_REFUSED_NOTE). Written in Rust, shown as it is. Null on every
   *  start that loaded the part, and on a model that has none. */
  imageNote?: string | null
}

/** The sentence the standing line carries after a fallback. */
export const ENGINE_CPU_ONLY_NOTE =
  'Running on the CPU. The GPU start failed; see the log file in Settings > Troubleshoot.'

/**
 * The clause the engine-details line adds, or null when there is nothing to
 * add.
 *
 * Null is the ordinary answer: a card with room, and a machine nothing could
 * measure, both ask for every layer, and a line reading "GPU layers: 999"
 * would be printing llama.cpp's sentinel at a person.
 */
export function engineOffloadLine(status: EngineOffloadStatus | null | undefined): string | null {
  if (!status?.running) return null
  // A zero the app chose is not the same sentence as a zero the user typed, so
  // the fallback is named before the number is. Two ways the app chooses it:
  // the first start died with layers on the card, or the card came up and
  // answered the sanity probe in question marks (bug a).
  if (status.cpuOnly) {
    return status.sanityNote ? 'GPU layers: 0, the GPU answered unreadably' : 'GPU layers: 0, the GPU start failed'
  }
  if (status.gpuLayerMode === 'auto') return 'GPU layers: automatic (engine fit)'
  const layers = status.gpuLayers
  if (typeof layers !== 'number' || !Number.isInteger(layers) || layers < 0) return null
  return `GPU layers: ${layers}`
}

/**
 * Which engine a fallback note would be about, or null when there is none.
 *
 * Port and model together: a restart onto another port, or a swap to another
 * model, is a new engine and deserves to be told about again. The same process
 * polled every three seconds is not.
 */
export function engineCpuFallbackKey(status: EngineOffloadStatus | null | undefined): string | null {
  if (!status?.running) return null
  if (!status.cpuOnly && !status.sanityNote && !status.imageNote) return null
  // The sentence is part of the key: an engine that was first healed without
  // Flash Attention and then, on the next pass, moved to the processor has
  // something new to say about the same port and model.
  return `${status.port ?? '?'}|${status.model_path ?? '?'}|${status.sanityNote ?? ''}|${status.imageNote ?? ''}`
}

/** The sentence the standing line carries for this status. */
export function engineStandingNote(status: EngineOffloadStatus): string {
  // Rust wrote the sanity sentence with the cause in it, so it wins over the
  // generic fallback line whenever it is there. The image note is about
  // something else (what the model can see, not where it computes), so it
  // stands beside whichever of the two applies and alone when neither does.
  const where = status.sanityNote || (status.cpuOnly ? ENGINE_CPU_ONLY_NOTE : null)
  return [where, status.imageNote].filter(Boolean).join(' ')
}

/**
 * Die Ansicht, die die stehende Zeile OHNE Zutun als Satz zeigt.
 *
 * Bis zum 21.09.2026 waren es zwei, `chat` und `models`, und beide zeichneten
 * dieselbe `LuEngineSwitchBar`. Im Chat haengt die Zeile seither im
 * Modellmenue, und ohne Klick ist dort nur der Punkt am Waehlerknopf zu sehen.
 * Die Models-Seite zeichnet die Leiste unveraendert.
 */
export const VIEW_WITH_THE_ENGINE_NOTE = 'models'

/**
 * Ist der Satz gerade als SATZ zu sehen?
 *
 * Genau das, woran die Lesezeit haengt. Zwei Wege fuehren zu ja: die
 * Models-Seite zeigt die volle Leiste von selbst, oder jemand hat im Chat das
 * Modellmenue mit dieser Zeile aufgeklappt (`gesehen` im Speicher, gesetzt von
 * `ModelSelector`). Ein Punkt allein zaehlt nicht: er sagt, dass es etwas zu
 * lesen gibt, er ist nicht das Gelesene.
 *
 * Lives here, in the leaf, because two callers need it and one of them
 * (api/lu-engine-switch) cannot be imported from the status path without a
 * cycle. It is the same answer either way and must not become two.
 */
export function dieZeileIstZuSehen(): boolean {
  if (useUIStore.getState().currentView === VIEW_WITH_THE_ENGINE_NOTE) return true
  return useLuEngineSwitchStore.getState().gesehen
}

/**
 * How long a note waits for a reader before it gives up.
 *
 * The engine status is polled from Settings, which does NOT draw the standing
 * line, so a note announced from there would spend its twelve seconds on a
 * page that cannot show it. Generous enough for a round through Settings,
 * short enough that the sentence still describes something the user just did.
 */
export const ENGINE_NOTE_UNSEEN_HOLD_MS = 5 * 60_000

/** The last engine a fallback was announced for, so a poll cannot repeat it. */
let angesagt: string | null = null

/** The image note of the last status, so a change can be told to the lists. */
let lastImageNote: string | null = null

/** Test-only: forget what was said. */
export function __resetEngineCpuFallbackNote(): void {
  angesagt = null
  lastImageNote = null
}

/**
 * Keep "can see" true in every model list.
 *
 * Whether the loaded model sees is decided at its start (with or without the
 * image part), and the lists learned it when they were last fetched. A start
 * that left the part out, or a later one that took it again, changes the
 * answer under the same model name, so the lists are asked to fetch again.
 * Only on a change: the status is polled every few seconds.
 */
function noteWhatTheModelSees(status: EngineOffloadStatus | null | undefined): void {
  const now = status?.running ? status.imageNote ?? null : null
  if (now === lastImageNote) return
  lastImageNote = now
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('lu-models-refresh'))
}

/**
 * Say that this engine ended up on the processor, once.
 *
 * Called wherever a status answer arrives: the poll behind Settings and the
 * models view, and the pre-send probe that runs in the chat. Cheap and quiet
 * when there is nothing to say, which is almost always.
 */
export function announceEngineCpuFallback(status: EngineOffloadStatus | null | undefined): void {
  noteWhatTheModelSees(status)
  const key = engineCpuFallbackKey(status)
  if (key === null) {
    // The engine came back on the card, or stopped. The next fallback is a new
    // fact and has to be allowed to speak.
    angesagt = null
    return
  }
  if (angesagt === key) return
  angesagt = key
  const ende = Date.now() + ENGINE_NOTE_UNSEEN_HOLD_MS
  useLuEngineSwitchStore.getState().announce(
    engineStandingNote(status as EngineOffloadStatus),
    'info',
    () => Date.now() < ende && !dieZeileIstZuSehen(),
  )
}
