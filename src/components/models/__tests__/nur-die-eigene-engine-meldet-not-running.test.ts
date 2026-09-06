/**
 * @vitest-environment jsdom
 *
 * Zwei Zusagen der Modellkachel, beide am Namen der Zeile haengend.
 *
 * BEFUND 1: "Not running" gehoert der LU Engine, sonst niemandem.
 *
 * Die Models-Seite fragt EINE Stelle, ob die eingebaute Engine auf Port 8127
 * gerade etwas bedient, und reichte die Antwort an jede Kachel weiter. Wer
 * Ollama oder LM Studio als Backend benutzt und die LU Engine nie gestartet
 * hat, bekam damit auf seiner aktiven Ollama-Kachel "Not running" zu lesen,
 * waehrend Ollama lief und gerade antwortete. Die Kachel meldete den Tod eines
 * Dienstes, der mit ihrer Zeile nichts zu tun hat.
 *
 * BEFUND 2: der Screenreader liest denselben Namen wie das Auge.
 *
 * Das Kontextmenue der Kachel trug `aria-label="Actions for openai::..."`.
 * Text und title daneben gehen laengst durch `displayModelName`, das Label
 * nicht. `openai::` ist unser Steckplatzname, kein Kunde hat ihn gewaehlt, und
 * viele, die die LU Engine benutzen, haben mit OpenAI nichts zu tun.
 *
 * Run: npx vitest run src/components/models/__tests__/nur-die-eigene-engine-meldet-not-running.test.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { AIModel } from '../../../types/models'

// Der Bench-Knopf haengt am Benchmark-Store und an dessen Hook. Er hat mit
// beiden Fragen hier nichts zu tun.
vi.mock('../ModelBenchmark', () => ({ BenchmarkButton: () => null }))

const { ModelCard } = await import('../ModelCard')

/** Eine Zeile der eingebauten Engine, so wie `bundledToAIModels` sie stempelt. */
const LU_ZEILE: AIModel = {
  name: 'openai::Phi-4-mini-instruct-Q4_K_M',
  model: 'Phi-4-mini-instruct-Q4_K_M',
  size: 1,
  type: 'text',
  provider: 'openai',
  providerName: 'LU Engine',
}

/** Ollama. Laeuft, antwortet, und weiss von Port 8127 nichts. */
const OLLAMA_ZEILE: AIModel = {
  name: 'llama3.2:3b',
  model: 'llama3.2:3b',
  size: 1,
  type: 'text',
  provider: 'ollama',
  providerName: 'Ollama',
}

/** LM Studio teilt sich mit uns den Steckplatz `openai`, ist aber ein fremdes
 *  Backend mit eigenem Prozess. Nur der Anzeigename haelt die beiden
 *  auseinander. */
const LM_STUDIO_ZEILE: AIModel = {
  name: 'openai::qwen2.5-0.5b-instruct@q4_k_m',
  model: 'qwen2.5-0.5b-instruct@q4_k_m',
  size: 1,
  type: 'text',
  provider: 'openai',
  providerName: 'LM Studio',
}

function zeichne(model: AIModel, extra: Record<string, unknown> = {}) {
  return render(createElement(ModelCard, {
    model,
    isActive: true,
    onSelect: () => {},
    onDelete: () => {},
    onInfo: () => {},
    engineStopped: true,
    ...extra,
  }))
}

afterEach(() => cleanup())

describe('Befund 1: "Not running" gilt nur fuer Zeilen der LU Engine', () => {
  it('die aktive Ollama-Kachel sagt weiter Active, auch wenn die Engine steht', () => {
    zeichne(OLLAMA_ZEILE)
    expect(
      screen.queryByTestId('model-card-stopped'),
      'Ollama laeuft und antwortet, die tote Engine ist nicht seine',
    ).toBeNull()
    expect(document.body.textContent).toContain('Active')
  })

  it('und die aktive LM-Studio-Kachel auch, trotz gemeinsamem Steckplatz', () => {
    zeichne(LM_STUDIO_ZEILE)
    expect(screen.queryByTestId('model-card-stopped')).toBeNull()
    expect(document.body.textContent).toContain('Active')
  })

  // NEGATIVKONTROLLE: die Meldung selbst bleibt, wo sie hingehoert. Ohne
  // diesen Fall waere der Fix oben mit einem geloeschten Abzeichen zu haben.
  it('die aktive Zeile der LU Engine sagt Not running', () => {
    zeichne(LU_ZEILE)
    expect(screen.getByTestId('model-card-stopped').textContent).toContain('Not running')
    expect(document.body.textContent).not.toContain('Active')
  })

  // NEGATIVKONTROLLE: laeuft die Engine, sagt auch ihre Zeile wieder Active.
  it('und Active, sobald die Engine wieder laeuft', () => {
    zeichne(LU_ZEILE, { engineStopped: false })
    expect(screen.queryByTestId('model-card-stopped')).toBeNull()
    expect(document.body.textContent).toContain('Active')
  })

  it('der Use-Knopf folgt derselben Regel', () => {
    // Auf der eigenen Zeile ist er der Weg zurueck: die Engine steht, ein
    // Druck startet sie mit diesem Modell (Persona P2).
    const { unmount } = zeichne(LU_ZEILE, { onUse: () => {} })
    expect(screen.queryByTestId('model-card-use')).not.toBeNull()
    unmount()
    // Auf einer fremden Zeile verspraeche er, ein Backend zu starten, das
    // laeuft. Die aktive Zeile braucht ihn dort nicht.
    zeichne(OLLAMA_ZEILE, { onUse: () => {} })
    expect(screen.queryByTestId('model-card-use')).toBeNull()
  })
})

describe('Befund 2: das Kontextmenue nennt den Namen, den der Kunde sieht', () => {
  it('kein Steckplatz-Praefix im aria-label', () => {
    const { container } = zeichne(LU_ZEILE)
    fireEvent.contextMenu(container.firstElementChild!)
    const menue = screen.getByRole('menu')
    expect(menue.getAttribute('aria-label')).toBe('Actions for Phi-4-mini-instruct-Q4_K_M')
    expect(menue.getAttribute('aria-label')).not.toContain('openai::')
  })

  // NEGATIVKONTROLLE: eine Ollama-Kennung traegt gar kein Praefix und muss
  // unveraendert durchkommen. Ein Label, das mehr abschneidet als den
  // Steckplatz, waere der naechste Fehler.
  it('und laesst einen Namen ohne Praefix in Ruhe', () => {
    const { container } = zeichne(OLLAMA_ZEILE)
    fireEvent.contextMenu(container.firstElementChild!)
    expect(screen.getByRole('menu').getAttribute('aria-label')).toBe('Actions for llama3.2:3b')
  })
})
