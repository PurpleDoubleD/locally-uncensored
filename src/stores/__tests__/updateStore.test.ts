import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing the store
vi.mock('../../api/backend', () => ({
  openExternal: vi.fn(),
}))

// Mock package.json version
vi.mock('../../../package.json', () => ({
  version: '2.0.0',
}))

import { useUpdateStore } from '../updateStore'

// ── Helper to build a GitHub API response ─────────────────────

function makeGitHubRelease(tagName: string, opts: {
  body?: string
  assets?: { name: string; browser_download_url: string }[]
  html_url?: string
} = {}) {
  return {
    tag_name: tagName,
    html_url: opts.html_url || `https://github.com/purpledoubled/locally-uncensored/releases/tag/${tagName}`,
    body: opts.body ?? 'Release notes here',
    assets: opts.assets ?? [
      { name: 'locally-uncensored-setup.exe', browser_download_url: 'https://example.com/setup.exe' },
    ],
  }
}

// ═══════════════════════════════════════════════════════════════
//  updateStore
// ═══════════════════════════════════════════════════════════════

describe('updateStore', () => {
  beforeEach(() => {
    useUpdateStore.setState({
      currentVersion: '2.0.0',
      latestVersion: null,
      updateAvailable: false,
      downloadUrl: null,
      releaseUrl: null,
      releaseNotes: null,
      isChecking: false,
      lastChecked: null,
      dismissed: null,
    })
    vi.restoreAllMocks()
  })

  // ── isNewerVersion (via checkForUpdate behavior) ───────────
  // isNewerVersion is not exported, so we test it indirectly
  // through checkForUpdate's updateAvailable result.

  describe('version comparison (via checkForUpdate)', () => {
    it('detects newer major version: 3.0.0 > 2.0.0', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().updateAvailable).toBe(true)
      expect(useUpdateStore.getState().latestVersion).toBe('3.0.0')
    })

    it('detects newer minor version: 2.1.0 > 2.0.0', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v2.1.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().updateAvailable).toBe(true)
    })

    it('detects newer patch version: 2.0.1 > 2.0.0', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v2.0.1'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().updateAvailable).toBe(true)
    })

    it('same version = not available: 2.0.0 == 2.0.0', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v2.0.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().updateAvailable).toBe(false)
    })

    it('older version = not available: 1.9.9 < 2.0.0', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v1.9.9'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().updateAvailable).toBe(false)
    })

    it('handles minor rollover: 1.1.0 vs current 2.0.0 = not newer', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v1.1.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().updateAvailable).toBe(false)
    })

    it('strips v prefix from tag_name', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v2.5.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().latestVersion).toBe('2.5.0')
    })

    it('handles tag without v prefix', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('3.0.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().latestVersion).toBe('3.0.0')
      expect(useUpdateStore.getState().updateAvailable).toBe(true)
    })

    it('handles missing patch: 3.0 vs 2.0.0', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().updateAvailable).toBe(true)
    })
  })

  // ── checkForUpdate parsing ─────────────────────────────────

  describe('checkForUpdate', () => {
    it('parses download URL from .exe asset', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', {
          assets: [{ name: 'app-setup.exe', browser_download_url: 'https://dl.example.com/app.exe' }],
        }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().downloadUrl).toBe('https://dl.example.com/app.exe')
    })

    it('parses download URL from .msi asset', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', {
          assets: [{ name: 'app-setup.msi', browser_download_url: 'https://dl.example.com/app.msi' }],
        }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().downloadUrl).toBe('https://dl.example.com/app.msi')
    })

    it('sets downloadUrl to null when no matching asset', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', {
          assets: [{ name: 'app.tar.gz', browser_download_url: 'https://dl.example.com/app.tar.gz' }],
        }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().downloadUrl).toBeNull()
    })

    it('parses release URL', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', {
          html_url: 'https://github.com/purpledoubled/locally-uncensored/releases/tag/v3.0.0',
        }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().releaseUrl).toBe(
        'https://github.com/purpledoubled/locally-uncensored/releases/tag/v3.0.0'
      )
    })

    it('stores release notes', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', { body: 'Bug fixes and improvements' }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().releaseNotes).toBe('Bug fixes and improvements')
    })

    it('sets releaseNotes to null when body is empty', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', { body: '' }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().releaseNotes).toBeNull()
    })

    it('sets lastChecked timestamp', async () => {
      const before = Date.now()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().lastChecked).toBeGreaterThanOrEqual(before)
    })

    it('skips check if checked recently', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0'),
      } as Response)

      // First call goes through
      await useUpdateStore.getState().checkForUpdate()
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // Second call within interval is skipped
      await useUpdateStore.getState().checkForUpdate()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('does not skip if lastChecked is null', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('handles non-ok response gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 403,
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().isChecking).toBe(false)
      expect(useUpdateStore.getState().updateAvailable).toBe(false)
      expect(useUpdateStore.getState().lastChecked).not.toBeNull()
    })

    it('handles fetch error gracefully (offline)', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'))

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().isChecking).toBe(false)
      expect(useUpdateStore.getState().lastChecked).not.toBeNull()
    })

    it('does not run concurrently (isChecking guard)', async () => {
      let resolveFirst: (v: Response) => void
      const firstPromise = new Promise<Response>(r => { resolveFirst = r })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(firstPromise as Promise<Response>)

      // Start first check (will be pending)
      const p1 = useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().isChecking).toBe(true)

      // Second call should bail immediately
      const p2 = useUpdateStore.getState().checkForUpdate()

      // Resolve the first
      resolveFirst!({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0'),
      } as Response)

      await Promise.all([p1, p2])
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  // ── truncateNotes (tested indirectly) ──────────────────────

  describe('release notes truncation', () => {
    it('truncates notes longer than 300 chars', async () => {
      // 5 lines each long enough to exceed 300 chars total
      const longNotes = Array.from({ length: 5 }, (_, i) => `Line ${i}: ${'x'.repeat(80)}`).join('\n')
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', { body: longNotes }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      const notes = useUpdateStore.getState().releaseNotes!
      expect(notes.length).toBeLessThanOrEqual(303) // 300 + "..."
      expect(notes).toContain('...')
    })

    it('keeps short notes intact', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', { body: 'Short note' }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().releaseNotes).toBe('Short note')
    })

    it('filters blank lines from notes', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', { body: 'Line1\n\n\nLine2\n\nLine3' }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      const notes = useUpdateStore.getState().releaseNotes!
      expect(notes).toBe('Line1\nLine2\nLine3')
    })
  })

  // ── dismissUpdate / clearDismiss ───────────────────────────

  describe('dismissUpdate', () => {
    it('stores the latest version as dismissed', () => {
      useUpdateStore.setState({ latestVersion: '3.0.0' })
      useUpdateStore.getState().dismissUpdate()
      expect(useUpdateStore.getState().dismissed).toBe('3.0.0')
    })

    it('stores null if no latestVersion', () => {
      useUpdateStore.getState().dismissUpdate()
      expect(useUpdateStore.getState().dismissed).toBeNull()
    })
  })

  describe('clearDismiss', () => {
    it('clears the dismissed version', () => {
      useUpdateStore.setState({ dismissed: '3.0.0' })
      useUpdateStore.getState().clearDismiss()
      expect(useUpdateStore.getState().dismissed).toBeNull()
    })

    it('is idempotent when already null', () => {
      useUpdateStore.getState().clearDismiss()
      expect(useUpdateStore.getState().dismissed).toBeNull()
    })
  })
})
