/**
 * Privacy Utility Tests
 *
 * Tests proxyImageUrl() from privacy.ts:
 * - Local URLs pass through unchanged
 * - External URLs proxied in dev mode
 * - External URLs passed through in Tauri mode
 *
 * Run: npx vitest run src/lib/__tests__/privacy.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the backend module before importing privacy
vi.mock('../../api/backend', () => ({
  isTauri: vi.fn(() => false),
  localFetch: vi.fn(),
  ollamaUrl: vi.fn((path: string) => `http://localhost:11434${path}`),
}))

import { proxyImageUrl } from '../privacy'
import { isTauri } from '../../api/backend'

const mockedIsTauri = isTauri as ReturnType<typeof vi.fn>

describe('privacy', () => {
  describe('proxyImageUrl', () => {
    beforeEach(() => {
      mockedIsTauri.mockReturnValue(false)
    })

    // ── Undefined / empty ────────────────────────────────────

    it('returns undefined for undefined input', () => {
      expect(proxyImageUrl(undefined)).toBeUndefined()
    })

    it('returns undefined for empty string', () => {
      // empty string is falsy, so !url is true
      expect(proxyImageUrl('')).toBeUndefined()
    })

    // ── Local URLs (no proxy needed) ─────────────────────────

    it('returns local path URLs unchanged', () => {
      expect(proxyImageUrl('/images/photo.png')).toBe('/images/photo.png')
    })

    it('returns root path unchanged', () => {
      expect(proxyImageUrl('/')).toBe('/')
    })

    it('returns deep local path unchanged', () => {
      expect(proxyImageUrl('/api/v1/images/thumbnail.jpg')).toBe('/api/v1/images/thumbnail.jpg')
    })

    it('returns blob: URLs unchanged', () => {
      const blobUrl = 'blob:http://localhost:5173/abc-123-def'
      expect(proxyImageUrl(blobUrl)).toBe(blobUrl)
    })

    it('returns data: URLs unchanged', () => {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUh...'
      expect(proxyImageUrl(dataUrl)).toBe(dataUrl)
    })

    it('returns data: URLs with different mime type unchanged', () => {
      const dataUrl = 'data:image/svg+xml;charset=utf-8,%3Csvg...'
      expect(proxyImageUrl(dataUrl)).toBe(dataUrl)
    })

    // ── Dev mode (isTauri = false) ───────────────────────────

    it('proxies external HTTP URLs in dev mode', () => {
      mockedIsTauri.mockReturnValue(false)
      const url = 'http://example.com/photo.jpg'
      expect(proxyImageUrl(url)).toBe(`/local-api/proxy-image?url=${encodeURIComponent(url)}`)
    })

    it('proxies external HTTPS URLs in dev mode', () => {
      mockedIsTauri.mockReturnValue(false)
      const url = 'https://cdn.example.com/image.webp'
      expect(proxyImageUrl(url)).toBe(`/local-api/proxy-image?url=${encodeURIComponent(url)}`)
    })

    it('URL-encodes special characters in proxy URL', () => {
      mockedIsTauri.mockReturnValue(false)
      const url = 'https://example.com/photo.jpg?size=large&format=webp'
      const result = proxyImageUrl(url)
      expect(result).toContain(encodeURIComponent(url))
      expect(result).toMatch(/^\/local-api\/proxy-image\?url=/)
    })

    // ── Tauri mode (isTauri = true) ──────────────────────────

    it('returns external URLs directly in Tauri mode', () => {
      mockedIsTauri.mockReturnValue(true)
      const url = 'https://example.com/photo.jpg'
      expect(proxyImageUrl(url)).toBe(url)
    })

    it('returns HTTP URLs directly in Tauri mode', () => {
      mockedIsTauri.mockReturnValue(true)
      const url = 'http://images.example.com/cat.png'
      expect(proxyImageUrl(url)).toBe(url)
    })

    it('still returns local URLs unchanged in Tauri mode', () => {
      mockedIsTauri.mockReturnValue(true)
      expect(proxyImageUrl('/images/local.png')).toBe('/images/local.png')
    })

    it('still returns blob: URLs unchanged in Tauri mode', () => {
      mockedIsTauri.mockReturnValue(true)
      const blobUrl = 'blob:http://localhost/abc'
      expect(proxyImageUrl(blobUrl)).toBe(blobUrl)
    })

    it('still returns data: URLs unchanged in Tauri mode', () => {
      mockedIsTauri.mockReturnValue(true)
      const dataUrl = 'data:image/gif;base64,R0lGODlh...'
      expect(proxyImageUrl(dataUrl)).toBe(dataUrl)
    })
  })
})
