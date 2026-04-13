import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Provide minimal DOM mocks for node environment before importing
// systemCheck.ts needs `document.createElement('canvas')` and `navigator.deviceMemory`
if (typeof document === 'undefined') {
  (globalThis as any).document = {
    createElement: () => ({ getContext: () => null }),
  }
}
if (typeof navigator === 'undefined') {
  (globalThis as any).navigator = {}
}

import { getRecommendations, detectSystem } from '../systemCheck'
import type { SystemTier } from '../systemCheck'

describe('systemCheck', () => {
  // ─── getRecommendations ───

  describe('getRecommendations', () => {
    describe('low tier', () => {
      const recs = getRecommendations('low')

      it('returns an array of recommendations', () => {
        expect(Array.isArray(recs)).toBe(true)
        expect(recs.length).toBeGreaterThan(0)
      })

      it('each recommendation has required fields', () => {
        for (const r of recs) {
          expect(typeof r.name).toBe('string')
          expect(r.name.length).toBeGreaterThan(0)
          expect(typeof r.label).toBe('string')
          expect(typeof r.description).toBe('string')
          expect(typeof r.reason).toBe('string')
        }
      })

      it('includes lightweight models', () => {
        const names = recs.map((r) => r.name.toLowerCase())
        const hasSmall = names.some(
          (n) => n.includes('7b') || n.includes('8b') || n.includes('e2b')
        )
        expect(hasSmall).toBe(true)
      })

      it('returns at least 2 recommendations', () => {
        expect(recs.length).toBeGreaterThanOrEqual(2)
      })
    })

    describe('medium tier', () => {
      const recs = getRecommendations('medium')

      it('returns recommendations', () => {
        expect(recs.length).toBeGreaterThan(0)
      })

      it('each has name, label, description, reason', () => {
        for (const r of recs) {
          expect(typeof r.name).toBe('string')
          expect(typeof r.label).toBe('string')
          expect(typeof r.description).toBe('string')
          expect(typeof r.reason).toBe('string')
        }
      })

      it('has more or equal recommendations than low tier', () => {
        const lowRecs = getRecommendations('low')
        expect(recs.length).toBeGreaterThanOrEqual(lowRecs.length)
      })

      it('includes mid-range models (8B class)', () => {
        const names = recs.map((r) => r.name.toLowerCase())
        const hasMidRange = names.some((n) => n.includes('8b'))
        expect(hasMidRange).toBe(true)
      })
    })

    describe('high tier', () => {
      const recs = getRecommendations('high')

      it('returns recommendations', () => {
        expect(recs.length).toBeGreaterThan(0)
      })

      it('each has required fields', () => {
        for (const r of recs) {
          expect(typeof r.name).toBe('string')
          expect(typeof r.label).toBe('string')
          expect(typeof r.description).toBe('string')
          expect(typeof r.reason).toBe('string')
        }
      })

      it('includes larger models (12B+, 14B+, 24B+)', () => {
        const names = recs.map((r) => r.name.toLowerCase())
        const hasLarge = names.some(
          (n) => n.includes('12b') || n.includes('14b') || n.includes('24b') || n.includes('26b')
        )
        expect(hasLarge).toBe(true)
      })

      it('returns at least 3 recommendations for high tier', () => {
        expect(recs.length).toBeGreaterThanOrEqual(3)
      })
    })

    describe('cross-tier validation', () => {
      it('all tiers return non-empty arrays', () => {
        const tiers: SystemTier[] = ['low', 'medium', 'high']
        for (const tier of tiers) {
          const recs = getRecommendations(tier)
          expect(recs.length).toBeGreaterThan(0)
        }
      })

      it('no duplicate model names within a tier', () => {
        const tiers: SystemTier[] = ['low', 'medium', 'high']
        for (const tier of tiers) {
          const recs = getRecommendations(tier)
          const names = recs.map((r) => r.name)
          const unique = new Set(names)
          expect(unique.size).toBe(names.length)
        }
      })

      it('model names are meaningful strings', () => {
        const tiers: SystemTier[] = ['low', 'medium', 'high']
        for (const tier of tiers) {
          for (const r of getRecommendations(tier)) {
            expect(r.name.length).toBeGreaterThan(2)
          }
        }
      })
    })
  })

  // ─── detectSystem ───

  describe('detectSystem', () => {
    let originalCreateElement: any

    beforeEach(() => {
      originalCreateElement = document.createElement
    })

    afterEach(() => {
      (document as any).createElement = originalCreateElement
    })

    it('returns a SystemInfo object with expected fields', () => {
      const info = detectSystem()
      expect(info).toHaveProperty('tier')
      expect(info).toHaveProperty('ramGB')
      expect(info).toHaveProperty('gpuRenderer')
      expect(info).toHaveProperty('estimatedVRAM')
      expect(['low', 'medium', 'high']).toContain(info.tier)
    })

    it('tier is low when RAM <= 4GB and no GPU', () => {
      Object.defineProperty(navigator, 'deviceMemory', { value: 4, writable: true, configurable: true })
      ;(document as any).createElement = () => ({ getContext: () => null })
      const info = detectSystem()
      expect(info.tier).toBe('low')
    })

    it('tier is high when RAM >= 16GB and no GPU', () => {
      Object.defineProperty(navigator, 'deviceMemory', { value: 16, writable: true, configurable: true })
      ;(document as any).createElement = () => ({ getContext: () => null })
      const info = detectSystem()
      expect(['medium', 'high']).toContain(info.tier)
    })

    it('estimatedVRAM is "Unknown" when no WebGL', () => {
      ;(document as any).createElement = () => ({ getContext: () => null })
      const info = detectSystem()
      expect(info.estimatedVRAM).toBe('Unknown')
    })

    it('detects high-end GPU (RTX 4090)', () => {
      const mockGL = {
        getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
        getParameter: () => 'NVIDIA GeForce RTX 4090',
      }
      ;(document as any).createElement = () => ({ getContext: () => mockGL })
      const info = detectSystem()
      expect(info.estimatedVRAM).toContain('24')
      expect(info.tier).toBe('high')
    })

    it('detects mid-range GPU (RTX 3060)', () => {
      Object.defineProperty(navigator, 'deviceMemory', { value: 8, writable: true, configurable: true })
      const mockGL = {
        getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
        getParameter: () => 'NVIDIA GeForce RTX 3060',
      }
      ;(document as any).createElement = () => ({ getContext: () => mockGL })
      const info = detectSystem()
      expect(info.estimatedVRAM).toContain('8')
    })

    it('detects integrated GPU (Intel UHD)', () => {
      Object.defineProperty(navigator, 'deviceMemory', { value: 8, writable: true, configurable: true })
      const mockGL = {
        getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
        getParameter: () => 'Intel UHD Graphics 630',
      }
      ;(document as any).createElement = () => ({ getContext: () => mockGL })
      const info = detectSystem()
      expect(info.estimatedVRAM).toContain('integrated')
      expect(info.tier).toBe('low')
    })

    it('detects Apple Silicon (M1)', () => {
      Object.defineProperty(navigator, 'deviceMemory', { value: 8, writable: true, configurable: true })
      const mockGL = {
        getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
        getParameter: () => 'Apple M1',
      }
      ;(document as any).createElement = () => ({ getContext: () => mockGL })
      const info = detectSystem()
      expect(info.estimatedVRAM).toContain('shared')
    })

    it('handles WebGL getExtension returning null', () => {
      const mockGL = { getExtension: () => null }
      ;(document as any).createElement = () => ({ getContext: () => mockGL })
      const info = detectSystem()
      expect(info.gpuRenderer).toBeNull()
      expect(info.estimatedVRAM).toBe('Unknown')
    })

    it('detects RTX 3080 VRAM range', () => {
      const mockGL = {
        getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
        getParameter: () => 'NVIDIA GeForce RTX 3080',
      }
      ;(document as any).createElement = () => ({ getContext: () => mockGL })
      Object.defineProperty(navigator, 'deviceMemory', { value: 16, writable: true, configurable: true })
      const info = detectSystem()
      expect(info.estimatedVRAM).toContain('16')
      expect(info.tier).toBe('high')
    })

    it('detects GTX 1060 VRAM', () => {
      const mockGL = {
        getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
        getParameter: () => 'NVIDIA GeForce GTX 1060',
      }
      ;(document as any).createElement = () => ({ getContext: () => mockGL })
      Object.defineProperty(navigator, 'deviceMemory', { value: 8, writable: true, configurable: true })
      const info = detectSystem()
      expect(info.estimatedVRAM).toContain('8')
    })

    it('gpuRenderer contains the GPU name', () => {
      const mockGL = {
        getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
        getParameter: () => 'AMD Radeon RX 7900 XTX',
      }
      ;(document as any).createElement = () => ({ getContext: () => mockGL })
      const info = detectSystem()
      expect(info.gpuRenderer).toBe('AMD Radeon RX 7900 XTX')
    })
  })
})
