import type { AppMode } from '../types/settings'

/**
 * Which chat model may stay selected under the current Local/Cloud switch.
 *
 * Lifted out of AppShell so it can be tested, because it is what lost the
 * user's pick across a restart (Befund 3 of the abnahme counter-check,
 * 2026-08-29: Qwen3 4B was active before the restart, and the picker came
 * back on Hermes). The pick was persisted and rehydrated correctly. The rule
 * then ran on mount against an EMPTY model list, could not find the pick in
 * it, called it out of mode and cleared it. The store's own auto-select then
 * put the first chat model in its place.
 *
 * An empty list is not evidence that a model is gone. It is the absence of
 * evidence, and this rule is re-run the moment the real list lands.
 */
export interface ModeCandidate {
  name: string
  type?: string
  provider?: string
}

export interface ModePick {
  /** Whether the caller has to write anything at all. */
  change: boolean
  /** What to write when it does. null clears the selection on purpose: a
   *  lu-cloud model left active in Local mode kept spending credits after the
   *  switch said Local (Discord 2026-08-09, helpslowlydying). */
  next: string | null
  /** True when `requested` is what landed, so the caller knows the request was
   *  answered and can drop it. False whenever the request was absent, not in
   *  the list yet, or not usable in this mode. */
  usedRequest: boolean
}

/** ComfyUI image/video checkpoints share the model list but are never a chat
 *  model. An unprefixed checkpoint name routes to Ollama and every send
 *  fails with model-not-found. */
function chatCapable(m: ModeCandidate): boolean {
  return m.type !== 'image' && m.type !== 'video'
}

export function pickForMode(
  activeModel: string | null,
  models: ModeCandidate[],
  appMode: AppMode,
  /**
   * The model the user asked for by name on the way into this mode, e.g. the
   * LU Cloud row they clicked in the local-mode picker. Nebenbefund 1 of the
   * R10 re-measure (2026-08-30): clicking "DeepSeek V3.2" landed on Kimi K3,
   * clicking "DeepSeek R1" landed on DeepSeek V4 Flash 0731. The rows carried
   * no identity at all, so every one of them merely opened the cloud gate and
   * the line below then handed out `models.find(wanted)`, the head of the
   * catalogue in whatever order `/v1/models` had answered in. Two clicks, two
   * different wrong models, and neither of them a fixed default.
   *
   * A named request wins over that fallback, and over nothing else: it still
   * has to be in the list and still has to be usable in this mode.
   */
  requested: string | null = null,
): ModePick {
  // Nothing to judge against. THE guard: without it, the mount-time run of
  // this rule wipes a perfectly good persisted pick.
  if (models.length === 0) return { change: false, next: activeModel, usedRequest: false }

  const wanted = (m: ModeCandidate) =>
    chatCapable(m) && (appMode === 'cloud' ? m.provider === 'lu-cloud' : m.provider !== 'lu-cloud')

  // Identity, never a position: the row the user pressed is named, and the
  // name is what is looked up here.
  const asked = requested ? models.find((m) => m.name === requested) : undefined
  if (asked && wanted(asked)) {
    return { change: activeModel !== asked.name, next: asked.name, usedRequest: true }
  }

  const current = activeModel ? models.find((m) => m.name === activeModel) : undefined
  if (current && wanted(current)) return { change: false, next: activeModel, usedRequest: false }

  const fallback = models.find(wanted)
  if (activeModel === null && !fallback) return { change: false, next: null, usedRequest: false }
  return { change: true, next: fallback ? fallback.name : null, usedRequest: false }
}

/**
 * Did the app replace the user's pick behind his back.
 *
 * Gegenprobe G1, 04.09.2026: der Testkunde nimmt den Provider LM Studio
 * wieder heraus. Das gewaehlte Modell gehoerte dazu, verschwindet also aus der
 * Liste, und die Regel oben greift zum ersten Eintrag, den sie findet. Zweimal
 * hintereinander war das eine kaputte GGUF-Datei. Die Models-Seite schrieb
 * ACTIVE daneben, der Waehlerknopf nannte sie, und auf Port 8127 lief nichts.
 * Kein Wort dazu stand irgendwo.
 *
 * Ein Moduswechsel zaehlt NICHT: den hat der Nutzer selbst umgelegt, der
 * Schalter steht sichtbar auf dem Schirm, und eine Zeile darueber waere Laerm.
 * Gemeint ist allein der Fall, in dem sich die Liste unter dem Nutzer bewegt
 * hat, ohne dass er den Waehler angefasst hat.
 *
 * `activeModel` muss dafuer da sein, und das ist keine Luecke, sondern die
 * Grenze dieser Regel: der Satz nennt beide Namen, und ohne den alten gibt es
 * keinen Satz. Der Fall, in dem die Wahl vorher schon geraeumt wurde, weil ein
 * fremdes Backend den lokalen Steckplatz uebernommen hat, wird deshalb dort
 * angesagt, wo der alte Name noch dasteht: in `dropDisplacedEnginePick`
 * (lib/builtin-slot-eviction), im selben Zug wie das Raeumen. Wer ihn hier
 * einzufangen versucht, kommt immer zu spaet.
 */
export function replacedBehindTheUsersBack(
  activeModel: string | null,
  pick: ModePick,
  modeFlipped: boolean,
): boolean {
  if (modeFlipped || !pick.change || pick.usedRequest) return false
  return !!activeModel && !!pick.next && pick.next !== activeModel
}
