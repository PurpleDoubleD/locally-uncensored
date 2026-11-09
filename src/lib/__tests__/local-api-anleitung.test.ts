/**
 * GH Discussion #14 ("API key not working even though I haven't set one") und
 * C57 (SillyTavern: "no model loaded"): die Anleitung in der Einstellung nennt
 * die Felder, wie SillyTavern sie nennt, sagt, dass der Schluessel immer
 * gebraucht wird, und dass LU-Engine-Modelle beim ersten Aufruf laden.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientAnleitung, kannStarten } from '../local-api'

const here = dirname(fileURLToPath(import.meta.url))

describe('Use with SillyTavern / other apps', () => {
  const a = clientAnleitung('http://127.0.0.1:8129/v1')
  const text = a.flatMap((x) => [x.titel, ...x.schritte]).join('\n')

  it('nennt SillyTaverns Felder und die echte Adresse', () => {
    expect(a[0].titel).toBe('SillyTavern')
    expect(text).toContain('Custom (OpenAI-compatible)')
    expect(text).toContain('Custom Endpoint (Base URL): http://127.0.0.1:8129/v1')
    expect(text).toContain('Custom API Key')
  })

  it('sagt, dass der Schluessel Pflicht ist und LU-Engine-Modelle beim ersten Aufruf laden', () => {
    expect(text).toMatch(/key is required/i)
    expect(text).toMatch(/lu\//)
    expect(text).toMatch(/loaded by the first request/)
  })

  it('der Start ohne Schluessel nennt ihn API key, wie jede App ihn nennt', () => {
    const u = kannStarten('', 8129)
    expect(u.ok).toBe(false)
    if (!u.ok) expect(u.grund).toMatch(/API key/)
  })

  it('die Einstellung zeigt die Anleitung und nennt das Feld API key', () => {
    const tsx = readFileSync(resolve(here, '../../components/settings/LocalApiSettings.tsx'), 'utf8')
    expect(tsx).toContain('Use with SillyTavern / other apps')
    expect(tsx).toContain('clientAnleitung(base)')
    expect(tsx).toContain("paste it into your app's API key field")
  })

  it('der Store gibt der API Engine-Ordner und Abstimmung mit (C57, Laden bei Bedarf)', () => {
    const store = readFileSync(resolve(here, '../../stores/localApiStore.ts'), 'utf8')
    expect(store).toMatch(/engineDirs: customModelDirs\(\)/)
    expect(store).toMatch(/engineTuning:/)
  })
})
