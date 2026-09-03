import { describe, it, expect, beforeEach } from 'vitest'
import { useGenerationStore, runLaneOf } from '../generationStore'

describe('generationStore — per-conversation generating flags', () => {
  beforeEach(() => {
    useGenerationStore.setState({ generating: {} })
  })

  it('starts empty', () => {
    expect(useGenerationStore.getState().generating).toEqual({})
  })

  it('marks a conversation generating and clears it', () => {
    const { setGenerating } = useGenerationStore.getState()
    setGenerating('chat-a', true)
    expect(useGenerationStore.getState().generating['chat-a']).toBe(true)
    setGenerating('chat-a', false)
    expect(useGenerationStore.getState().generating['chat-a']).toBeUndefined()
  })

  it('tracks two conversations independently — the bug fix', () => {
    const { setGenerating } = useGenerationStore.getState()
    // Generating in B must NOT mark A as generating (the typing-indicator bug).
    setGenerating('chat-b', true)
    expect(useGenerationStore.getState().generating['chat-b']).toBe(true)
    expect(useGenerationStore.getState().generating['chat-a']).toBeUndefined()
  })

  it('ignores a null/undefined conversation id', () => {
    const { setGenerating } = useGenerationStore.getState()
    setGenerating(null, true)
    setGenerating(undefined, true)
    expect(useGenerationStore.getState().generating).toEqual({})
  })

  it('is a no-op (same object reference) when the flag is already set', () => {
    const { setGenerating } = useGenerationStore.getState()
    setGenerating('chat-a', true)
    const ref1 = useGenerationStore.getState().generating
    setGenerating('chat-a', true) // already true → must not replace the map
    expect(useGenerationStore.getState().generating).toBe(ref1)
  })

  it('clearing an already-idle conversation is a no-op', () => {
    const { setGenerating } = useGenerationStore.getState()
    const ref1 = useGenerationStore.getState().generating
    setGenerating('never-started', false)
    expect(useGenerationStore.getState().generating).toBe(ref1)
  })
})

/**
 * Die Spur je Lauf: welcher Lauf rechnet WO.
 *
 * `generating` sagt "hier fliessen gerade Token", und das ist nicht dieselbe
 * Frage. Ein Lauf, der auf die Grafikkarte wartet, hat noch kein einziges
 * Token gesehen und ist trotzdem gebucht: der Nutzer hat gesendet, der
 * Stop-Knopf hat etwas abzubrechen, und die Oberflaeche muss den Unterschied
 * zwischen "laeuft in der Wolke" und "wartet auf deine Karte" ZEIGEN koennen,
 * sonst ist er fuer den Kunden Willkuer.
 *
 * Deshalb ein eigenes Verzeichnis und keine zweite Fahne: hier steht die
 * SPUR, dort steht der Fluss. Keins von beiden laesst sich aus dem anderen
 * ableiten.
 */
describe('das Laufverzeichnis traegt die Spur, nicht den Fluss', () => {
  beforeEach(() => {
    useGenerationStore.setState({ generating: {}, aborters: {}, runs: {} })
  })

  it('startet leer', () => {
    expect(useGenerationStore.getState().runs).toEqual({})
  })

  it('bucht einen Lauf mit seiner Spur', () => {
    useGenerationStore.getState().bookRun('chat-a', 'cloud')
    const run = useGenerationStore.getState().runs['chat-a']
    expect(run?.conversationId).toBe('chat-a')
    expect(run?.lane).toBe('cloud')
    expect(typeof run?.bookedAt).toBe('number')
  })

  it('zwei Gespraeche, zwei Spuren, nebeneinander', () => {
    // Der ganze Zweck: cloud und local sind gleichzeitig offen, und die
    // Oberflaeche kann jedem Chat ansehen, worauf er wartet.
    useGenerationStore.getState().bookRun('chat-a', 'cloud')
    useGenerationStore.getState().bookRun('chat-b', 'local')
    expect(runLaneOf('chat-a')).toBe('cloud')
    expect(runLaneOf('chat-b')).toBe('local')
  })

  it('ein gebuchter Lauf ist noch kein fliessender', () => {
    // Der Wartende. Kein generating, trotzdem gebucht.
    useGenerationStore.getState().bookRun('chat-a', 'local')
    expect(useGenerationStore.getState().generating['chat-a']).toBeUndefined()
    expect(useGenerationStore.getState().runs['chat-a']).toBeDefined()
  })

  it('eine zweite Buchung behaelt den urspruenglichen Zeitpunkt', () => {
    // Sonst faengt "wartet seit" bei jeder Nachfrage von vorn an, und ein
    // Lauf, der lange steht, sieht aus wie einer, der gerade erst kam.
    useGenerationStore.getState().bookRun('chat-a', 'local')
    const zuerst = useGenerationStore.getState().runs['chat-a']?.bookedAt
    useGenerationStore.getState().bookRun('chat-a', 'local')
    expect(useGenerationStore.getState().runs['chat-a']?.bookedAt).toBe(zuerst)
  })

  it('endRun raeumt den Eintrag weg', () => {
    useGenerationStore.getState().bookRun('chat-a', 'local')
    useGenerationStore.getState().endRun('chat-a')
    expect(useGenerationStore.getState().runs['chat-a']).toBeUndefined()
    expect(runLaneOf('chat-a')).toBeUndefined()
  })

  it('endRun auf einen unbekannten Lauf ist ein Nichts, kein Neuschreiben', () => {
    const ref = useGenerationStore.getState().runs
    useGenerationStore.getState().endRun('nie-gebucht')
    expect(useGenerationStore.getState().runs).toBe(ref)
  })

  it('Abbrechen loescht den Eintrag mit', () => {
    // Sonst bliebe an einem abgebrochenen Chat das Plaettchen "wartet auf die
    // Grafikkarte" stehen, fuer einen Lauf, den es nicht mehr gibt.
    useGenerationStore.getState().bookRun('chat-a', 'local')
    useGenerationStore.getState().setGenerating('chat-a', true)
    useGenerationStore.getState().abortConversation('chat-a')
    expect(useGenerationStore.getState().runs['chat-a']).toBeUndefined()
    expect(useGenerationStore.getState().generating['chat-a']).toBeUndefined()
  })

  it('GEGENPROBE: ohne Kennung wird nichts gebucht und nichts geraeumt', () => {
    const ref = useGenerationStore.getState().runs
    useGenerationStore.getState().bookRun(null, 'local')
    useGenerationStore.getState().bookRun(undefined, 'cloud')
    useGenerationStore.getState().endRun(null)
    expect(useGenerationStore.getState().runs).toBe(ref)
    expect(runLaneOf(null)).toBeUndefined()
    expect(runLaneOf(undefined)).toBeUndefined()
  })
})
