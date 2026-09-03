import { describe, it, expect } from 'vitest'
import { AgentBudget, budgetFromSettings } from '../budget'

describe('AgentBudget', () => {
  it('starts clean: exceeded() = none', () => {
    const b = new AgentBudget({ maxToolCalls: 10, maxIterations: 5 })
    expect(b.exceeded().kind).toBe('none')
    expect(b.haltMessage()).toBe('')
  })

  it('detects tool-call cap hit', () => {
    const b = new AgentBudget({ maxToolCalls: 3, maxIterations: 100 })
    b.addToolCalls(3)
    const ex = b.exceeded()
    expect(ex.kind).toBe('tool_calls')
    if (ex.kind === 'tool_calls') {
      expect(ex.used).toBe(3)
      expect(ex.cap).toBe(3)
    }
    expect(b.haltMessage()).toMatch(/tool-call budget reached/)
  })

  it('detects iteration cap hit (iterations checked first)', () => {
    const b = new AgentBudget({ maxToolCalls: 100, maxIterations: 2 })
    b.addIteration()
    b.addIteration()
    expect(b.exceeded().kind).toBe('iterations')
    expect(b.haltMessage()).toMatch(/iteration cap/)
  })

  it('iteration cap reported when both would trigger', () => {
    const b = new AgentBudget({ maxToolCalls: 1, maxIterations: 1 })
    b.addToolCalls(5)
    b.addIteration()
    // Iteration cap is checked first by design — halts early on deeper runs.
    expect(b.exceeded().kind).toBe('iterations')
  })

  it('addToolCalls accumulates across batches', () => {
    const b = new AgentBudget({ maxToolCalls: 5, maxIterations: 100 })
    b.addToolCalls(2)
    b.addToolCalls(2)
    expect(b.exceeded().kind).toBe('none')
    b.addToolCalls(1)
    expect(b.exceeded().kind).toBe('tool_calls')
  })

  it('ignores zero and negative additions', () => {
    const b = new AgentBudget({ maxToolCalls: 1, maxIterations: 100 })
    b.addToolCalls(0)
    b.addToolCalls(-5)
    expect(b.exceeded().kind).toBe('none')
  })

  it('cap = 0 means unlimited', () => {
    const b = new AgentBudget({ maxToolCalls: 0, maxIterations: 0 })
    b.addToolCalls(10_000)
    for (let i = 0; i < 50; i++) b.addIteration()
    expect(b.exceeded().kind).toBe('none')
  })

  it('snapshot reports current usage + caps', () => {
    const b = new AgentBudget({ maxToolCalls: 10, maxIterations: 5 })
    b.addToolCalls(3)
    b.addIteration()
    const snap = b.snapshot()
    expect(snap).toEqual({
      toolCalls: 3,
      iterations: 1,
      caps: { maxToolCalls: 10, maxIterations: 5 },
    })
  })

  it('budgetFromSettings reads the two relevant fields', () => {
    const b = budgetFromSettings({ agentMaxToolCalls: 7, agentMaxIterations: 3 })
    b.addToolCalls(7)
    expect(b.exceeded().kind).toBe('tool_calls')
  })
})

// ── Die Abbruchmeldung nennt den Regler (Persona B2) ─────────────────────

describe('wer abbricht, sagt auch wo man das aendert', () => {
  /**
   * Persona-Lauf vom 03.09.2026, Befund 8: „Die Abbruchmeldung nennt sie
   * nicht, sondern raet nur ‚rephrase and retry'. Ohne Suchen im
   * Einstellungsbaum kommt da niemand hin."
   *
   * Er hatte recht und musste die Regler selbst finden — und sie standen
   * damals auch noch am falschen Ort (jetzt: Settings → Agent → Sub-agents,
   * siehe unteragenten-stehen-beim-agenten.test.ts). Eine Grenze, die man
   * ohne Hinweis nicht findet, ist fuer den Nutzer keine Einstellung,
   * sondern eine Wand.
   */
  const erschoepft = (caps: { maxToolCalls: number; maxIterations: number }, scope?: 'run' | 'sub') => {
    const b = new AgentBudget(caps, scope)
    // Genau bis an die Kappe, nicht darueber — sonst steht in der Meldung
    // eine Zahl, die im Betrieb nie vorkommt.
    for (let i = 0; i < caps.maxIterations; i++) b.addIteration()
    return b.haltMessage()
  }

  it('der Unterauftrag nennt seinen eigenen Ort', () => {
    const m = erschoepft({ maxToolCalls: 10, maxIterations: 5 }, 'sub')
    expect(m).toMatch(/Settings/)
    expect(m).toMatch(/Sub-agents/)
  })

  it('der Hauptlauf nennt seinen', () => {
    const m = erschoepft({ maxToolCalls: 50, maxIterations: 25 }, 'run')
    expect(m).toMatch(/Settings/)
    expect(m).toMatch(/Generation/)
    expect(m).not.toMatch(/Sub-agents/)
  })

  it('ohne Angabe bleibt es beim Hauptlauf — die haeufigere Herkunft', () => {
    expect(erschoepft({ maxToolCalls: 50, maxIterations: 25 })).toMatch(/Generation/)
  })

  it('die Zahlen stehen weiterhin drin', () => {
    // Ohne sie waere der Hinweis unbrauchbar: man will wissen, worauf man
    // etwas anhebt, nicht nur dass es einen Regler gibt.
    expect(erschoepft({ maxToolCalls: 10, maxIterations: 5 }, 'sub')).toMatch(/5 \/ 5|5\/5/)
  })
})
