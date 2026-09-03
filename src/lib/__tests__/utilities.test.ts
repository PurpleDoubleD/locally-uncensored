/**
 * Utility Function Tests
 *
 * Tests formatters.ts, privacy.ts, and systemCheck.ts pure logic functions.
 *
 * Run: npx vitest run src/lib/__tests__/utilities.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { formatBytes, formatDate, truncate } from '../formatters'
import { getRecommendations } from '../systemCheck'
import type { SystemTier } from '../systemCheck'

// ── formatBytes ──────────────────────────────────────────────────

describe('formatBytes', () => {
  it('returns "0 B" for 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500.0 B')
  })

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GB')
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5 GB')
  })

  it('formats terabytes', () => {
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB')
  })
})

// ── formatDate ───────────────────────────────────────────────────

describe('formatDate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "Just now" for timestamps less than a minute ago', () => {
    const now = Date.now()
    vi.setSystemTime(now)
    expect(formatDate(now)).toBe('Just now')
    expect(formatDate(now - 30_000)).toBe('Just now') // 30 seconds ago
  })

  it('returns minutes ago for timestamps under an hour', () => {
    const now = Date.now()
    vi.setSystemTime(now)
    expect(formatDate(now - 5 * 60_000)).toBe('5m ago')
    expect(formatDate(now - 30 * 60_000)).toBe('30m ago')
  })

  it('returns hours ago for timestamps under a day', () => {
    const now = Date.now()
    vi.setSystemTime(now)
    expect(formatDate(now - 2 * 3600_000)).toBe('2h ago')
    expect(formatDate(now - 12 * 3600_000)).toBe('12h ago')
  })

  it('returns days ago for timestamps under a week', () => {
    const now = Date.now()
    vi.setSystemTime(now)
    expect(formatDate(now - 3 * 86400_000)).toBe('3d ago')
    expect(formatDate(now - 6 * 86400_000)).toBe('6d ago')
  })

  it('returns locale date string for timestamps over a week', () => {
    const now = Date.now()
    vi.setSystemTime(now)
    const oldTimestamp = now - 14 * 86400_000
    const result = formatDate(oldTimestamp)
    // Should be a date string, not a relative time
    expect(result).not.toContain('ago')
    expect(result).not.toBe('Just now')
  })
})

// ── truncate ─────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns short string unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('returns string unchanged when exactly at maxLength', () => {
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('truncates long string with "..."', () => {
    expect(truncate('hello world', 5)).toBe('hello...')
  })

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('')
  })

  it('handles maxLength of 0', () => {
    expect(truncate('hello', 0)).toBe('...')
  })
})

// ── proxyImageUrl ────────────────────────────────────────────────

// proxyImageUrl imports isTauri from ../api/backend, which accesses window.__TAURI__
// We mock the entire module to avoid DOM/Tauri dependencies.
vi.mock('../../api/backend', () => ({
  isTauri: vi.fn(() => false),
  localFetch: vi.fn(),
  ollamaUrl: vi.fn((path: string) => `http://localhost:11434${path}`),
}))

describe('proxyImageUrl', () => {
  let proxyImageUrl: typeof import('../privacy').proxyImageUrl
  let isTauri: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const privacyModule = await import('../privacy')
    proxyImageUrl = privacyModule.proxyImageUrl

    const backendModule = await import('../../api/backend')
    isTauri = backendModule.isTauri as ReturnType<typeof vi.fn>
  })

  it('returns undefined for undefined input', () => {
    expect(proxyImageUrl(undefined)).toBeUndefined()
  })

  it('returns local URLs unchanged (starts with /)', () => {
    expect(proxyImageUrl('/images/photo.png')).toBe('/images/photo.png')
  })

  it('returns blob: URLs unchanged', () => {
    expect(proxyImageUrl('blob:http://localhost/abc')).toBe('blob:http://localhost/abc')
  })

  it('returns data: URLs unchanged', () => {
    const dataUrl = 'data:image/png;base64,iVBOR...'
    expect(proxyImageUrl(dataUrl)).toBe(dataUrl)
  })

  it('proxies external URLs through local API in dev mode', () => {
    isTauri.mockReturnValue(false)
    const external = 'https://example.com/photo.jpg'
    const result = proxyImageUrl(external)
    expect(result).toBe(`/local-api/proxy-image?url=${encodeURIComponent(external)}`)
  })

  it('returns external URLs directly in Tauri mode', () => {
    isTauri.mockReturnValue(true)
    const external = 'https://example.com/photo.jpg'
    expect(proxyImageUrl(external)).toBe(external)
  })
})

// ── getRecommendations ───────────────────────────────────────────

describe('getRecommendations', () => {
  it('returns models for low tier', () => {
    const recs = getRecommendations('low')
    expect(recs.length).toBeGreaterThan(0)
    for (const rec of recs) {
      expect(rec).toHaveProperty('name')
      expect(rec).toHaveProperty('label')
      expect(rec).toHaveProperty('description')
      expect(rec).toHaveProperty('reason')
    }
  })

  it('returns models for medium tier', () => {
    const recs = getRecommendations('medium')
    expect(recs.length).toBeGreaterThan(0)
  })

  it('returns models for high tier', () => {
    const recs = getRecommendations('high')
    expect(recs.length).toBeGreaterThan(0)
  })

  it('returns different models for different tiers', () => {
    const low = getRecommendations('low')
    const medium = getRecommendations('medium')
    const high = getRecommendations('high')

    const lowNames = low.map((r) => r.name)
    const mediumNames = medium.map((r) => r.name)
    const highNames = high.map((r) => r.name)

    // Every tier recommends a different set — medium was fetched but never
    // asserted on before, so a medium list identical to low/high slipped through.
    expect(lowNames).not.toEqual(highNames)
    expect(mediumNames).not.toEqual(lowNames)
    expect(mediumNames).not.toEqual(highNames)
  })

  it('low tier recommends smaller models', () => {
    const low = getRecommendations('low')
    // Low tier should recommend 7b/8b models
    const hasSmallModel = low.some(
      (r) => r.name.includes('7b') || r.name.includes('8b')
    )
    expect(hasSmallModel).toBe(true)
  })

  it('high tier recommends larger models', () => {
    const high = getRecommendations('high')
    // High tier should include 12b+ models
    const hasLargeModel = high.some(
      (r) => r.name.includes('14b') || r.name.includes('12b') || r.name.includes('24b')
    )
    expect(hasLargeModel).toBe(true)
  })

  it('all recommendations have non-empty fields', () => {
    const tiers: SystemTier[] = ['low', 'medium', 'high']
    for (const tier of tiers) {
      for (const rec of getRecommendations(tier)) {
        expect(rec.name.length).toBeGreaterThan(0)
        expect(rec.label.length).toBeGreaterThan(0)
        expect(rec.description.length).toBeGreaterThan(0)
        expect(rec.reason.length).toBeGreaterThan(0)
      }
    }
  })
})
