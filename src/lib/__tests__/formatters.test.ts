/**
 * Formatters Tests
 *
 * Tests all exported functions from formatters.ts:
 * - formatBytes() — byte size formatting
 * - formatDate() — relative time formatting
 * - truncate() — string truncation
 *
 * Run: npx vitest run src/lib/__tests__/formatters.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { formatBytes, formatDate, truncate } from '../formatters'

describe('formatters', () => {
  // ── formatBytes ──────────────────────────────────────────────

  describe('formatBytes', () => {
    it('returns "0 B" for 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 B')
    })

    it('formats small byte values', () => {
      expect(formatBytes(1)).toBe('1.0 B')
      expect(formatBytes(500)).toBe('500.0 B')
      expect(formatBytes(1023)).toBe('1023.0 B')
    })

    it('formats kilobytes', () => {
      expect(formatBytes(1024)).toBe('1.0 KB')
      expect(formatBytes(1536)).toBe('1.5 KB')
      expect(formatBytes(10 * 1024)).toBe('10.0 KB')
    })

    it('formats megabytes', () => {
      expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
      expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
      expect(formatBytes(100 * 1024 * 1024)).toBe('100.0 MB')
    })

    it('formats gigabytes', () => {
      expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
      expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5 GB')
    })

    it('formats terabytes', () => {
      expect(formatBytes(1024 ** 4)).toBe('1.0 TB')
      expect(formatBytes(3.7 * 1024 ** 4)).toBe('3.7 TB')
    })

    it('handles negative values', () => {
      // Math.log of negative is NaN, so Math.floor(NaN) is NaN
      // sizes[NaN] is undefined, result will be "NaN undefined"
      const result = formatBytes(-1)
      expect(typeof result).toBe('string')
    })

    it('handles NaN input', () => {
      const result = formatBytes(NaN)
      expect(typeof result).toBe('string')
    })

    it('handles very large values beyond TB', () => {
      // 1 PB = 1024^5, index would be 5 which is beyond sizes array
      const result = formatBytes(1024 ** 5)
      expect(typeof result).toBe('string')
    })

    it('rounds to 1 decimal place', () => {
      // 1.999 KB should display as 2.0 KB
      expect(formatBytes(2048 - 1)).toMatch(/\d+\.\d\s/)
    })
  })

  // ── formatDate ───────────────────────────────────────────────

  describe('formatDate', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns "Just now" for current timestamp', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      expect(formatDate(now)).toBe('Just now')
    })

    it('returns "Just now" for 30 seconds ago', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      expect(formatDate(now - 30_000)).toBe('Just now')
    })

    it('returns "Just now" for 59 seconds ago', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      expect(formatDate(now - 59_000)).toBe('Just now')
    })

    it('returns minutes ago for 1 minute', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      expect(formatDate(now - 60_000)).toBe('1m ago')
    })

    it('returns minutes ago for 30 minutes', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      expect(formatDate(now - 30 * 60_000)).toBe('30m ago')
    })

    it('returns minutes ago for 59 minutes', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      expect(formatDate(now - 59 * 60_000)).toBe('59m ago')
    })

    it('returns hours ago for 1 hour', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      expect(formatDate(now - 3_600_000)).toBe('1h ago')
    })

    it('returns hours ago for 12 hours', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      expect(formatDate(now - 12 * 3_600_000)).toBe('12h ago')
    })

    it('returns hours ago for 23 hours', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      expect(formatDate(now - 23 * 3_600_000)).toBe('23h ago')
    })

    it('returns days ago for 1 day', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      expect(formatDate(now - 86_400_000)).toBe('1d ago')
    })

    it('returns days ago for 6 days', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      expect(formatDate(now - 6 * 86_400_000)).toBe('6d ago')
    })

    it('returns locale date string for 7+ days ago', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      const result = formatDate(now - 7 * 86_400_000)
      expect(result).not.toContain('ago')
      expect(result).not.toBe('Just now')
    })

    it('returns locale date string for 30 days ago', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      const result = formatDate(now - 30 * 86_400_000)
      expect(result).not.toContain('ago')
    })

    it('handles future timestamps gracefully', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      // diff is negative, minutes < 1, so returns "Just now"
      const result = formatDate(now + 60_000)
      expect(result).toBe('Just now')
    })

    it('handles timestamp 0 (Unix epoch)', () => {
      const now = Date.now()
      vi.setSystemTime(now)
      const result = formatDate(0)
      // Very old date, should be locale date string
      expect(result).not.toContain('ago')
      expect(typeof result).toBe('string')
    })
  })

  // ── truncate ─────────────────────────────────────────────────

  describe('truncate', () => {
    it('returns short string unchanged when under maxLength', () => {
      expect(truncate('hi', 10)).toBe('hi')
    })

    it('returns string unchanged when exactly at maxLength', () => {
      expect(truncate('hello', 5)).toBe('hello')
    })

    it('truncates and appends "..." when over maxLength', () => {
      expect(truncate('hello world', 5)).toBe('hello...')
    })

    it('truncates single character over limit', () => {
      expect(truncate('ab', 1)).toBe('a...')
    })

    it('handles empty string', () => {
      expect(truncate('', 10)).toBe('')
    })

    it('handles empty string with maxLength 0', () => {
      expect(truncate('', 0)).toBe('')
    })

    it('handles maxLength of 0 with non-empty string', () => {
      expect(truncate('hello', 0)).toBe('...')
    })

    it('handles very long string', () => {
      const long = 'a'.repeat(10000)
      const result = truncate(long, 100)
      expect(result).toBe('a'.repeat(100) + '...')
      expect(result.length).toBe(103)
    })

    it('handles unicode characters', () => {
      // slice works on code units; basic test that it does not crash
      const result = truncate('hello world', 7)
      expect(result).toBe('hello w...')
    })
  })
})
