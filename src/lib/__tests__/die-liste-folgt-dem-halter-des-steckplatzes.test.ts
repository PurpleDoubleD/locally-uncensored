/**
 * Wechselt der Halter des geteilten Steckplatzes, muss die Modelliste neu
 * geholt werden.
 *
 * Die Regel dafuer stand wortgleich zweimal im Baum, in
 * components/models/ModelSelector.tsx und in components/layout/Header.tsx,
 * und beide Fassungen verglichen nur `enabled` und `baseUrl`. `useModels`
 * haengt die QUELLE der ganzen Liste aber an `managed`: haelt unsere eigene
 * Engine den `openai`-Steckplatz, kommen die Zeilen aus
 * `list_bundled_models`, der Steckplatz faellt aus der Provider-Runde heraus,
 * und die Zeilen des verdraengten Backends bekommen eine eigene Ueberschrift.
 * Ein Schreiben, das nur den Halter dreht, schrieb die Liste also am
 * staerksten um und loeste als Einziges kein Nachladen aus.
 *
 * Run: npx vitest run src/lib/__tests__/die-liste-folgt-dem-halter-des-steckplatzes.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { modelListIsStale } from '../model-list-staleness'
import type { ProviderConfig, ProviderId } from '../../api/providers/types'

const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

function slot(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'openai', name: 'LU Engine', enabled: true,
    baseUrl: 'http://127.0.0.1:8127/v1', apiKey: '', isLocal: true, managed: true,
    ...over,
  }
}

/** Die vier Steckplaetze, so wie der Store sie haelt. */
function alle(openai: ProviderConfig): Record<ProviderId, ProviderConfig> {
  return {
    ollama: slot({ id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', managed: undefined }),
    openai,
    anthropic: slot({ id: 'anthropic', name: 'Anthropic', enabled: false, isLocal: false, managed: undefined }),
    'lu-cloud': slot({ id: 'lu-cloud', name: 'LU Cloud', enabled: false, isLocal: false, managed: undefined }),
  }
}

const ENGINE = slot()
/** Was `slotHandbackUpdate` schreibt: derselbe Steckplatz, anderer Halter. */
const LM_STUDIO = slot({ name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', managed: false })

describe('DER BEFUND: der Halterwechsel laedt jetzt nach', () => {
  it('nur `managed` gedreht, und die Liste ist eine andere', () => {
    expect(modelListIsStale(alle(slot({ managed: false })), alle(ENGINE))).toBe(true)
  })

  it('nur der Anzeigename gedreht, und die Ueberschriften stimmen nicht mehr', () => {
    expect(modelListIsStale(alle(slot({ name: 'Jan' })), alle(ENGINE))).toBe(true)
  })

  it('die Uebergabe, wie sie wirklich geschrieben wird', () => {
    expect(modelListIsStale(alle(LM_STUDIO), alle(ENGINE))).toBe(true)
    expect(modelListIsStale(alle(ENGINE), alle(LM_STUDIO))).toBe(true)
  })

  it('und die beiden alten Felder zaehlen unveraendert', () => {
    expect(modelListIsStale(alle(slot({ enabled: false })), alle(ENGINE))).toBe(true)
    expect(modelListIsStale(alle(slot({ baseUrl: 'http://127.0.0.1:9999/v1' })), alle(ENGINE))).toBe(true)
  })
})

describe('NEGATIVKONTROLLE: was die Liste in Ruhe laesst', () => {
  it('ein unveraenderter Store laedt nichts nach', () => {
    expect(modelListIsStale(alle(ENGINE), alle(ENGINE))).toBe(false)
  })

  it('ein getippter Schluessel nicht, sonst eine Anfrage pro Buchstabe', () => {
    const mit = alle(ENGINE)
    mit.anthropic = { ...mit.anthropic, apiKey: 'sk-ant-abc' }
    expect(modelListIsStale(mit, alle(ENGINE))).toBe(false)
  })

  it('und die Standby-Karte allein auch nicht, sie listet nichts', () => {
    // `displaced` merkt sich, wer verdraengt wurde. Gelistet wird das Wartende
    // ueber den Steckplatz selbst, nicht ueber dieses Feld.
    const mit = alle(slot({ displaced: { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', isLocal: true } }))
    expect(modelListIsStale(mit, alle(ENGINE))).toBe(false)
  })
})

describe('die Regel steht an EINER Stelle', () => {
  const waehler = lies('components/models/ModelSelector.tsx')
  const kopfleiste = lies('components/layout/Header.tsx')

  it('beide Tueren fragen dieselbe Stelle', () => {
    for (const datei of [waehler, kopfleiste]) {
      expect(datei).toContain("from '../../lib/model-list-staleness'")
      expect(datei).toContain('modelListIsStale(state.providers, prev.providers)')
    }
  })

  it('und keine von beiden traegt die abgeschriebene Fassung noch', () => {
    for (const datei of [waehler, kopfleiste]) {
      expect(datei).not.toContain('?.enabled !== prev.providers[id]?.enabled')
      expect(datei).not.toContain('?.baseUrl !== prev.providers[id]?.baseUrl')
    }
  })

  it('der Grund, warum `managed` dazugehoert, steht noch in useModels', () => {
    const models = lies('hooks/useModels.ts')
    expect(models).toContain('const managedBuiltin = isManagedBuiltinActive()')
    expect(models).toContain('const standby = managedBuiltin ? standbyChatBackend() : null')
  })
})
