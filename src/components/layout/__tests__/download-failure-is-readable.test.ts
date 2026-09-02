/**
 * @vitest-environment jsdom
 *
 * A refused download says why.
 *
 * goonerforporn, Discord #bug-reports 2026-08-28: a CivitAI download that only
 * ever needed an API key ended in "a 400" and the download panel showed a Retry
 * button and nothing else. The reason came back from Rust, was written into the
 * store, and was rendered only into the `title` of a per-file row that a
 * single-file download never draws. So the one sentence that would have solved
 * it reached nobody.
 *
 * Run: npx vitest run src/components/layout/__tests__/download-failure-is-readable.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../../../hooks/useModels', () => ({
  useModels: () => ({ activePulls: {}, pullModel: vi.fn(), pausePull: vi.fn(), dismissPull: vi.fn() }),
}))
vi.mock(import('../../../api/mlx-image'), async (importOriginal) => ({
  ...(await importOriginal()),
  isMlxImageHost: () => false,
}))

import { DownloadBadge } from '../DownloadBadge'
import { useDownloadStore } from '../../../stores/downloadStore'

/** What Rust hands back for a CivitAI refusal, verbatim (download.rs). */
const CIVITAI_REFUSAL =
  'CivitAI refused this download (HTTP 401). Most CivitAI downloads need an API key. ' +
  'Add one under Settings > AI Backends > Model Storage, then start this download again.'

function seedFailure(error: string | undefined) {
  useDownloadStore.setState({
    downloads: {
      'pony.safetensors': {
        id: 'pony.safetensors',
        filename: 'pony.safetensors',
        progress: 0,
        total: 0,
        speed: 0,
        status: 'error',
        error,
      },
    },
    bundleMap: {},
  } as never)
}

function openPanel() {
  render(createElement(DownloadBadge))
  // The tray opens itself while something is actively downloading; the trigger
  // is queried by title because the badge count changes its accessible name.
  if (!screen.queryByText(/^Downloads/)) fireEvent.click(screen.getByTitle('Downloads'))
}

beforeEach(() => { seedFailure(undefined) })
afterEach(cleanup)

describe('a failed single-file download', () => {
  it('shows the reason as text, not only in a tooltip', () => {
    seedFailure(CIVITAI_REFUSAL)
    openPanel()
    // The whole sentence, including where to go.
    expect(screen.getByText(CIVITAI_REFUSAL)).toBeTruthy()
    expect(document.body.textContent).toContain('Settings > AI Backends > Model Storage')
  })

  // Negative control: a failure that carries no reason must not draw an empty
  // red line. The Retry way out stays either way.
  it('draws nothing extra when there is no reason to show', () => {
    seedFailure(undefined)
    openPanel()
    expect(document.body.textContent).not.toContain('CivitAI refused')
    expect(screen.getByText('Retry failed')).toBeTruthy()
  })

  // Negative control: a download that is merely running says nothing about a
  // failure.
  it('says nothing while the download is still going', () => {
    useDownloadStore.setState({
      downloads: {
        'pony.safetensors': {
          id: 'pony.safetensors', filename: 'pony.safetensors',
          progress: 10, total: 100, speed: 5, status: 'downloading',
        },
      },
      bundleMap: {},
    } as never)
    openPanel()
    expect(screen.queryByText('Retry failed')).toBeNull()
    expect(document.body.textContent).not.toContain('CivitAI refused')
  })
})
