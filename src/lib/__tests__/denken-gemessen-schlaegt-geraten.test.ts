import { describe, it, expect, beforeEach } from 'vitest'
import { isThinkingCompatible, markCannotThink, resetThinkingMeasurements } from '../model-compatibility'

/**
 * Was die Engine gesagt hat, schlaegt, was der Name vermuten laesst.
 *
 * Ein Persona-Lauf am 03.09.2026 protokollierte, dass JEDE Antwort zuerst eine
 * fehlgeschlagene Anfrage erzeugt:
 *
 *   POST /api/chat -> 400 {"error":"\"hf.co/DevQuasar/huihui-ai.Qwen3-4B-
 *   abliterated-GGUF:Q4_K_M\" does not support thinking"}
 *
 * und danach erst die erfolgreiche. Ueber jeder Antwort stand trotzdem
 * „Thinking".
 *
 * Die Ursache ist kein Fehler, sondern eine Vermutung, die nie korrigiert
 * wurde: `isThinkingCompatible` entscheidet am Modellnamen, und „Qwen3" ist
 * eine Familie, die denken kann — dieses eine GGUF aber nicht, weil ihm die
 * Vorlage dafuer fehlt. Der Name ist die richtige erste Antwort (synchron, ohne
 * Netz, fuer die Oberflaeche). Falsch war nur, dass die zweite, bessere Antwort
 * — die der Engine — folgenlos blieb und beim naechsten Zug wieder dieselbe
 * verlorene Anfrage kostete.
 */

beforeEach(() => resetThinkingMeasurements())

describe('gemessen schlaegt geraten', () => {
  it('ohne Messung entscheidet weiterhin der Name', () => {
    expect(isThinkingCompatible('qwen3:4b')).toBe(true)
    expect(isThinkingCompatible('llama3.2:3b')).toBe(false)
  })

  it('nach der Absage der Engine gilt die Absage', () => {
    const modell = 'hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF:Q4_K_M'
    expect(isThinkingCompatible(modell)).toBe(true)
    markCannotThink(modell)
    expect(isThinkingCompatible(modell)).toBe(false)
  })

  it('die Absage gilt nur fuer das Modell, das sie gegeben hat', () => {
    // Sonst nimmt ein einziges kaputtes GGUF der ganzen Familie das Denken weg.
    markCannotThink('hf.co/DevQuasar/huihui-ai.Qwen3-4B-abliterated-GGUF:Q4_K_M')
    expect(isThinkingCompatible('qwen3:4b')).toBe(true)
  })

  it('vergisst nichts zwischen zwei Fragen', () => {
    markCannotThink('qwen3:8b')
    expect(isThinkingCompatible('qwen3:8b')).toBe(false)
    expect(isThinkingCompatible('qwen3:8b')).toBe(false)
  })

  it('nimmt einen leeren Namen nicht als Modell auf', () => {
    markCannotThink('')
    markCannotThink(null)
    expect(isThinkingCompatible('qwen3:4b')).toBe(true)
  })
})
