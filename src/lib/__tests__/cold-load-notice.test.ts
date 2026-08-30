/**
 * R14 Nebenbefund 3 (2026-08-30, ergebnis-r14-nachmessung.md): straight after a
 * ComfyUI restart, a healthy GPU render sat in `Loading model...` from 0 s to
 * 57 s, about 117 s to the finished picture, and the waiting area explained
 * none of it. R13 measured 0 s to 7 s for the same phase on a warm ComfyUI, so
 * the difference is the cold start and not the card.
 *
 * The load phase was already distinguishable from sampling: ComfyUI's WS
 * `executing` events drive createStore's `loading-model`, `loading-clip` and
 * `loading-vae` against `sampling`, and useCreate has mapped them for a long
 * time. No new channel, just a line in the waiting area once the load has run
 * long enough to be worth a word.
 *
 * Run: npx vitest run src/lib/__tests__/cold-load-notice.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { coldLoadHint, COLD_LOAD_HINT, COLD_LOAD_HINT_AFTER_MS } from '../cold-load-notice'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

describe('coldLoadHint', () => {
  it('explains a load that has run long enough to worry someone', () => {
    expect(coldLoadHint(true, 57_000)).toBe(COLD_LOAD_HINT)
    expect(coldLoadHint(true, COLD_LOAD_HINT_AFTER_MS)).toBe(COLD_LOAD_HINT)
  })

  it('NEGATIVE: says nothing while the wait is still ordinary', () => {
    // R13's warm range, 0 s to 7 s. Nobody needs a paragraph for that.
    expect(coldLoadHint(true, 0)).toBe('')
    expect(coldLoadHint(true, 7_000)).toBe('')
    expect(coldLoadHint(true, COLD_LOAD_HINT_AFTER_MS - 1)).toBe('')
  })

  it('NEGATIVE: says nothing outside the load phase, however long it runs', () => {
    // Sampling for ten minutes is a slow render, not a cold start, and the
    // line would be a false explanation there.
    expect(coldLoadHint(false, 600_000)).toBe('')
    expect(coldLoadHint(false, 0)).toBe('')
    // A broken clock cannot talk us into it either.
    expect(coldLoadHint(true, Number.NaN)).toBe('')
  })

  it('is English, promises nothing it cannot know, and carries no dash', () => {
    expect(COLD_LOAD_HINT).toMatch(/^Loading the model into memory\.\.\.$/)
    // It must not claim to count jobs. LU has no such counter in this view,
    // so "this is the first job" would be an invention.
    expect(COLD_LOAD_HINT).not.toMatch(/this is the first/i)
    // en dash and em dash, written as escapes so this file carries neither.
    expect(COLD_LOAD_HINT).not.toMatch(/[\u2013\u2014]/)
  })

  it('NEGATIVE: makes no claim about which render waits longest', () => {
    // R16 Befund 2, measured on the Windows box (12 GB GPU, 16 GB RAM,
    // z_image_bf16 at 11.46 GB): ComfyUI dropped the model after EVERY render
    // (RAM 7.68 GB back to 672 MB), and all five runs sat 69 s to 75 s before
    // the first sampling step. "The first render after a ComfyUI start waits
    // the longest" was simply false there, and this line is shown on exactly
    // that machine. A line may only claim what holds whenever it is shown.
    expect(COLD_LOAD_HINT).not.toMatch(/longest|first render|slower|faster|only takes/i)
    // No comparison between runs at all: the waiting area sees one render.
    expect(COLD_LOAD_HINT).not.toMatch(/\bthan\b/i)
  })
})

describe('the Create tab waiting area', () => {
  it('times the load stretch and renders the line from the shared constant', () => {
    const view = read('src/components/create/experimental/OutputView.tsx')
    expect(view).toMatch(/import \{ coldLoadHint \} from '\.\.\/\.\.\/\.\.\/lib\/cold-load-notice'/)
    expect(view).toMatch(/const hint = coldLoadHint\(true, elapsedMs\)/)
    // Mounted only for the load stretch, which is where its clock comes from:
    // it starts with the phase and is discarded with it. The three loader
    // phases are one `isLoading`, so a checkpoint handing over to the text
    // encoder does not restart the count.
    expect(view).toMatch(/\{isLoading && !isMlxImageHost\(\) && <ColdLoadLine \/>\}/)
    expect(view).toMatch(/const isLoading = progressPhase === 'loading-model' \|\| progressPhase === 'loading-clip' \|\| progressPhase === 'loading-vae'/)
  })

  it('NEGATIVE: the line is not pasted into the component', () => {
    const view = read('src/components/create/experimental/OutputView.tsx')
    expect(view).not.toContain('Loading the model into memory')
  })

  it('NEGATIVE: the cloud and the Mac never see a sentence about ComfyUI', () => {
    // The Mac renders local media with MLX in the app's own process and has no
    // ComfyUI at all, so the line is gated off there.
    const view = read('src/components/create/experimental/OutputView.tsx')
    expect(view).toMatch(/!isMlxImageHost\(\)/)
    // A cloud job never enters a load phase: useCloudCreate only ever sets
    // queued, sampling and complete, so `isLoading` is false for all of them.
    const cloud = read('src/hooks/useCloudCreate.ts')
    expect(cloud).not.toMatch(/setProgressPhase\('loading-/)
  })
})
