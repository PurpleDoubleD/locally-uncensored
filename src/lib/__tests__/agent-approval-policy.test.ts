import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveApprovalLevel, BACKGROUND_AGENT_TOOLS } from '../agent-approval-policy'
import type { FrontDecision } from '../agent-approval-policy'

/**
 * Die Tabelle hinter Auftrag 2.3. Sie sagt fuer EINEN Werkzeugaufruf, was die
 * vorne getroffene Entscheidung fuer ihn bedeutet, und sie ist die einzige
 * Stelle, an der das steht: beide Agentenwege lesen sie.
 */

const chat = (over: Partial<FrontDecision> = {}): FrontDecision => ({
  categoryLevel: 'confirm',
  codexMode: null,
  readOnlyRun: false,
  ...over,
})
const code = (over: Partial<FrontDecision> = {}): FrontDecision => ({
  categoryLevel: 'confirm',
  codexMode: 'ask',
  readOnlyRun: false,
  ...over,
})

describe('Hintergrundagenten fragen nicht mehr nach', () => {
  it('delegate_task laeuft, obwohl seine Kategorie auf confirm steht', () => {
    // Das ist Davids Fall: drei Delegationen waren drei Dialoge, weil
    // delegate_task in 'workflow' liegt und 'workflow' auf 'confirm' steht.
    expect(resolveApprovalLevel('delegate_task', chat({ categoryLevel: 'confirm' }))).toBe('auto')
  })

  it('gilt fuer alle drei Werkzeuge des Hintergrundbetriebs', () => {
    for (const name of BACKGROUND_AGENT_TOOLS) {
      expect(resolveApprovalLevel(name, chat({ categoryLevel: 'confirm' }))).toBe('auto')
    }
    expect([...BACKGROUND_AGENT_TOOLS].sort()).toEqual(['check_tasks', 'delegate_task', 'message_agent'])
  })

  it('aendert nichts an einem Werkzeug, das wirklich etwas anfasst', () => {
    expect(resolveApprovalLevel('file_write', chat({ categoryLevel: 'confirm' }))).toBe('confirm')
    expect(resolveApprovalLevel('shell_execute', chat({ categoryLevel: 'confirm' }))).toBe('confirm')
  })
})

describe('keine Rechteerweiterung ueber die Delegation', () => {
  it('eine abgeschaltete Kategorie bleibt abgeschaltet, auch fuer delegate_task', () => {
    // Wer 'workflow' auf blocked stellt, schaltet die Delegation ab. Die
    // Ausnahme oben darf das nicht aufheben, sonst waere sie ein Loch.
    expect(resolveApprovalLevel('delegate_task', chat({ categoryLevel: 'blocked' }))).toBe('blocked')
    expect(resolveApprovalLevel('file_write', chat({ categoryLevel: 'blocked' }))).toBe('blocked')
  })

  it('eine ausdrueckliche Einzelregel des Nutzers holt die Rueckfrage zurueck', () => {
    expect(resolveApprovalLevel('delegate_task', chat({ categoryLevel: 'confirm', override: 'confirm' })))
      .toBe('confirm')
    expect(resolveApprovalLevel('delegate_task', chat({ categoryLevel: 'confirm', override: 'blocked' })))
      .toBe('blocked')
  })

  it('ein lesend gestellter Lauf bleibt lesend, egal was die Kategorie sagt', () => {
    expect(resolveApprovalLevel('file_write', chat({ categoryLevel: 'auto', readOnlyRun: true }))).toBe('blocked')
    expect(resolveApprovalLevel('file_edit', code({ codexMode: 'plan', readOnlyRun: true }))).toBe('blocked')
    // shell_execute ist die bekannte Ausnahme: es traegt die Git-Leser, sein
    // Gate ist der Klassifikator im Ausfuehrer. Sonst waere ein /review-Zug
    // ohne git diff.
    expect(resolveApprovalLevel('shell_execute', code({ codexMode: 'plan', readOnlyRun: true, execConfirm: false })))
      .toBe('auto')
  })
})

describe('die Code-Oberflaeche folgt ihrem Preset, nicht den Chat-Kategorien', () => {
  it('Bypass fragt nicht, auch wenn die Chat-Kategorie confirm sagt', () => {
    // Sonst faellt im Code-Tab eine Frage an, die dort niemand anzeigt: die
    // Warteschlange haengt am Chat-Fenster.
    expect(resolveApprovalLevel('file_write', code({ codexMode: 'bypass', categoryLevel: 'confirm', execConfirm: false })))
      .toBe('auto')
  })

  it('Ask fragt vor shell_execute, auch wenn die Chat-Kategorie auto sagt', () => {
    expect(resolveApprovalLevel('shell_execute', code({ codexMode: 'ask', categoryLevel: 'auto', execConfirm: true })))
      .toBe('confirm')
  })

  it('Ask fragt nur vor den Werkzeugen, vor denen der Hauptlauf auch fragt', () => {
    // codexModeKnobs armiert genau CODEX_CONFIRM_TOOLS. file_write geht dort
    // ueber Stage-and-Approve, nicht ueber diesen Gate.
    expect(resolveApprovalLevel('file_write', code({ codexMode: 'ask', categoryLevel: 'confirm', execConfirm: true })))
      .toBe('auto')
  })

  it('eine abgeschaltete Kategorie bleibt auch im Code-Tab abgeschaltet', () => {
    expect(resolveApprovalLevel('shell_execute', code({ categoryLevel: 'blocked', execConfirm: true })))
      .toBe('blocked')
  })
})

describe('beide Agentenwege lesen dieselbe Tabelle', () => {
  /**
   * "Zwei Pfade, einer gepflegt" ist in diesem Baum die haeufigste
   * Fehlerursache, und useAgentChat gegen useCodex ist das Paar, das schon
   * mehrfach auseinandergelaufen ist. Deshalb steht hier eine Quelltext-Probe
   * statt nur einer Verhaltensprobe: sie faellt, sobald jemand an einer der
   * beiden Stellen eine eigene Rechnung aufmacht.
   */
  const lies = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('useAgentChat entscheidet ueber resolveApprovalLevel', () => {
    const src = lies('src/hooks/useAgentChat.ts')
    expect(src).toMatch(/resolveApprovalLevel\(/)
  })

  it('der Unterauftrag entscheidet ueber dieselbe Funktion', () => {
    const src = lies('src/api/agents/sub-agent.ts')
    expect(src).toMatch(/resolveApprovalLevel\(/)
  })

  it('useCodex legt seine Entscheidung einmal vorne auf den Lauf', () => {
    const src = lies('src/hooks/useCodex.ts')
    expect(src).toMatch(/run\.execApproval\s*=/)
  })
})
