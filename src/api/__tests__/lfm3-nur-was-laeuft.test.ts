/**
 * LFM3 im Katalog, und warum (noch) nicht als GGUF.
 *
 * ── DER AUFTRAG UND DER BEFUND ─────────────────────────────────────────────
 *
 * Davids Wort vom 31.10.2026 (Paket N1): Liquid LFM3 kommt in 3.0.9 "auf allen
 * Kanaelen". Gemessen am 30.10.2026 am Mac:
 *
 *   LiquidAI/LFM3-1.7B-GGUF   general.architecture = lfm3
 *   llama.cpp b9949 (Pin)     kennt lfm2, lfm2moe, KEIN lfm3
 *   llama.cpp b11960          LLM_ARCH_LFM3 "lfm3" (laut Modellkarte die erste)
 *   lu-llama-server 049326a   "unknown model architecture: 'lfm3'"
 *   Ollama 0.40.13            laedt lfm3, lfm3-vl, lfm3-omni, lfm3-audio
 *
 * Ein GGUF-Eintrag landet bei der LU Engine oder in LM Studio. Die LU Engine
 * kann ihn am Pin b9949 nicht oeffnen; LM Studio erst ab llama.cpp-Runtime
 * 2.65.1. Deshalb steht LFM3 nur als Ollama-Tag da, die MLX-Builds davon nur
 * auf dem Mac.
 *
 * ── WANN DIESE DATEI FAELLT ────────────────────────────────────────────────
 *
 * Wird der Pin in scripts/build-llama.sh auf b11960 oder spaeter gehoben,
 * gibt die zweite Sperre unten den GGUF-Eintrag von selbst frei. Davor gehoert
 * `LIVE_ARCH=1 npx vitest run src/api/__tests__/katalog-architektur.live.test.ts`
 * gelaufen.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getUncensoredTextModels, getMainstreamTextModels } from '../discover'
import { parsePinnedLlamaTag } from '../gguf-arch'
import { forThisPlatform } from '../../lib/mlx-only-builds'

const alle = () => [...getUncensoredTextModels(), ...getMainstreamTextModels()]
const lfm3 = () => alle().filter((m) => /^LFM3\b/.test(m.name))
const wurzel = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Erste llama.cpp-Version mit LLM_ARCH_LFM3 (Modellkarte LiquidAI/LFM3-1.7B-GGUF). */
const LFM3_AB_BUILD = 11960

describe('LFM3 steht im Katalog', () => {
  it('alle vier Varianten als offizielle Ollama-Tags: Text, VL, Omni, Audio', () => {
    const tags = lfm3().map((m) => m.ollamaModel)
    for (const t of ['lfm3:1.7b', 'lfm3-vl:2b', 'lfm3-omni:2b', 'lfm3-audio:2b']) expect(tags).toContain(t)
  })

  it('Omni und Audio sagen, wo LU den Ton nutzt', () => {
    for (const t of ['lfm3-omni:2b', 'lfm3-audio:2b']) {
      const m = lfm3().find((x) => x.ollamaModel === t)!
      expect(m.tags).toContain('Audio')
      expect(m.description).toContain('Settings, Voice')
    }
    expect(lfm3().find((m) => m.ollamaModel === 'lfm3-omni:2b')!.tags).toContain('Vision')
  })

  it('jeder Eintrag sagt, welches Ollama er braucht und was die Lizenz begrenzt', () => {
    for (const m of lfm3()) expect(m.description, m.name).toContain('Ollama 0.40.13')
    const haupt = lfm3().filter((m) => !m.tags.includes('MLX'))
    expect(haupt.length).toBe(4)
    for (const m of haupt) expect(m.description, m.name).toMatch(/10 M USD/)
  })

  it('das VL-Modell traegt Vision, das Textmodell nicht', () => {
    expect(lfm3().find((m) => m.ollamaModel === 'lfm3-vl:2b')!.tags).toContain('Vision')
    expect(lfm3().find((m) => m.ollamaModel === 'lfm3:1.7b')!.tags).not.toContain('Vision')
  })

  it('die MLX-Builds sieht nur der Mac', () => {
    const mlx = lfm3().filter((m) => m.ollamaModel?.includes('nvfp4'))
    expect(mlx.length).toBe(4)
    for (const m of mlx) expect(m.tags).toContain('MLX')
    expect(forThisPlatform(lfm3(), true).length).toBe(8)
    expect(forThisPlatform(lfm3(), false).map((m) => m.ollamaModel).sort()).toEqual(['lfm3-audio:2b', 'lfm3-omni:2b', 'lfm3-vl:2b', 'lfm3:1.7b'])
  })
})

describe('LFM3 steht NICHT als GGUF im Katalog, solange die Engine es nicht oeffnet', () => {
  it('kein Eintrag zeigt auf ein LFM3-GGUF, waehrend der Pin vor b11960 liegt', () => {
    const tag = parsePinnedLlamaTag(readFileSync(resolve(wurzel, 'scripts/build-llama.sh'), 'utf8'))
    expect(tag).toMatch(/^b\d+$/)
    const build = Number(tag!.slice(1))
    const gguf = alle().filter((m) => /LFM3/i.test(`${m.downloadUrl ?? ''} ${m.filename ?? ''}`))
    if (build >= LFM3_AB_BUILD) return
    expect(
      gguf.map((m) => `${m.name} → ${m.downloadUrl}`),
      `LFM3-GGUFs tragen general.architecture=lfm3; llama.cpp ${tag} kennt das nicht (ab b${LFM3_AB_BUILD}).`,
    ).toEqual([])
  })
})
