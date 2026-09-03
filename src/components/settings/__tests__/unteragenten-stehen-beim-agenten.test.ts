/**
 * Die Kappen fuer delegierte Agenten stehen beim Agenten, nicht bei
 * „Generation".
 *
 * Persona-Lauf vom 03.09.2026, Befund 12 des B2-Neulaufs: sie suchte die
 * Grenzen fuer Unteraufträge unter Settings → **Agent** und fand sie nicht.
 * Sie standen unter General → Generation, zwischen Temperatur und
 * Auto-Compact — Werten, die den Zug betreffen, vor dem der Nutzer sitzt.
 * Ein delegierter Agent laeuft ohne Zuschauer; das ist genau der Unterschied,
 * den der Kommentar an den Feldern selbst schon beschrieb.
 *
 * Ohne DOM (vitest laeuft in `environment: 'node'`) wird am Quelltext
 * gemessen: die Felder muessen im `tab === 'agent'`-Zweig stehen, und die Rail
 * muss die Sektion kennen — sonst gibt es einen Abschnitt ohne Sprungziel.
 *
 * Lauf: npx vitest run src/components/settings/__tests__/unteragenten-stehen-beim-agenten.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sectionsFor, type SettingsSectionFlags } from '../settings-nav'

const JSX = readFileSync(resolve(__dirname, '..', 'SettingsPage.tsx'), 'utf8')

const ALLE_AN: SettingsSectionFlags = {
  gpuPicker: true, builtinExpert: true, comfyui: true,
  agentMode: true, agentWorkflows: true, mediaTimeouts: true,
}

describe('Unteragenten-Kappen', () => {
  it('stehen im Agent-Zweig, nicht im allgemeinen', () => {
    const agentZweig = JSX.indexOf("{tab === 'agent' && (<>")
    const felder = ['subAgentMaxToolCalls', 'subAgentMaxIterations']
    expect(agentZweig).toBeGreaterThan(-1)
    for (const f of felder) {
      expect(JSX.indexOf(f), f).toBeGreaterThan(agentZweig)
    }
  })

  it('die Rail kennt die Sektion — sonst gibt es einen Abschnitt ohne Sprungziel', () => {
    expect(sectionsFor('agent', ALLE_AN)).toContain('Sub-agents')
    // Und sie taucht nicht doppelt auf der allgemeinen Seite auf.
    expect(sectionsFor('general', ALLE_AN)).not.toContain('Sub-agents')
  })

  it('die Begruendung bleibt bei den Feldern stehen', () => {
    // Der Grund fuer die kleinen Vorgaben ist keine Formalie: ein Sub-Agent
    // laeuft unbeaufsichtigt, und „0 = unbegrenzt" waere dort eine Falle.
    expect(JSX).toContain('runs unattended')
  })
})
