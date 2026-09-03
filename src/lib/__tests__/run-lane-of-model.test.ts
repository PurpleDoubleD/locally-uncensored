/**
 * Welche Spur ein Modellname bedeutet.
 *
 * Der Kern ist eine Behauptung, die man ueberpruefen muss und nicht glauben
 * darf: DER SLOT IST NICHT DIE SPUR. Zwei der vier Slots haengen an einer
 * Adresse, und bei beiden gibt es einen Fall, in dem die naheliegende Antwort
 * falsch ist:
 *
 *   - `ollama::` auf einem anderen Rechner ist FREMDES VRAM.
 *   - `openai::` in LM Studio auf localhost ist EIGENES VRAM, obwohl der Slot
 *     nach der Fremd-API klingt und obwohl `managed` dort false ist.
 *
 * Der zweite Fall ist der teure. Er sieht in jeder Zusammenfassung wie cloud
 * aus, laeuft aber auf derselben Karte wie ein lokales Ollama daneben. Wer
 * ihn falsch einordnet, hat die Warteschlange fuer genau die Paarung
 * abgeschaltet, gegen die sie gebaut wurde.
 *
 * Lauf: npx vitest run src/lib/__tests__/run-lane-of-model.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { resolve } from 'node:path'

import { laneOf, laneOfProvider, currentLaneFacts, type LaneFacts } from '../run-lane-of-model'
import { isLocalModelByName } from '../../api/agents/model-locality'
import { useProviderStore } from '../../stores/providerStore'
import { setOllamaBase } from '../../api/backend'
import { quelldateien, quelltext } from '../../components/__tests__/quelldateien'

/** Beide Tatsachen falsch: nichts laeuft hier. */
const NICHTS: LaneFacts = { openaiSlotIsLocal: false, ollamaBaseIsLocal: false }
/** Beide wahr: eigener Motor und eigenes Ollama. */
const ALLES: LaneFacts = { openaiSlotIsLocal: true, ollamaBaseIsLocal: true }

describe('die Regel, ohne Store', () => {
  it('lu-cloud und anthropic sind immer cloud, egal was daneben lokal laeuft', () => {
    for (const facts of [NICHTS, ALLES]) {
      expect(laneOfProvider('lu-cloud', facts)).toBe('cloud')
      expect(laneOfProvider('anthropic', facts)).toBe('cloud')
      expect(laneOf('lu-cloud::glm-5.3', facts)).toBe('cloud')
      expect(laneOf('anthropic::claude-sonnet-4-20250514', facts)).toBe('cloud')
    }
  })

  it('der openai-Slot haengt an der Adresse, nicht am Namen', () => {
    expect(laneOf('openai::gpt-oss-20b', { ...NICHTS, openaiSlotIsLocal: true })).toBe('local')
    expect(laneOf('openai::gpt-4o', { ...ALLES, openaiSlotIsLocal: false })).toBe('cloud')
  })

  it('der ollama-Slot ebenso: ein Ollama im Netz ist fremdes VRAM', () => {
    expect(laneOf('ollama::qwen3:8b', { ...NICHTS, ollamaBaseIsLocal: true })).toBe('local')
    expect(laneOf('ollama::qwen3:8b', { ...ALLES, ollamaBaseIsLocal: false })).toBe('cloud')
  })

  it('ein Name ohne Praefix ist Altbestand und heisst Ollama', () => {
    // Dieselbe Auslegung wie im ganzen Haus (model-name.ts). Faellt sie hier
    // anders aus, bekaeme jeder alte gespeicherte Modellname die falsche Spur.
    expect(laneOf('llama3.1:8b', { ...NICHTS, ollamaBaseIsLocal: true })).toBe('local')
    expect(laneOf('llama3.1:8b', { ...ALLES, ollamaBaseIsLocal: false })).toBe('cloud')
  })

  it('GEGENPROBE: ein unbekannter Praefix startet sofort, statt einen Platz zu belegen', () => {
    // Praefixe kommen aus gespeicherten Zeichenketten, nicht aus einem
    // geprueften Feld. Ein Unbekannter in der lokalen Schlange waere ein
    // Platz, den womoeglich niemand je zurueckgibt.
    expect(laneOf('groq::llama-3.3-70b', ALLES)).toBe('cloud')
    expect(laneOf('', ALLES)).toBe(laneOf('ollama::x', ALLES))
  })
})

describe('die Tatsachen, am echten Speicher gelesen', () => {
  beforeEach(() => {
    setOllamaBase('http://localhost:11434')
    useProviderStore.setState((s) => ({
      providers: {
        ...s.providers,
        openai: {
          id: 'openai', name: 'Built-in Engine', enabled: true,
          baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', isLocal: true, managed: true,
        },
      },
    }))
  })

  it('der mitgelieferte Motor ist lokal', () => {
    expect(currentLaneFacts().openaiSlotIsLocal).toBe(true)
    expect(laneOf('openai::gpt-oss-20b', currentLaneFacts())).toBe('local')
  })

  it('LM STUDIO AUF LOCALHOST IST LOKAL, obwohl managed false ist', () => {
    // Der teure Fall. `isManagedBuiltinSlot()` sagt hier false; wer die Frage
    // allein daran haengt, laesst LM Studio ohne Warteschlange neben einem
    // lokalen Ollama auf dieselbe Karte los. Die Kombination stammt nicht aus
    // der Luft: Onboarding.tsx:178 schreibt genau sie.
    useProviderStore.setState((s) => ({
      providers: {
        ...s.providers,
        openai: {
          id: 'openai', name: 'LM Studio', enabled: true,
          baseUrl: 'http://localhost:1234/v1', apiKey: '', isLocal: true, managed: false,
        },
      },
    }))
    expect(currentLaneFacts().openaiSlotIsLocal).toBe(true)
    expect(laneOf('openai::llama-3.3-70b', currentLaneFacts())).toBe('local')
  })

  it('die echte OpenAI-API ist cloud', () => {
    useProviderStore.setState((s) => ({
      providers: {
        ...s.providers,
        openai: {
          id: 'openai', name: 'OpenAI', enabled: true,
          baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x', isLocal: false, managed: false,
        },
      },
    }))
    expect(currentLaneFacts().openaiSlotIsLocal).toBe(false)
    expect(laneOf('openai::gpt-4o', currentLaneFacts())).toBe('cloud')
  })

  it('GEGENPROBE: der Merker isLocal entscheidet NICHT, die Adresse tut es', () => {
    // Ein LM Studio, das auf einen Rechner im Netz zeigt, behaelt isLocal:
    // true. Es rechnet trotzdem auf fremdem VRAM.
    useProviderStore.setState((s) => ({
      providers: {
        ...s.providers,
        openai: {
          id: 'openai', name: 'LM Studio', enabled: true,
          baseUrl: 'http://192.168.0.54:1234/v1', apiKey: '', isLocal: true, managed: false,
        },
      },
    }))
    expect(currentLaneFacts().openaiSlotIsLocal).toBe(false)
    expect(laneOf('openai::llama-3.3-70b', currentLaneFacts())).toBe('cloud')
  })

  it('ein Ollama im Netz ist cloud, eines auf 127.0.0.1 nicht', () => {
    setOllamaBase('http://192.168.0.54:11434')
    expect(currentLaneFacts().ollamaBaseIsLocal).toBe(false)
    expect(laneOf('ollama::qwen3:8b', currentLaneFacts())).toBe('cloud')

    setOllamaBase('http://127.0.0.1:11434')
    expect(currentLaneFacts().ollamaBaseIsLocal).toBe(true)
    expect(laneOf('ollama::qwen3:8b', currentLaneFacts())).toBe('local')
  })
})

describe('DER UNTERSCHIED ZUR VERTRAULICHKEITSFRAGE', () => {
  it('ein Ollama im Netz: privat ja, eigenes VRAM nein', () => {
    // Die beiden Fragen klingen gleich und haben hier verschiedene Antworten.
    // Wer sie zusammenlegt, und das sieht wie Aufraeumen aus, macht eine
    // von beiden falsch. Der Fall steht deshalb als Zahlenpaar da und nicht
    // nur als Kommentar.
    setOllamaBase('http://192.168.0.54:11434')
    expect(isLocalModelByName('ollama::qwen3:8b')).toBe(true)
    expect(laneOf('ollama::qwen3:8b', currentLaneFacts())).toBe('cloud')
  })

  it('GEGENPROBE: auf localhost sind sich beide einig', () => {
    setOllamaBase('http://localhost:11434')
    expect(isLocalModelByName('ollama::qwen3:8b')).toBe(true)
    expect(laneOf('ollama::qwen3:8b', currentLaneFacts())).toBe('local')
  })
})

// ── Was NICHT gefragt werden darf ────────────────────────────────────────
const SRC = resolve(__dirname, '..', '..')
const DATEIEN = quelldateien(resolve(SRC, 'lib'), { endungen: /\.ts$/, relativZu: SRC })

const QUELLE = quelltext(DATEIEN, 'lib/run-lane-of-model.ts')

/**
 * Der Quelltext OHNE Kommentare.
 *
 * Notwendig, weil beide Waechter hier auf Abwesenheit pruefen und die Datei
 * genau das, was fehlen soll, in ihrem Kopf begruendet. Auf dem rohen Text
 * waere jeder der beiden rot, sobald jemand den Grund aufschreibt. Ein
 * Waechter, der das Erklaeren bestraft, wird abgeschaltet, nicht befolgt.
 */
const CODE = QUELLE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('die Regel fragt die richtigen Quellen', () => {
  it('appMode wird im Code nicht gelesen, ein Schalter ist keine Laufwahrheit', () => {
    // Ein Umlegen mitten im Lauf wuerde die Spur eines laufenden Laufs
    // ruecklings aendern, und der Platz gehoerte dann niemandem mehr.
    expect(CODE).not.toContain('appMode')
    expect(CODE).not.toContain('settingsStore')
  })

  it('getProviderForModel wird nicht aufgerufen, es baut einen Client und wirft', () => {
    expect(CODE).not.toContain('getProviderForModel')
    expect(CODE).toContain('getProviderIdFromModel')
  })

  it('und der Grund, warum model-locality.ts hier nicht taugt, bleibt aufgeschrieben', () => {
    // Zwei Module, die fast dasselbe beantworten, laden zum Zusammenlegen ein.
    // Ohne den Grund daneben ist das Zusammenlegen eine Vereinfachung.
    expect(QUELLE).toContain('model-locality.ts')
    expect(QUELLE).toMatch(/VRAM/)
  })
})
