/**
 * „nutze 5 glm 5.2 agenten für das und das."
 *
 * Der Auftrag vom 02.09.2026, wörtlich: steht im Prompt, wie viele Agenten mit
 * welchem Modell laufen sollen, soll genau das passieren — auch wenn ein
 * anderes Modell aktiv ist.
 *
 * Diese Reihe hält die Erkennung fest. Sie ist deterministisch und nicht dem
 * Modell überlassen, weil am selben Tag gemessen wurde, dass ein 4B-Modell auf
 * „call delegate_task with background true" mit PROSA antwortet („Task ID:
 * t12345") statt mit einem Werkzeugaufruf. Eine ausdrückliche Anweisung des
 * Nutzers darf daran nicht scheitern.
 *
 * Run: npx vitest run src/lib/__tests__/agent-fanout.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseFanoutRequest,
  resolveRequestedModel,
  fanoutDirective,
  unresolvedModelNote,
  MAX_EXPLICIT_FANOUT,
} from '../agent-fanout'

describe('die Anweisung wird aus dem Satz gelesen', () => {
  it('erkennt den Fall des Auftrags Wort für Wort', () => {
    const r = parseFanoutRequest('nutze 5 glm 5.2 agenten für das und das')
    expect(r).not.toBeNull()
    expect(r!.count).toBe(5)
    expect(r!.modelPhrase).toBe('glm 5.2')
  })

  it('erkennt den zweiten genannten Fall genauso', () => {
    const r = parseFanoutRequest('nutze 2 qwen 3.8 agenten und so weiter')
    expect(r!.count).toBe(2)
    expect(r!.modelPhrase).toBe('qwen 3.8')
  })

  it('kommt ohne Verb aus — die Zahl und das Wort Agent tragen die Anweisung', () => {
    expect(parseFanoutRequest('3 llama3.2 agenten bitte')!.count).toBe(3)
  })

  it('liest Englisch mit', () => {
    const r = parseFanoutRequest('use 4 qwen2.5-coder agents in parallel')
    expect(r!.count).toBe(4)
    expect(r!.modelPhrase).toBe('qwen2.5-coder')
  })

  it('liest Zahlwoerter, in beiden Sprachen', () => {
    expect(parseFanoutRequest('nimm drei agenten')!.count).toBe(3)
    expect(parseFanoutRequest('spawn two agents')!.count).toBe(2)
  })

  it('ohne Modellnamen bleibt die Wendung leer statt zu raten', () => {
    const r = parseFanoutRequest('starte 3 agenten dafuer')
    expect(r!.count).toBe(3)
    expect(r!.modelPhrase).toBe('')
  })

  it('kappt bei MAX_EXPLICIT_FANOUT und sagt, dass gekappt wurde', () => {
    const r = parseFanoutRequest('nutze 50 agenten')
    expect(r!.count).toBe(MAX_EXPLICIT_FANOUT)
    expect(r!.clamped).toBe(true)
  })

  it('meldet keine Kappung, wenn nicht gekappt wurde', () => {
    expect(parseFanoutRequest('nutze 3 agenten')!.clamped).toBe(false)
  })

  // ── Was ABSICHTLICH nicht erkannt wird ────────────────────────────────
  //
  // Diese vier sind der eigentliche Wert der Reihe. Eine Erkennung, die zu
  // viel faengt, startet Agenten, die niemand wollte — und das faellt erst
  // auf, wenn fuenf Modelle gleichzeitig die GPU belegen.
  it('eine Zahl ohne das Wort Agent ist keine Anweisung', () => {
    expect(parseFanoutRequest('nimm 5 dateien und fasse sie zusammen')).toBeNull()
  })

  it('das Wort Agent ohne Zahl ist kein Auftrag, sondern ein Wunsch', () => {
    // Eine geratene Menge waere schlimmer als keine. Fuer diesen Fall gibt es
    // weiterhin das Schluesselwort-Tor, das delegate_task ueberhaupt erst in
    // die Werkzeugliste holt; dann entscheidet das Modell selbst.
    expect(parseFanoutRequest('nutze agenten dafuer')).toBeNull()
  })

  it('leere und unsinnige Eingabe ergibt null statt eines Absturzes', () => {
    expect(parseFanoutRequest('')).toBeNull()
    expect(parseFanoutRequest('   ')).toBeNull()
    expect(parseFanoutRequest(undefined as unknown as string)).toBeNull()
  })

  it('null Agenten sind keine Anweisung', () => {
    expect(parseFanoutRequest('nutze 0 agenten')).toBeNull()
  })
})

describe('das genannte Modell wird unter den installierten gesucht', () => {
  // Die echte Form: die App spricht ein Chatmodell ueber `name` an
  // (setActiveModel(model.name)), ein `id`-Feld hat OllamaModel gar nicht.
  // Die erste Fassung dieser Reihe stand auf `id` — abgeschrieben von
  // resolveMlxModel, wo es stimmt, weil BILDmodelle eine id haben.
  const installiert = [
    { name: 'hf.co/unsloth/Qwen3.5-9B-GGUF:Q4_K_M', displayName: 'Qwen3.5 9B' },
    { name: 'llama3.2:3b', displayName: 'Llama 3.2 3B' },
    { name: 'qwen2.5-coder:7b', displayName: 'Qwen2.5 Coder 7B' },
  ]

  it('findet ueber eine Teilzeichenkette, quer durch Schreibweisen', () => {
    expect(resolveRequestedModel('qwen2.5 coder', installiert)!.name).toBe('qwen2.5-coder:7b')
    expect(resolveRequestedModel('LLAMA 3.2', installiert)!.name).toBe('llama3.2:3b')
  })

  it('findet auch ueber den Anzeigenamen', () => {
    expect(resolveRequestedModel('Qwen3.5 9B', installiert)!.name)
      .toBe('hf.co/unsloth/Qwen3.5-9B-GGUF:Q4_K_M')
  })

  it('gibt null zurueck, statt irgendetwas zu nehmen', () => {
    // DIE tragende Zeile. Ein Rueckfall auf das aktive Modell waere die
    // schlimmste der drei moeglichen Antworten: „nutze glm 5.2" mit qwen zu
    // beantworten und nichts zu sagen sieht aus wie Erfolg.
    expect(resolveRequestedModel('glm 5.2', installiert)).toBeNull()
    expect(resolveRequestedModel('', installiert)).toBeNull()
    expect(resolveRequestedModel('llama3.2', [])).toBeNull()
  })
})

describe('die Weisung an den Lauf', () => {
  const req = { count: 5, modelPhrase: 'glm 5.2', clamped: false }

  it('nennt die Zahl und verlangt EINEN Zug mit fuenf Aufrufen', () => {
    const d = fanoutDirective(req, 'glm-5.2:latest')
    expect(d).toContain('exactly 5')
    expect(d).toContain('background: true')
    expect(d).toContain('glm-5.2:latest')
  })

  it('schreibt den AUFGELOESTEN Bezeichner, nicht die Wendung des Nutzers', () => {
    // Sonst schriebe das Modell „glm 5.2" in das Argument, und die Aufloesung
    // muesste ein zweites Mal raten — an einer Stelle, die nicht mehr
    // zurueckfragen kann.
    expect(fanoutDirective(req, 'glm-5.2:latest')).not.toContain('"glm 5.2"')
  })

  it('sagt bei einer Kappung, dass sie stattfand', () => {
    const d = fanoutDirective({ ...req, count: MAX_EXPLICIT_FANOUT, clamped: true }, 'x')
    expect(d).toContain(String(MAX_EXPLICIT_FANOUT))
    expect(d.toLowerCase()).toContain('say so')
  })

  it('ohne aufgeloestes Modell haelt die Weisung den Start AN', () => {
    const note = unresolvedModelNote('glm 5.2', ['llama3.2:3b', 'qwen2.5-coder:7b'])
    const d = fanoutDirective(req, null, note)
    expect(d).toContain('do NOT start')
    expect(d).toContain('glm 5.2')
    expect(d).toContain('llama3.2:3b')
  })

  it('ohne Modellwunsch steht gar kein Modellsatz drin', () => {
    const d = fanoutDirective({ count: 3, modelPhrase: '', clamped: false }, null)
    expect(d).toContain('exactly 3')
    expect(d).not.toContain('Pass model')
    expect(d).not.toContain('do NOT start')
  })
})

// ── Die Verkabelung ────────────────────────────────────────────────────────
describe('die Anweisung erreicht den Lauf wirklich', () => {
  const quelle = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

  it('das Schluesselwort-Tor kennt Deutsch — sonst kaeme das Werkzeug nie an', () => {
    // Der Nutzer schreibt Deutsch. „nutze 5 glm 5.2 agenten" haette bis 2.6.8
    // das Tor nicht geoeffnet: DELEGATE_KEYWORDS war rein englisch, und ohne
    // offenes Tor liegt delegate_task gar nicht im Werkzeugregal. Die ganze
    // Anweisung waere ins Leere gelaufen, ohne Fehlermeldung.
    const s = quelle('lib/tool-selection.ts')
    for (const wort of ['agenten', 'agent', 'gleichzeitig', 'im hintergrund']) {
      expect(s, wort).toContain(`'${wort}'`)
    }
  })

  it('es gibt nur EINE Woerterliste, nicht zwei abgeschriebene', () => {
    // Bis 2.6.8 stand im TOOL_GROUPS-Router eine Kopie, die schon
    // auseinandergelaufen war ('sub agent', 'fan-out', 'parallelise' fehlten)
    // — obwohl der Kommentar daneben verspricht, beide Wege antworteten
    // „identisch". So entsteht der Fehler, den niemand sieht: der eine Pfad
    // oeffnet das Tor, der andere nicht, und es haengt am Wort.
    const s = quelle('lib/tool-selection.ts')
    expect(s).toMatch(/keywords:\s*DELEGATE_KEYWORDS/)
    // Und die Woerter stehen genau einmal da.
    expect(s.split("'split the work'").length - 1).toBe(1)
  })

  it('beide Agentenschleifen lesen den Wunsch und haengen die Weisung an', () => {
    // Geprueft wird der AUFRUF mit dem Nutzertext, nicht die Anwesenheit des
    // Namens. Die erste Fassung fragte nur `toContain('parseFanoutRequest')`
    // — und blieb gruen, als der Aufruf durch `null` ersetzt wurde, weil der
    // Import stehen blieb. Ein Waechter, der einen Import fuer eine Regel
    // haelt, prueft gar nichts.
    const nutzertext: Record<string, string> = {
      'hooks/useAgentChat.ts': 'userContent',
      'hooks/useCodex.ts': 'instruction',
    }
    for (const hook of ['hooks/useAgentChat.ts', 'hooks/useCodex.ts']) {
      const s = quelle(hook)
      expect(s, hook).toContain(`parseFanoutRequest(${nutzertext[hook]})`)
      expect(s, hook).toMatch(/setExplicitFanout\(\s*convId/)
      // Als Nutzer-Material. Eine System-Nachricht an anderer Stelle als
      // Index 0 weisen strenge Jinja-Vorlagen ab.
      expect(s, hook).toMatch(/content: fanoutDirective\(/)
      const i = s.indexOf('content: fanoutDirective(')
      expect(s.slice(Math.max(0, i - 120), i), hook).toContain("role: 'user'")
    }
  })

  it('ein nicht installiertes Modell haelt den Sub-Agenten AN, statt zu ersetzen', () => {
    // Die Regel steht an zwei Stellen und muss an beiden gelten: die Weisung
    // sagt dem Modell „do NOT start", und der Lauf selbst bricht ab, falls es
    // doch startet. „Nimm glm 5.2" mit qwen zu beantworten sieht aus wie
    // Erfolg und ist keiner.
    const s = quelle('api/agents/sub-agent.ts')
    expect(s).toContain('resolveRequestedModel')
    expect(s).toMatch(/is not installed here, so this sub-agent did not run/)
  })

  it('eine ausdrueckliche Zahl hebt die Nebenlaeufigkeitsschranke an', () => {
    const s = quelle('api/agents/sub-agent.ts')
    expect(s).toMatch(/export function effectiveParallelCap/)
    // Die Schranke liest die angehobene Kappe, nicht mehr die Konstante.
    expect(s).toMatch(/const kappe = effectiveParallelCap\(/)
    expect(s).toMatch(/if \(_inFlight >= kappe\)/)
  })
})
