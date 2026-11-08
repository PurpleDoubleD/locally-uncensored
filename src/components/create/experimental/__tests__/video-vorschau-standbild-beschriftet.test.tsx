// @vitest-environment jsdom
/**
 * C45 (3.1.0, Discord 05.11.): "the render preview shows only a still,
 * or nothing". ComfyUI decodes one frame of a video latent per sampling step,
 * never the motion, so a moving preview is not something it sends. The still
 * now says it is the first frame on purpose. And when the run asked for
 * previews but none comes while it samples (a ComfyUI older than December
 * 2025 ignores the request; not every model has a preview decoder), the
 * waiting area says so instead of staying blank.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/video-vorschau-standbild-beschriftet.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, cleanup } from '@testing-library/react'
import { GeneratingView } from '../OutputView'
import { useRenderPreviewStore } from '../../../../stores/renderPreviewStore'
import { useCreateStore } from '../../../../stores/createStore'

const phase = (p: string) => useCreateStore.setState({ progressPhase: p, progressText: '', progress: 40 } as never)

beforeEach(() => { useRenderPreviewStore.setState({ url: null, asked: false } as never); phase('sampling') })
afterEach(cleanup)

describe('C45: the video preview while it renders', () => {
  it('the still says it is the first frame, not the motion', () => {
    useRenderPreviewStore.setState({ url: 'data:image/jpeg;base64,/9j/', asked: true } as never)
    render(<GeneratingView />)
    const cap = screen.getByTestId('render-live-preview').textContent ?? ''
    expect(cap).toContain('Still of the first frame, not the motion')
    expect(cap).toContain('the video plays when it is done')
    expect(screen.queryByTestId('render-no-preview')).toBeNull()
  })

  it('asked for, sampling, and no picture: it says why', () => {
    useRenderPreviewStore.setState({ url: null, asked: true } as never)
    render(<GeneratingView />)
    expect(screen.getByTestId('render-no-preview').textContent).toContain('No preview picture for this run')
  })

  it('quiet while a model still loads, and on runs that never asked (pictures, Mac, cloud)', () => {
    useRenderPreviewStore.setState({ url: null, asked: true } as never)
    phase('loading-model')
    render(<GeneratingView />)
    expect(screen.queryByTestId('render-no-preview')).toBeNull()
    cleanup()
    useRenderPreviewStore.setState({ url: null, asked: false } as never)
    phase('sampling')
    render(<GeneratingView />)
    expect(screen.queryByTestId('render-no-preview')).toBeNull()
  })

  it('Create marks a video run as asking and clears it at the end', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', '..', '..', 'hooks', 'useCreate.ts'), 'utf8')
    expect(src).toMatch(/if \(livePreview\) \{\n\s+useRenderPreviewStore\.getState\(\)\.setUrl\(null\)\n\s+useRenderPreviewStore\.getState\(\)\.setAsked\(true\)/)
    expect(src).toMatch(/setUrl\(null\)\n\s+useRenderPreviewStore\.getState\(\)\.setAsked\(false\)/)
  })
})
