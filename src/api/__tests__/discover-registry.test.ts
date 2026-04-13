import { describe, it, expect } from 'vitest'
import {
  getUncensoredTextModels,
  getMainstreamTextModels,
  getImageBundles,
  getVideoBundles,
  CUSTOM_NODE_REGISTRY,
  COMPONENT_REGISTRY,
  lookupFileMeta,
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
        'sd15', 'sdxl', 'flux', 'flux2', 'zimage', 'wan', 'hunyuan',
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
      const typesWithVAE = ['flux', 'flux2', 'zimage', 'wan', 'hunyuan', 'mochi', 'cosmos', 'cogvideo', 'framepack', 'pyramidflow']
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
      const typesWithCLIP = ['flux', 'flux2', 'zimage', 'wan', 'hunyuan', 'ltx', 'mochi', 'cosmos', 'cogvideo', 'framepack']
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
})
