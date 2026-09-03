import { describe, it, expect } from 'vitest'
import { buildCompactPrompt, parseCompactSummary } from '../compact-summary'

/**
 * Haelt die Verdichtung die Sprache des Gespraechs und die Werte woertlich?
 *
 * Am 03.09.2026 fuehrte ein Persona-Lauf ein durchgehend deutsches Gespraech
 * und bekam eine englische Zusammenfassung zurueck, in der „47,3 Millionen
 * Euro" zu „47.3 million euros" geworden war und die Uhrzeit „9:40 Uhr" ganz
 * fehlte — waehrend das Modell danach behauptete, alles sei „vollstaendig und
 * wortgenau". Daraufhin sind drei Anweisungen in den Prompt gekommen.
 *
 * Dass die Saetze DASTEHEN, prueft `compact-summary.test.ts`. Ob sie WIRKEN,
 * kann nur ein echtes Modell zeigen — und das haengt am Netz und an einem
 * laufenden Ollama, gehoert also nicht ins normale Gate:
 *
 *   LIVE_COMPACT=1 npx vitest run src/lib/__tests__/compact-sprache.live.test.ts
 *
 * Ein Sprachmodell ist nicht deterministisch. Diese Pruefung ist deshalb
 * bewusst grob: sie fragt nicht nach einem Wortlaut, sondern danach, ob die
 * drei Werte ueberhaupt noch dastehen und ob die Antwort deutsch ist.
 */

const LIVE = process.env.LIVE_COMPACT === '1'
const MODELL = process.env.LIVE_COMPACT_MODEL ?? 'hf.co/unsloth/Qwen3.5-9B-GGUF:Q4_K_M'

const GESPRAECH = [
  {
    role: 'user' as const,
    content:
      'Bitte merk dir fuer den ganzen Chat fuenf Angaben: Interviewpartnerin ist Dr. Henrike Balzer, ' +
      'Institut fuer Verkehrsforschung Kassel, Termin am 14. November 2026 um 9:40 Uhr, ' +
      'Foerdersumme 47,3 Millionen Euro, Aktenzeichen VG-2024/8817.',
  },
  { role: 'assistant' as const, content: 'Notiert: Dr. Henrike Balzer, Institut fuer Verkehrsforschung Kassel, 14. November 2026 um 9:40 Uhr, 47,3 Millionen Euro, VG-2024/8817.' },
  { role: 'user' as const, content: 'Gut. Erklaer mir jetzt bitte, wie Moorrenaturierung auf entwaesserten Niedermoorstandorten funktioniert.' },
  { role: 'assistant' as const, content: 'Bei entwaesserten Niedermooren wird der Wasserstand angehoben, damit die Torfzehrung stoppt. Entscheidend sind Grabenverschluesse, die Regelung der Vorflut und die Wahl der Folgenutzung, etwa Paludikultur mit Rohrkolben oder Schilf.' },
  { role: 'user' as const, content: 'Und was kostet das je Hektar ungefaehr?' },
  { role: 'assistant' as const, content: 'Je nach Ausgangslage liegen die Herstellungskosten meist zwischen 3.000 und 12.000 Euro je Hektar, ohne Flaechenerwerb.' },
]

async function zusammenfassen(prompt: string): Promise<string> {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODELL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { temperature: 0 },
    }),
  })
  const data = (await res.json()) as { message?: { content?: string }; error?: string }
  if (data.error) throw new Error(data.error)
  return data.message?.content ?? ''
}

describe.runIf(LIVE)('Verdichtung gegen ein echtes Modell', () => {
  it(
    'bleibt deutsch und laesst die Werte stehen',
    async () => {
      const antwort = await zusammenfassen(buildCompactPrompt(GESPRAECH))
      const s = parseCompactSummary(antwort)
      const alles = [s.task, s.requests, s.progress, s.decisions, s.facts, s.open, s.rest].join('\n')

      // Die drei Werte, die der Lauf verloren oder umgeschrieben hat.
      expect(alles).toContain('47,3 Millionen Euro')
      expect(alles).toMatch(/9[:.]40/)
      expect(alles).toContain('VG-2024/8817')
      // Und die Umschreibung, die dabei entstand, darf gerade NICHT dastehen.
      expect(alles).not.toMatch(/47\.3 million/i)

      // Deutsch, grob gemessen: deutsche Funktionswoerter kommen haeufiger vor
      // als englische. Kein Wortlaut, nur die Sprache.
      const deutsch = (alles.match(/\b(der|die|das|und|nicht|wurde|soll|ist|dem|den|fuer|für)\b/gi) ?? []).length
      const englisch = (alles.match(/\b(the|and|was|should|is|for|with|that)\b/gi) ?? []).length
      expect(deutsch, `deutsch=${deutsch} englisch=${englisch}`).toBeGreaterThan(englisch)
    },
    900_000,
  )
})
