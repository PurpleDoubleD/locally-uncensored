import { describe, it, expect } from 'vitest'
import {
  getUncensoredTextModels,
  getMainstreamTextModels,
  getImageBundles,
  getVideoBundles,
  CUSTOM_NODE_REGISTRY,
  COMPONENT_REGISTRY,
  lookupFileMeta,
  mmprojFileName,
  planModelDownload,
} from '../discover'

describe('discover — data validation', () => {
  // ─── getUncensoredTextModels ───

  describe('getUncensoredTextModels', () => {
    const models = getUncensoredTextModels()

    it('returns a non-empty array', () => {
      expect(models.length).toBeGreaterThan(0)
    })

    it('every model has a name', () => {
      for (const m of models) {
        expect(typeof m.name).toBe('string')
        expect(m.name.length).toBeGreaterThan(0)
      }
    })

    it('every model has a downloadUrl starting with https://', () => {
      for (const m of models) {
        // Some large models (e.g. 754B MoE) may lack downloadUrl
        if (m.downloadUrl) {
          expect(m.downloadUrl).toMatch(/^https:\/\//)
        }
      }
    })

    it('every model with sizeGB has a positive value', () => {
      for (const m of models) {
        if (m.sizeGB !== undefined) {
          expect(m.sizeGB).toBeGreaterThan(0)
        }
      }
    })

    it('has no duplicate names', () => {
      const names = models.map((m) => m.name)
      const unique = new Set(names)
      expect(unique.size).toBe(names.length)
    })

    it('every downloadable model has a filename', () => {
      for (const m of models) {
        if (m.downloadUrl) {
          expect(typeof m.filename).toBe('string')
          expect(m.filename!.length).toBeGreaterThan(0)
        }
      }
    })

    it('contains at least some known model families', () => {
      const names = models.map((m) => m.name.toLowerCase())
      const hasHermes = names.some((n) => n.includes('hermes'))
      const hasQwen = names.some((n) => n.includes('qwen'))
      expect(hasHermes || hasQwen).toBe(true)
    })
  })

  // ─── getMainstreamTextModels ───

  describe('getMainstreamTextModels', () => {
    const models = getMainstreamTextModels()

    it('returns a non-empty array', () => {
      expect(models.length).toBeGreaterThan(0)
    })

    it('every model has a name', () => {
      for (const m of models) {
        expect(typeof m.name).toBe('string')
        expect(m.name.length).toBeGreaterThan(0)
      }
    })

    it('every downloadable model has downloadUrl starting with https://', () => {
      for (const m of models) {
        if (m.downloadUrl) {
          expect(m.downloadUrl).toMatch(/^https:\/\//)
        }
      }
    })

    it('every model with sizeGB has a positive value', () => {
      for (const m of models) {
        if (m.sizeGB !== undefined) {
          expect(m.sizeGB).toBeGreaterThan(0)
        }
      }
    })

    it('has no duplicate names', () => {
      const names = models.map((m) => m.name)
      const unique = new Set(names)
      expect(unique.size).toBe(names.length)
    })

    it('contains known mainstream families (Gemma, Qwen, Llama, DeepSeek)', () => {
      const names = models.map((m) => m.name.toLowerCase())
      expect(names.some((n) => n.includes('gemma'))).toBe(true)
      expect(names.some((n) => n.includes('qwen'))).toBe(true)
      expect(names.some((n) => n.includes('llama') || n.includes('deepseek'))).toBe(true)
    })
  })

  // ─── getImageBundles ───

  describe('getImageBundles', () => {
    const bundles = getImageBundles()

    it('returns a non-empty array', () => {
      expect(bundles.length).toBeGreaterThan(0)
    })

    it('each bundle has a name', () => {
      for (const b of bundles) {
        expect(typeof b.name).toBe('string')
        expect(b.name.length).toBeGreaterThan(0)
      }
    })

    it('each bundle has a non-empty files array', () => {
      for (const b of bundles) {
        expect(Array.isArray(b.files)).toBe(true)
        expect(b.files.length).toBeGreaterThan(0)
      }
    })

    it('each file in every bundle has a downloadUrl starting with https://', () => {
      for (const b of bundles) {
        for (const f of b.files) {
          if (f.downloadUrl) {
            expect(f.downloadUrl).toMatch(/^https:\/\//)
          }
        }
      }
    })

    it('each bundle has totalSizeGB > 0', () => {
      for (const b of bundles) {
        expect(b.totalSizeGB).toBeGreaterThan(0)
      }
    })

    it('each bundle has a vramRequired string', () => {
      for (const b of bundles) {
        expect(typeof b.vramRequired).toBe('string')
        expect(b.vramRequired.length).toBeGreaterThan(0)
      }
    })

    it('each bundle has a workflow type', () => {
      for (const b of bundles) {
        expect(typeof b.workflow).toBe('string')
      }
    })

    it('each file has a filename and subfolder', () => {
      for (const b of bundles) {
        for (const f of b.files) {
          if (f.downloadUrl) {
            expect(typeof f.filename).toBe('string')
            expect(typeof f.subfolder).toBe('string')
          }
        }
      }
    })
  })

  // ─── getVideoBundles ───

  describe('getVideoBundles', () => {
    const bundles = getVideoBundles()

    it('returns a non-empty array', () => {
      expect(bundles.length).toBeGreaterThan(0)
    })

    it('each bundle has a name', () => {
      for (const b of bundles) {
        expect(typeof b.name).toBe('string')
        expect(b.name.length).toBeGreaterThan(0)
      }
    })

    it('each bundle has a non-empty files array', () => {
      for (const b of bundles) {
        expect(Array.isArray(b.files)).toBe(true)
        expect(b.files.length).toBeGreaterThan(0)
      }
    })

    it('each file has a downloadUrl that is a string starting with https://', () => {
      for (const b of bundles) {
        for (const f of b.files) {
          if (f.downloadUrl) {
            expect(typeof f.downloadUrl).toBe('string')
            expect(f.downloadUrl).toMatch(/^https:\/\//)
          }
        }
      }
    })

    it('each bundle has totalSizeGB > 0', () => {
      for (const b of bundles) {
        expect(b.totalSizeGB).toBeGreaterThan(0)
      }
    })

    it('has no duplicate bundle names', () => {
      const names = bundles.map((b) => b.name)
      const unique = new Set(names)
      expect(unique.size).toBe(names.length)
    })

    it('some bundles are marked as uncensored', () => {
      const uncensoredCount = bundles.filter((b) => b.uncensored).length
      expect(uncensoredCount).toBeGreaterThan(0)
    })
  })

  // ─── CUSTOM_NODE_REGISTRY ───

  describe('CUSTOM_NODE_REGISTRY', () => {
    it('has at least 5 entries', () => {
      expect(Object.keys(CUSTOM_NODE_REGISTRY).length).toBeGreaterThanOrEqual(5)
    })

    it('each entry has a repo URL starting with https://', () => {
      for (const [, entry] of Object.entries(CUSTOM_NODE_REGISTRY)) {
        expect(entry.repo).toMatch(/^https:\/\//)
      }
    })

    it('each entry has a non-empty name', () => {
      for (const [, entry] of Object.entries(CUSTOM_NODE_REGISTRY)) {
        expect(typeof entry.name).toBe('string')
        expect(entry.name.length).toBeGreaterThan(0)
      }
    })

    it('each entry has a non-empty requiredNodes array', () => {
      for (const [, entry] of Object.entries(CUSTOM_NODE_REGISTRY)) {
        expect(Array.isArray(entry.requiredNodes)).toBe(true)
        expect(entry.requiredNodes.length).toBeGreaterThan(0)
      }
    })

    it('contains animatediff, cogvideox, framepack, pyramidflow, allegro', () => {
      expect(CUSTOM_NODE_REGISTRY['animatediff-evolved']).toBeDefined()
      expect(CUSTOM_NODE_REGISTRY['cogvideox-wrapper']).toBeDefined()
      expect(CUSTOM_NODE_REGISTRY['framepack-wrapper']).toBeDefined()
      expect(CUSTOM_NODE_REGISTRY['pyramidflow-wrapper']).toBeDefined()
      expect(CUSTOM_NODE_REGISTRY['allegro']).toBeDefined()
    })

    it('repo URLs point to github.com', () => {
      for (const [, entry] of Object.entries(CUSTOM_NODE_REGISTRY)) {
        expect(entry.repo).toContain('github.com')
      }
    })
  })

  // ─── COMPONENT_REGISTRY ───

  describe('COMPONENT_REGISTRY', () => {
    it('has entries for all expected model types', () => {
      const expectedTypes = [
        'sd15', 'sdxl', 'flux', 'flux2', 'zimage', 'ernie_image', 'wan', 'hunyuan',
        'ltx', 'mochi', 'cosmos', 'cogvideo', 'svd', 'framepack',
        'pyramidflow', 'allegro', 'unknown',
      ]
      for (const t of expectedTypes) {
        expect(COMPONENT_REGISTRY[t]).toBeDefined()
      }
    })

    it('each entry has a loader property', () => {
      for (const [, spec] of Object.entries(COMPONENT_REGISTRY)) {
        expect(['UNETLoader', 'CheckpointLoaderSimple', 'ImageOnlyCheckpointLoader']).toContain(spec.loader)
      }
    })

    it('each entry has needsSeparateVAE and needsSeparateCLIP booleans', () => {
      for (const [, spec] of Object.entries(COMPONENT_REGISTRY)) {
        expect(typeof spec.needsSeparateVAE).toBe('boolean')
        expect(typeof spec.needsSeparateCLIP).toBe('boolean')
      }
    })

    it('UNET-based types that need separate VAE have vae spec with downloadUrl', () => {
      const typesWithVAE = ['flux', 'flux2', 'zimage', 'ernie_image', 'wan', 'hunyuan', 'mochi', 'cosmos', 'cogvideo', 'framepack', 'pyramidflow']
      for (const t of typesWithVAE) {
        const spec = COMPONENT_REGISTRY[t]
        if (spec.needsSeparateVAE && spec.vae) {
          expect(spec.vae.downloadUrl).toMatch(/^https:\/\//)
          expect(typeof spec.vae.downloadName).toBe('string')
          expect(typeof spec.vae.subfolder).toBe('string')
          expect(Array.isArray(spec.vae.patterns)).toBe(true)
        }
      }
    })

    it('UNET-based types that need separate CLIP have clip spec with downloadUrl', () => {
      const typesWithCLIP = ['flux', 'flux2', 'zimage', 'ernie_image', 'wan', 'hunyuan', 'ltx', 'mochi', 'cosmos', 'cogvideo', 'framepack']
      for (const t of typesWithCLIP) {
        const spec = COMPONENT_REGISTRY[t]
        if (spec.needsSeparateCLIP && spec.clip) {
          expect(spec.clip.downloadUrl).toMatch(/^https:\/\//)
          expect(typeof spec.clip.downloadName).toBe('string')
        }
      }
    })

    it('checkpoint-based types (sd15, sdxl) do NOT need separate VAE/CLIP', () => {
      expect(COMPONENT_REGISTRY['sd15'].needsSeparateVAE).toBe(false)
      expect(COMPONENT_REGISTRY['sd15'].needsSeparateCLIP).toBe(false)
      expect(COMPONENT_REGISTRY['sdxl'].needsSeparateVAE).toBe(false)
      expect(COMPONENT_REGISTRY['sdxl'].needsSeparateCLIP).toBe(false)
    })
  })

  // ─── lookupFileMeta ───

  describe('lookupFileMeta', () => {
    it('finds a known image bundle file', () => {
      const bundles = getImageBundles()
      const firstFile = bundles[0]?.files[0]
      if (firstFile?.filename) {
        const meta = lookupFileMeta(firstFile.filename)
        expect(meta).not.toBeNull()
        expect(meta!.url).toMatch(/^https:\/\//)
        expect(typeof meta!.subfolder).toBe('string')
      }
    })

    it('finds a known video bundle file', () => {
      const bundles = getVideoBundles()
      const firstFile = bundles[0]?.files[0]
      if (firstFile?.filename) {
        const meta = lookupFileMeta(firstFile.filename)
        expect(meta).not.toBeNull()
        expect(meta!.url).toMatch(/^https:\/\//)
      }
    })

    it('returns null for an unknown filename', () => {
      const meta = lookupFileMeta('totally_nonexistent_file_xyz.safetensors')
      expect(meta).toBeNull()
    })

    it('returns null for empty string', () => {
      const meta = lookupFileMeta('')
      expect(meta).toBeNull()
    })
  })

  // ─── Cross-validation: all download URLs are https ───

  describe('all download URLs format', () => {
    it('uncensored text model URLs are all https strings', () => {
      for (const m of getUncensoredTextModels()) {
        if (m.downloadUrl) {
          expect(typeof m.downloadUrl).toBe('string')
          expect(m.downloadUrl).toMatch(/^https:\/\//)
        }
      }
    })

    it('mainstream text model URLs are all https strings', () => {
      for (const m of getMainstreamTextModels()) {
        if (m.downloadUrl) {
          expect(typeof m.downloadUrl).toBe('string')
          expect(m.downloadUrl).toMatch(/^https:\/\//)
        }
      }
    })

    it('image bundle file URLs are all https strings', () => {
      for (const b of getImageBundles()) {
        for (const f of b.files) {
          if (f.downloadUrl) {
            expect(f.downloadUrl).toMatch(/^https:\/\//)
          }
        }
      }
    })

    it('video bundle file URLs are all https strings', () => {
      for (const b of getVideoBundles()) {
        for (const f of b.files) {
          if (f.downloadUrl) {
            expect(f.downloadUrl).toMatch(/^https:\/\//)
          }
        }
      }
    })
  })

  // ─── Vision projectors (mmproj) ───
  // A text GGUF has no image tower. An entry that promises Vision on a direct
  // download has to bring the projector, or the model loads and answers and
  // simply cannot see, which is the silent failure this pairing prevents.

  describe('mmproj pairing', () => {
    const all = [...getUncensoredTextModels(), ...getMainstreamTextModels()]

    it('every projector is a full, downloadable pair', () => {
      for (const m of all) {
        if (!m.mmprojUrl) continue
        expect(m.mmprojUrl, `${m.name}: projector URL`).toMatch(/^https:\/\//)
        expect(m.downloadUrl, `${m.name}: projector without a model file`).toBeTruthy()
        expect(m.filename, `${m.name}: projector without a model filename`).toBeTruthy()
        expect(m.mmprojSizeGB, `${m.name}: projector size`).toBeGreaterThan(0)
        expect(m.tags, `${m.name}: projector but no Vision tag`).toContain('Vision')
      }
    })

    it('every Qwen 3.8 download that claims Vision carries a projector', () => {
      const claiming = all.filter(m => m.downloadUrl && m.name.includes('Qwen 3.8') && m.tags.includes('Vision'))
      expect(claiming.length).toBeGreaterThan(0)
      for (const m of claiming) {
        expect(m.mmprojUrl, `${m.name}: Vision tag without a projector`).toBeTruthy()
      }
    })

    it('the 9B distill stays honest about being text only', () => {
      const nine = all.filter(m => m.name.includes('Qwen 3.8 9B'))
      expect(nine.length).toBeGreaterThan(0)
      for (const m of nine) {
        expect(m.tags, `${m.name}`).not.toContain('Vision')
        expect(m.mmprojUrl).toBeUndefined()
      }
    })

    it('names the projector after the model, not after the repo', () => {
      expect(mmprojFileName('Qwen3.8-27B-UD-Q4_K_M.gguf')).toBe('Qwen3.8-27B-UD-Q4_K_M.mmproj.gguf')
      expect(mmprojFileName('A.GGUF')).toBe('A.mmproj.gguf')
      // Dots inside the name survive: a stem cut at the last dot would mangle it.
      expect(mmprojFileName('qwen3.8-27b.gguf')).toBe('qwen3.8-27b.mmproj.gguf')
    })
  })

  describe('planModelDownload', () => {
    const vision = getMainstreamTextModels().find(m => m.name === 'Qwen 3.8 27B')!
    const textOnly = getMainstreamTextModels().find(m => m.name === 'Qwen 3.8 9B Distill')!

    it('adds the projector as a second file in the same folder', () => {
      const plan = planModelDownload(vision, vision.downloadUrl!, vision.filename!, 100)
      expect(plan).toHaveLength(2)
      expect(plan[0]).toEqual({ url: vision.downloadUrl, filename: vision.filename, expectedBytes: 100 })
      expect(plan[1].url).toBe(vision.mmprojUrl)
      expect(plan[1].filename).toBe(mmprojFileName(vision.filename!))
      expect(plan[1].expectedBytes).toBe(Math.round(vision.mmprojSizeGB! * 1_073_741_824))
    })

    it('follows the RESOLVED model name, not the catalog guess', () => {
      // The HF tree corrects a wrong guessed filename; the projector has to
      // follow it or the engine looks for a sibling that is not there.
      const plan = planModelDownload(vision, 'https://x/y.gguf', 'Corrected-Name-Q4_K_M.gguf')
      expect(plan[1].filename).toBe('Corrected-Name-Q4_K_M.mmproj.gguf')
    })

    it('leaves a text-only model at exactly one file', () => {
      const plan = planModelDownload(textOnly, textOnly.downloadUrl!, textOnly.filename!, 42)
      expect(plan).toEqual([{ url: textOnly.downloadUrl, filename: textOnly.filename, expectedBytes: 42 }])
    })
  })

  describe('Qwen 3.8 catalog entries', () => {
    it('lists both uncensored 27B families with a projector each', () => {
      const groups = new Set(getUncensoredTextModels().filter(m => m.mmprojUrl).map(m => m.group))
      expect(groups).toContain('Qwen 3.8 27B Uncensored')
      expect(groups).toContain('Qwen 3.8 27B Abliterated')
    })

    it('serves OrcaRouter\'s uncensored 27B from the ungated bartowski requant, projector named as that repo names it', () => {
      const rows = getUncensoredTextModels().filter(m => m.group === 'Qwen 3.8 27B Uncensored')
      expect(rows.length).toBe(6)
      for (const m of rows) {
        expect(m.downloadUrl).toContain('/bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF/')
        expect(m.mmprojUrl).toContain('/bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF/resolve/main/mmproj-orcarouter_Qwen3.8-27B-Uncensored-f16.gguf')
      }
    })

    it('lists the official 27B and the small distill', () => {
      const names = getMainstreamTextModels().map(m => m.name)
      expect(names).toContain('Qwen 3.8 27B')
      expect(names).toContain('Qwen 3.8 9B Distill')
    })

    it('offers the Ollama tags, where the projector ships inside the tag', () => {
      const tags = [...getUncensoredTextModels(), ...getMainstreamTextModels()]
        .map(m => m.ollamaModel)
        .filter(Boolean)
      expect(tags).toContain('qwen3.8')
      expect(tags).toContain('huihui_ai/Qwen3.8-abliterated:27b')
      expect(tags).toContain('orcarouter/Qwen3.8-27B-Uncensored:q4_K_M')
    })
  })
})
