// @vitest-environment jsdom
/**
 * Fund 2 der E2E-Kampagne 3.0.0: "Quick senkt die Schrittzahl des Trainers
 * nicht" (T3, Nebenfund 8, Box, 11.09.2026).
 *
 * Nachgemessen am Code und an den Belegen des Testers: Quick IST 400, und 400
 * ist die kleinste der drei Stufen (Quick 400, Standard 1200, Thorough 2400).
 * Der Beleg `T3-belege/cdp-ausgaben/p-5a-out.json`, aufgenommen um 17:27 Boxzeit
 * und damit zwei Minuten VOR dem Klick auf Quick, zeigt den Hinweistext schon
 * mit `(400 STEPS)`: die gespeicherte Wahl der Box stand laengst auf Quick, der
 * Klick konnte also nichts mehr senken. Das Handbuch nennt dieselben Zahlen
 * (docs/guide/create: "Quick" (400 steps), "Standard" (1200) or "Thorough"
 * (2400)).
 *
 * Was fehlte, war der Name der Stufe neben der Zahl. Diese Datei nagelt beides
 * fest: die Zahl jeder Stufe erreicht den Hinweistext UND den Auftrag an den
 * Trainer, und der Text sagt, welche Stufe gilt.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/die-stufe-des-trainers-kommt-an.test.tsx
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TRAIN_PRESETS, TRAIN_STEPS_DEFAULT, trainStepsNote } from '../../../../lib/trainer-presets'

const backendCall = vi.fn(async () => ({ status: 'ok' }))
vi.mock('../../../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
  isLinux: () => false,
  backendCall: (...a: unknown[]) => backendCall(...(a as [])),
}))
vi.mock('../../../../api/trainer', async () => {
  const actual = await vi.importActual<typeof import('../../../../api/trainer')>('../../../../api/trainer')
  return {
    ...actual,
    characterTrainerStatus: vi.fn(async () => ({
      envReady: true,
      basesReady: true,
      // N4 (Opus review of `3ef38668`): the only mock in the tree still
      // missing the two K5 fields every other `TrainerStatus` mock carries.
      // Harmless here (this gate never reaches the install-path field once
      // `envReady` is true), but kept in step so a future field added next
      // to these two does not silently skip this file too.
      root: '/data/lu/musubi',
      customized: false,
      suggestedRoot: null,
      install: { status: 'done', step: '', percent: 100 },
    })),
    installCharacterTrainer: vi.fn(async () => undefined),
  }
})
vi.mock('../../../../api/comfyui', () => ({ getLoraModels: vi.fn(async () => []), getSystemVRAM: vi.fn(async () => null) }))
// 3.0.8 D20: the Low VRAM suggestion reads the card's memory; a 12 GB card
// keeps this file about the step presets alone.
vi.mock('../../../../hooks/useGraphicsMemory', () => ({ useGraphicsCardGb: () => 12 }))
vi.mock('../../../../api/cloud/loras', () => ({ listLoras: vi.fn(async () => []), deleteLora: vi.fn() }))

import { SpecialControls } from '../SpecialIntentControls'
import { useCreateStore } from '../../../../stores/createStore'
import { startCharacterTraining } from '../../../../api/trainer'

const quelle = readFileSync(resolve(__dirname, '..', 'SpecialIntentControls.tsx'), 'utf8')

beforeEach(() => {
  cleanup()
  backendCall.mockClear()
  useCreateStore.setState({ backend: 'local', characterTab: 'train', trainSteps: TRAIN_STEPS_DEFAULT })
})

describe('die drei Stufen des Trainers', () => {
  it('Quick ist die kleinste, und die Voreinstellung ist Standard', () => {
    expect(TRAIN_PRESETS.map((p) => `${p.label}:${p.steps}`)).toEqual([
      'Quick:400', 'Standard:1200', 'Thorough:2400',
    ])
    expect(Math.min(...TRAIN_PRESETS.map((p) => p.steps)), 'Quick ist die kleinste Zahl').toBe(400)
    expect(TRAIN_STEPS_DEFAULT).toBe(1200)
  })

  it('die Voreinstellung ist dieselbe, die der Trainer ohne Angabe nimmt', () => {
    // Ohne das traegt die Oberflaeche eine Zahl vor, und der Lauf nimmt eine
    // andere, sobald ein Aufrufer die Stufe weglaesst.
    const rust = readFileSync(resolve(__dirname, '../../../../..', 'src-tauri/src/commands/trainer.rs'), 'utf8')
    expect(rust).toContain(`steps.unwrap_or(${TRAIN_STEPS_DEFAULT})`)
  })

  it('das Handbuch nennt dieselben drei Zahlen', () => {
    const guide = readFileSync(resolve(__dirname, '../../../../..', 'docs/guide/create/index.html'), 'utf8')
    expect(guide).toContain('"Quick" (400 steps), "Standard" (1200) or "Thorough" (2400)')
  })
})

describe('die gewaehlte Stufe steht im Hinweistext', () => {
  it('THE FIX: der Text nennt die Stufe UND die wirksame Zahl', async () => {
    render(<SpecialControls intent="character" />)
    const zeile = await screen.findByText(/Runs on your GPU and takes a while/)
    expect(zeile.textContent).toContain('(Standard, 1200 steps)')

    fireEvent.click(screen.getByRole('radio', { name: 'Quick' }))
    expect(useCreateStore.getState().trainSteps, 'Quick senkt die Schrittzahl').toBe(400)
    expect(zeile.textContent).toContain('(Quick, 400 steps)')

    fireEvent.click(screen.getByRole('radio', { name: 'Thorough' }))
    expect(useCreateStore.getState().trainSteps).toBe(2400)
    expect(zeile.textContent).toContain('(Thorough, 2400 steps)')
  })

  it('DIE ROTE ZAHL: `(400 steps)` allein sagt nicht, welche Stufe gilt', () => {
    // Genau das hat T3 gelesen. Der Satz aus der Klammer ohne Namen kommt in
    // der Oberflaeche nicht mehr vor.
    expect(trainStepsNote(400)).toBe('Quick, 400 steps')
    expect(quelle).not.toContain('({trainSteps} steps)')
    expect(quelle).toContain('({trainStepsNote(trainSteps, presets)})')
  })

  it('GEGENPFAD: eine Zahl ohne Stufe nennt keine Stufe', () => {
    // Eine gespeicherte Zahl von Hand (der Store laesst 100 bis 4000 zu) ist
    // keine der drei, und der Text erfindet dafuer keinen Namen.
    expect(trainStepsNote(777)).toBe('777 steps')
  })

  it('der Waehler hat genau die drei Stufen aus der Tabelle', async () => {
    render(<SpecialControls intent="character" />)
    for (const p of TRAIN_PRESETS) await screen.findByRole('radio', { name: p.label })
    // 3.0.9 P8: die Stufen kommen aus dem Modus, Character sind TRAIN_PRESETS.
    expect(quelle).toContain('presets.map((p) => ({ value: String(p.steps), label: p.label }))')
  })
})

describe('die gewaehlte Zahl erreicht den Lauf', () => {
  it('der Auftrag an den Trainer traegt die Zahl der Stufe', async () => {
    await startCharacterTraining('t3char', 't3char', 't3char', 400)
    expect(backendCall).toHaveBeenCalledWith('start_character_training', {
      setId: 't3char', name: 't3char', triggerWord: 't3char', steps: 400, preset: null, kind: null,
    })
  })

  it('der Absendeweg nimmt die Zahl aus dem Store, nicht eine eigene', () => {
    const hook = readFileSync(resolve(__dirname, '../../../..', 'hooks/useCreate.ts'), 'utf8')
    expect(hook).toContain('await startCharacterTraining(setId, trigger, trigger, state.trainSteps, state.trainVramPreset, kind)')
  })

  it('und der Trainer legt sie auf die Befehlszeile', () => {
    // `--max_train_steps 400` ist genau das, was T3 in der laufenden
    // Befehlszeile gemessen hat.
    const rust = readFileSync(resolve(__dirname, '../../../../..', 'src-tauri/src/commands/trainer.rs'), 'utf8')
    expect(rust).toContain('"--max_train_steps", step.steps,')
  })
})
